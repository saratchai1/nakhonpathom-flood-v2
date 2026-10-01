import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const FALLBACK_PATH = path.join(root, 'data', 'fallback.json');
const STATIONS_PATH = path.join(root, 'data', 'stations.json');

const BASE_URL = (process.env.WATER_SU_BASE_URL || 'https://water.su.ac.th').replace(/\/$/, '');
const OFFICIAL_LATEST_URL = `${BASE_URL}/api/v1/water/latest-all`;
const OFFICIAL_READINGS_URL = `${BASE_URL}/api/v1/readings/latest`;
const EXPLICIT_DATA_URL = process.env.WATER_SU_DATA_URL || OFFICIAL_LATEST_URL;
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
  const nested = row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
  const merged = { ...row, ...nested };

  const deviceId = String(pick(merged, ['device_id', 'deviceId', 'station_id', 'stationId', 'id', 'sensor_id']) || '').trim();
  if (!deviceId) return null;

  const rawTime = pick(merged, ['timestamp', 'received_at', 'receivedAt', 'datetime', 'date_time', 'created_at', 'time']);
  const parsedTime = rawTime ? new Date(rawTime) : null;

  const statusRaw = String(pick(merged, ['status']) || '').toLowerCase();
  const normalizedStatus = ['critical', 'warning', 'normal'].includes(statusRaw) ? statusRaw : null;

  return {
    device_id: deviceId,
    name: pick(merged, ['station_name', 'location_th', 'stationName', 'name']),
    lat: finite(pick(merged, ['latitude', 'lat'])),
    lng: finite(pick(merged, ['longitude', 'lng', 'lon'])),
    timestamp: parsedTime && !Number.isNaN(parsedTime.getTime()) ? parsedTime.toISOString() : (rawTime ? String(rawTime) : null),
    sample_count: finite(pick(merged, ['sample_count', 'sampleCount', 'samples'])),
    TotalRainFall: finite(pick(merged, ['TotalRainFall', 'totalRainFall', 'rainfall', 'rain_mm', 'rain'])),
    water_msl_m: finite(pick(merged, ['water_msl_m', 'waterMslM', 'water_msl', 'level_msl_m', 'level_msl'])),
    water_depth_m: finite(pick(merged, ['water_depth_m', 'waterDepthM', 'water_depth', 'depth_m', 'water_level_m'])),
    freeboard_m: finite(pick(merged, ['freeboard_m', 'freeboardM', 'freeboard', 'bank_freeboard_m'])),
    bank_msl_m: finite(pick(merged, ['bank_level_msl_m', 'bank_msl_m', 'bank_msl'])),
    bank_local_m: finite(pick(merged, ['local_height_m', 'bank_local_m', 'local_height'])),
    fill_percent: finite(pick(merged, ['water_level_percent', 'fill_percent'])),
    status: normalizedStatus,
    is_stale: Boolean(pick(merged, ['is_stale', 'stale'])),
    change_1h_m: finite(pick(merged, ['change_1h_m', 'change1h_m'])),
    rate_m_per_hour: finite(pick(merged, ['rate_m_per_hour', 'rate'])),
    trend: pick(merged, ['trend'])
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

export function extractRows(payload, depth = 0) {
  if (depth > 4) return [];
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const likelyKeys = ['stations', 'data', 'rows', 'results', 'sensors', 'water_data', 'waterData', 'records', 'items'];
  for (const key of likelyKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  for (const key of likelyKeys) {
    if (payload[key] && typeof payload[key] === 'object') {
      const nested = extractRows(payload[key], depth + 1);
      if (nested.length) return nested;
    }
  }

  for (const value of Object.values(payload)) {
    if (Array.isArray(value) && value.length && typeof value[0] === 'object') return value;
    if (value && typeof value === 'object') {
      const nested = extractRows(value, depth + 1);
      if (nested.length) return nested;
    }
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
  const baseHost = new URL(BASE_URL).hostname;

  if (EXPLICIT_DATA_URL) explicit.add(resolveUrl(EXPLICIT_DATA_URL));

  const commonPaths = [
    '/api/water-data', '/api/water_data', '/api/data', '/api/latest', '/api/latest-water',
    '/api/water/latest', '/api/sensors/latest', '/api/sensors', '/api/stations', '/api/download',
    '/data/latest.json', '/data/water_data.json', '/water_data.json', '/latest.json',
    '/get_data.php', '/api/get_data.php', '/data.php'
  ];
  commonPaths.forEach((item) => common.add(resolveUrl(item)));

  const scriptQueue = [];
  const queuedScripts = new Set();
  const enqueueScript = (value, base) => {
    const url = resolveUrl(value, base);
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== baseHost) return;
      if (!/\.m?js(?:\?|$)/i.test(parsed.pathname + parsed.search)) return;
    } catch { return; }
    if (!queuedScripts.has(url)) {
      queuedScripts.add(url);
      scriptQueue.push(url);
    }
  };

  for (const page of ['/index.html', '/dashboard.html', '/water-comparison.html']) {
    const pageUrl = resolveUrl(page);
    try {
      const response = await fetchWithTimeout(pageUrl, { headers: { accept: 'text/html' } });
      if (!response.ok) continue;
      const html = await response.text();

      discoverCandidatesFromText(html, pageUrl)
        .filter((url) => {
          try {
            const parsed = new URL(url);
            return parsed.hostname === baseHost && !/\/src\//.test(parsed.pathname);
          } catch { return false; }
        })
        .forEach((url) => discovered.add(url));

      for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
        enqueueScript(match[1], pageUrl);
      }
    } catch {}
  }

  for (let i = 0; i < scriptQueue.length && i < 48; i += 1) {
    const scriptUrl = scriptQueue[i];
    discoveredScripts = [...new Set([...discoveredScripts, scriptUrl])].slice(0, 60);
    try {
      const scriptResponse = await fetchWithTimeout(scriptUrl, { headers: { accept: 'text/javascript,*/*' } });
      if (!scriptResponse.ok) continue;
      const js = await scriptResponse.text();

      discoverCandidatesFromText(js, scriptUrl)
        .filter((url) => {
          try {
            const parsed = new URL(url);
            return parsed.hostname === baseHost && !/\/src\/.*\.js$/i.test(parsed.pathname);
          } catch { return false; }
        })
        .forEach((url) => discovered.add(url));

      const importRegex = /(?:import\s+(?:[^'"]+?\s+from\s+)?|export\s+[^'"]+?\s+from\s+)["']([^"']+)["']/g;
      for (const match of js.matchAll(importRegex)) enqueueScript(match[1], scriptUrl);
      for (const match of js.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) enqueueScript(match[1], scriptUrl);

      const hints = js.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /(fetch\s*\(|axios|water[_-]?data|timeseries|download|export|\.csv|\.json|\.php|api\b|endpoint|supabase|baseurl|serviceurl)/i.test(line))
        .map((line) => `[${new URL(scriptUrl).pathname}] ${line.slice(0, 700)}`);
      scriptHints = [...new Set([...scriptHints, ...hints])].slice(0, 120);
    } catch {}
  }

  // Prefer actual endpoints discovered by recursively reading the site's own ES modules.
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

async function tryLiveCandidate(candidate, attempts) {
  for (const url of queryVariants(candidate).slice(0, 2)) {
    try {
      const response = await fetchWithTimeout(url);
      attempts.push({ url, status: response.status });
      if (!response.ok) continue;

      const rows = await decodeResponse(response);
      let useful = latestByDevice(rows).filter((row) =>
        row.water_msl_m !== null || row.water_depth_m !== null || row.freeboard_m !== null
      );

      if (useful.length < 3) continue;

      if (candidate.includes('/api/v1/water/latest-all')) {
        try {
          const rainfallResponse = await fetchWithTimeout(OFFICIAL_READINGS_URL);
          if (rainfallResponse.ok) {
            const rainfallRows = latestByDevice(await decodeResponse(rainfallResponse));
            const rainfallById = new Map(rainfallRows.map((row) => [row.device_id, row]));
            useful = useful.map((row) => {
              const extra = rainfallById.get(row.device_id);
              return {
                ...row,
                TotalRainFall: extra?.TotalRainFall ?? row.TotalRainFall
              };
            });
          }
        } catch {}
      }

      return { rows: useful, sourceUrl: candidate, attempts };
    } catch (error) {
      attempts.push({ url, error: error?.name || 'fetch_error' });
    }
  }
  return null;
}

async function tryLive() {
  const attempts = [];

  // Fast path: use the verified official endpoint immediately. Discovery is only
  // a recovery path if the public API changes in the future.
  const directCandidates = [...new Set([
    resolveUrl(EXPLICIT_DATA_URL),
    OFFICIAL_LATEST_URL
  ].filter(Boolean))];

  for (const candidate of directCandidates) {
    const result = await tryLiveCandidate(candidate, attempts);
    if (result) return result;
  }

  const discovered = await discoverDataUrls();
  const fallbackCandidates = discovered
    .filter((candidate) => !directCandidates.includes(candidate))
    .slice(0, 22);

  for (const candidate of fallbackCandidates) {
    if (attempts.length >= 24) break;
    const result = await tryLiveCandidate(candidate, attempts);
    if (result) return result;
  }

  return { rows: [], sourceUrl: null, attempts };
}

function enrich(rows, stations) {
  const stationById = new Map(stations.map((station) => [station.id, station]));
  return rows.map((row) => {
    const station = stationById.get(row.device_id) || {};
    const bankMsl = row.bank_msl_m ?? (
      row.water_msl_m !== null && row.freeboard_m !== null ? row.water_msl_m + row.freeboard_m : null
    );
    const bankLocal = row.bank_local_m ?? (
      row.water_depth_m !== null && row.freeboard_m !== null ? row.water_depth_m + row.freeboard_m : null
    );
    const ratio = row.fill_percent ?? (
      bankLocal && row.water_depth_m !== null ? (row.water_depth_m / bankLocal) * 100 : null
    );
    const computedStatus = row.freeboard_m === null
      ? 'unknown'
      : row.freeboard_m <= 0
        ? 'critical'
        : row.freeboard_m <= 0.25
          ? 'warning'
          : 'normal';
    const status = row.is_stale ? 'unknown' : (row.status || computedStatus);

    return {
      ...station,
      ...row,
      id: row.device_id,
      name: row.name || station.name || row.device_id,
      lat: row.lat ?? station.lat ?? null,
      lng: row.lng ?? station.lng ?? null,
      bank_msl_m: bankMsl,
      bank_local_m: bankLocal,
      fill_percent: ratio,
      status
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
