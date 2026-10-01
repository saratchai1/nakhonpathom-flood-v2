import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const FALLBACK_PATH = path.join(root, 'data', 'fallback.json');
const STATIONS_PATH = path.join(root, 'data', 'stations.json');

const BASE_URL = (process.env.WATER_SU_BASE_URL || 'https://water.su.ac.th').replace(/\/$/, '');
const EXPLICIT_DATA_URL = process.env.WATER_SU_DATA_URL || '';
const CACHE_MS = Number(process.env.WATER_SU_CACHE_MS || 60_000);
const FETCH_TIMEOUT_MS = Number(process.env.WATER_SU_FETCH_TIMEOUT_MS || 4_000);

let cached = null;
let cachedAt = 0;
let discoveredUrls = [];
let discoveredScripts = [];
let scriptHints = [];
let discoveryAt = 0;
let fallbackCache = null;
let stationCache = null;
let backgroundRefresh = null;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pick(obj, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(obj, name) && obj[name] !== '' && obj[name] !== null && obj[name] !== undefined) {
      return obj[name];
    }
  }
  return null;
}

export function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const deviceId = String(pick(row, ['device_id', 'deviceId', 'station_id', 'stationId', 'id', 'sensor_id']) || '').trim();
  if (!deviceId) return null;

  const rawTime = pick(row, ['timestamp', 'received_at', 'receivedAt', 'datetime', 'date_time', 'created_at', 'time']);
  const parsedTime = rawTime ? new Date(rawTime) : null;

  return {
    device_id: deviceId,
    timestamp: parsedTime && !Number.isNaN(parsedTime.getTime()) ? parsedTime.toISOString() : (rawTime ? String(rawTime) : null),
    sample_count: finite(pick(row, ['sample_count', 'sampleCount', 'samples'])),
    TotalRainFall: finite(pick(row, ['TotalRainFall', 'totalRainFall', 'rainfall', 'rain_mm', 'rain'])),
    water_msl_m: finite(pick(row, ['water_msl_m', 'waterMslM', 'water_msl', 'level_msl_m', 'level_msl'])),
    water_depth_m: finite(pick(row, ['water_depth_m', 'waterDepthM', 'water_depth', 'depth_m', 'water_level_m'])),
    freeboard_m: finite(pick(row, ['freeboard_m', 'freeboardM', 'freeboard', 'bank_freeboard_m']))
  };
}

export function parseCsv(text) {
  const rows = [];
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return rows;
  const headers = parseCsvLine(lines[0]);
  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((header, index) => { row[header] = values[index] ?? ''; });
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line) {
  const out = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(value);
      value = '';
    } else {
      value += ch;
    }
  }
  out.push(value);
  return out;
}

export function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const likelyKeys = ['data', 'rows', 'results', 'sensors', 'stations', 'water_data', 'waterData', 'records', 'items'];
  for (const key of likelyKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  for (const value of Object.values(payload)) {
    if (Array.isArray(value) && value.length && typeof value[0] === 'object') return value;
  }
  return [];
}

function latestByDevice(rows) {
  const byId = new Map();
  for (const raw of rows) {
    const row = normalizeRow(raw);
    if (!row) continue;
    const previous = byId.get(row.device_id);
    const currentTime = row.timestamp ? Date.parse(row.timestamp) : 0;
    const previousTime = previous?.timestamp ? Date.parse(previous.timestamp) : 0;
    if (!previous || currentTime >= previousTime) byId.set(row.device_id, row);
  }
  return [...byId.values()].sort((a, b) => a.device_id.localeCompare(b.device_id, undefined, { numeric: true }));
}

async function readFallback() {
  if (!fallbackCache) fallbackCache = JSON.parse(await fs.readFile(FALLBACK_PATH, 'utf8'));
  return fallbackCache;
}

export async function readStations() {
  if (!stationCache) stationCache = JSON.parse(await fs.readFile(STATIONS_PATH, 'utf8'));
  return stationCache;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'user-agent': 'NakhonPathomFloodDigitalTwin/0.1 (+public flood visualization)',
        'accept': 'application/json,text/csv,text/plain,text/html;q=0.8,*/*;q=0.5',
        ...(options.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function resolveUrl(url, base = BASE_URL) {
  try { return new URL(url, base).toString(); } catch { return null; }
}

function isCandidate(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return /(api|water|sensor|station|download|export|data|telemetry|level)/.test(lower)
    && !/\.(css|png|jpg|jpeg|svg|woff2?|ico)(\?|$)/.test(lower);
}

export function discoverCandidatesFromText(text, baseUrl = BASE_URL) {
  const found = new Set();
  const add = (value) => {
    const raw = String(value || '').trim();
    if (!raw || raw.startsWith('data:')) return;
    if (!(raw.includes('/') || /\.(?:json|csv|php)(?:[?#]|$)/i.test(raw))) return;
    const url = resolveUrl(raw, baseUrl);
    if (!url || !isCandidate(url)) return;
    try {
      const parsed = new URL(url);
      if (/^(?:unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)$/i.test(parsed.hostname)) return;
    } catch {}
    found.add(url);
  };

  const source = String(text || '');
  for (const match of source.matchAll(/fetch\s*\(\s*[`'"]([^`'"]+)[`'"]/g)) add(match[1]);
  for (const match of source.matchAll(/axios\.(?:get|post)\s*\(\s*[`'"]([^`'"]+)[`'"]/gi)) add(match[1]);
  for (const match of source.matchAll(/\$\.(?:get|getJSON|post)\s*\(\s*[`'"]([^`'"]+)[`'"]/gi)) add(match[1]);
  for (const match of source.matchAll(/(?:url|endpoint|apiUrl|dataUrl|downloadUrl)\s*[:=]\s*[`'"]([^`'"]+)[`'"]/gi)) add(match[1]);
  for (const match of source.matchAll(/[`'"]((?:https?:\/\/|\/|\.\/|\.\.\/)[^`'"]*(?:api|water|sensor|station|download|export|data|telemetry|level)[^`'"]*)[`'"]/gi)) add(match[1]);
  for (const match of source.matchAll(/[`'"]([^\s`'"]+\.(?:json|csv|php)(?:\?[^\s`'"]*)?)[`'"]/gi)) add(match[1]);
  return [...found];
}

async function discoverDataUrls() {
  if (discoveredUrls.length && Date.now() - discoveryAt < 30 * 60_000) return discoveredUrls;

  const explicit = new Set();
  const discovered = new Set();
  const common = new Set();

  if (EXPLICIT_DATA_URL) explicit.add(resolveUrl(EXPLICIT_DATA_URL));

  const commonPaths = [
    '/api/water-data', '/api/water_data', '/api/data', '/api/latest', '/api/latest-water',
    '/api/water/latest', '/api/sensors/latest', '/api/sensors', '/api/stations', '/api/download',
    '/data/latest.json', '/data/water_data.json', '/water_data.json', '/latest.json',
    '/get_data.php', '/api/get_data.php', '/data.php'
  ];
  commonPaths.forEach((item) => common.add(resolveUrl(item)));

  for (const page of ['/index.html', '/dashboard.html', '/water-comparison.html']) {
    const pageUrl = resolveUrl(page);
    try {
      const response = await fetchWithTimeout(pageUrl, { headers: { accept: 'text/html' } });
      if (!response.ok) continue;
      const html = await response.text();
      discoverCandidatesFromText(html, pageUrl).forEach((url) => discovered.add(url));
      const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
        .map((m) => resolveUrl(m[1], pageUrl))
        .filter(Boolean)
        .slice(0, 24);
      discoveredScripts = [...new Set([...discoveredScripts, ...scripts])].slice(0, 40);

      for (const scriptUrl of scripts) {
        try {
          const scriptResponse = await fetchWithTimeout(scriptUrl, { headers: { accept: 'text/javascript,*/*' } });
          if (!scriptResponse.ok) continue;
          const js = await scriptResponse.text();
          discoverCandidatesFromText(js, scriptUrl).forEach((url) => discovered.add(url));
          if (new URL(scriptUrl).hostname === new URL(BASE_URL).hostname) {
            const hints = js.split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => /(fetch\s*\(|axios|water[_-]?data|timeseries|download|export|\.csv|\.json|\.php|api\b|endpoint|supabase)/i.test(line))
              .map((line) => line.slice(0, 800));
            scriptHints = [...new Set([...scriptHints, ...hints])].slice(0, 80);
          }
        } catch {}
      }
    } catch {}
  }

  // Prioritize URLs actually discovered from the live site's HTML/JS.
  // Common guesses are only fallback candidates.
  discoveredUrls = [...new Set([
    ...explicit,
    ...discovered,
    ...common
  ].filter(Boolean))];

  discoveryAt = Date.now();
  return discoveredUrls;
}

async function decodeResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  if (!text.trim()) return [];
  if (contentType.includes('json') || /^[\[{]/.test(text.trim())) {
    try { return extractRows(JSON.parse(text)); } catch {}
  }
  if (contentType.includes('csv') || /device[_-]?id/i.test(text.split(/\r?\n/, 1)[0] || '')) return parseCsv(text);
  return [];
}

function queryVariants(url) {
  const out = [url];
  try {
    const base = new URL(url);
    const start = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);
    const end = new Date().toISOString().slice(0, 10);
    const variants = [
      { format: 'json' },
      { limit: '1000' },
      { start, end, format: 'json' },
      { start_date: start, end_date: end, format: 'json' }
    ];
    for (const params of variants) {
      const u = new URL(base);
      Object.entries(params).forEach(([key, value]) => u.searchParams.set(key, value));
      out.push(u.toString());
    }
  } catch {}
  return [...new Set(out)];
}

async function tryLive() {
  const urls = await discoverDataUrls();
  const attempts = [];
  let attemptCount = 0;
  for (const candidate of urls.slice(0, 24)) {
    for (const url of queryVariants(candidate).slice(0, 2)) {
      if (attemptCount >= 18) return { rows: [], sourceUrl: null, attempts };
      attemptCount += 1;
      try {
        const response = await fetchWithTimeout(url);
        attempts.push({ url, status: response.status });
        if (!response.ok) continue;
        const rows = await decodeResponse(response);
        const latest = latestByDevice(rows);
        const useful = latest.filter((row) => row.water_msl_m !== null || row.water_depth_m !== null || row.freeboard_m !== null);
        if (useful.length >= 3) return { rows: useful, sourceUrl: url, attempts };
      } catch (error) {
        attempts.push({ url, error: error?.name || 'fetch_error' });
      }
    }
  }
  return { rows: [], sourceUrl: null, attempts };
}

function enrich(rows, stations) {
  const stationById = new Map(stations.map((station) => [station.id, station]));
  return rows.map((row) => {
    const station = stationById.get(row.device_id) || {};
    const bankMsl = row.water_msl_m !== null && row.freeboard_m !== null ? row.water_msl_m + row.freeboard_m : null;
    const bankLocal = row.water_depth_m !== null && row.freeboard_m !== null ? row.water_depth_m + row.freeboard_m : null;
    const ratio = bankLocal && row.water_depth_m !== null ? (row.water_depth_m / bankLocal) * 100 : null;
    return {
      ...station,
      ...row,
      bank_msl_m: bankMsl,
      bank_local_m: bankLocal,
      fill_percent: ratio,
      status: row.freeboard_m === null ? 'unknown' : row.freeboard_m <= 0 ? 'critical' : row.freeboard_m <= 0.25 ? 'warning' : 'normal'
    };
  });
}

async function buildPayload(live, fallback, stations) {
  const useLive = live.rows.length >= 3;
  const rows = useLive ? live.rows : fallback.latest;
  return {
    mode: useLive ? 'live' : 'csv-fallback',
    source: useLive ? 'water.su.ac.th' : fallback.source,
    sourceUrl: useLive ? live.sourceUrl : null,
    generatedAt: new Date().toISOString(),
    fallbackRange: fallback.range,
    sensors: enrich(rows, stations),
    stationCount: stations.length,
    diagnostics: {
      liveRows: live.rows.length,
      discoveredCandidates: discoveredUrls.length,
      candidateUrls: discoveredUrls.slice(0, 24),
      scriptUrls: discoveredScripts.slice(0, 24),
      scriptHints: scriptHints.slice(0, 40),
      attempts: live.attempts.slice(-18)
    }
  };
}

function launchBackgroundRefresh(fallback, stations) {
  if (backgroundRefresh) return;
  backgroundRefresh = (async () => {
    try {
      const live = await tryLive();
      cached = await buildPayload(live, fallback, stations);
      cachedAt = Date.now();
    } catch {}
    finally { backgroundRefresh = null; }
  })();
}

export async function getLatestSensors({ force = false } = {}) {
  const [fallback, stations] = await Promise.all([readFallback(), readStations()]);
  const fresh = cached && Date.now() - cachedAt < CACHE_MS;
  if (fresh && !force) return cached;

  if (force) {
    let live = { rows: [], sourceUrl: null, attempts: [] };
    try { live = await tryLive(); } catch {}
    cached = await buildPayload(live, fallback, stations);
    cachedAt = Date.now();
    return cached;
  }

  if (!cached) {
    cached = await buildPayload({ rows: [], sourceUrl: null, attempts: [] }, fallback, stations);
    cachedAt = Date.now();
  }
  launchBackgroundRefresh(fallback, stations);
  return cached;
}

export function resetCacheForTests() {
  cached = null;
  cachedAt = 0;
  discoveredUrls = [];
  discoveredScripts = [];
  scriptHints = [];
  discoveryAt = 0;
  backgroundRefresh = null;
}
