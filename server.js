import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLatestSensors, readStations } from './src/water-su.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || 3000);
const startupProbeEnabled = process.env.WATER_SU_STARTUP_PROBE !== '0';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(JSON.stringify(body));
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(publicDir, relative);
  if (!filePath.startsWith(publicDir)) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'content-type': mime[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    res.end(data);
  } catch {
    try {
      const index = await fs.readFile(path.join(publicDir, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(index);
    } catch {
      json(res, 404, { error: 'not_found' });
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, service: 'nakhonpathom-flood-v2', now: new Date().toISOString() });
    }
    if (url.pathname === '/api/stations') {
      return json(res, 200, { stations: await readStations() });
    }
    if (url.pathname === '/api/sensors') {
      const force = url.searchParams.get('force') === '1';
      return json(res, 200, await getLatestSensors({ force }));
    }
    if (url.pathname === '/api/diagnostics') {
      const payload = await getLatestSensors({ force: url.searchParams.get('force') === '1' });
      return json(res, 200, {
        mode: payload.mode,
        source: payload.source,
        sourceUrl: payload.sourceUrl,
        generatedAt: payload.generatedAt,
        fallbackRange: payload.fallbackRange,
        diagnostics: payload.diagnostics
      });
    }
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: 'internal_error' });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Nakhon Pathom Flood Digital Twin listening on :${port}`);

  if (startupProbeEnabled) {
    setTimeout(async () => {
      try {
        const payload = await getLatestSensors({ force: true });
        console.log(JSON.stringify({
          event: 'water_su_startup_probe',
          mode: payload.mode,
          source: payload.source,
          sourceUrl: payload.sourceUrl,
          sensorCount: payload.sensors?.length || 0,
          liveRows: payload.diagnostics?.liveRows || 0,
          discoveredCandidates: payload.diagnostics?.discoveredCandidates || 0,
          candidateUrls: payload.diagnostics?.candidateUrls || [],
          scriptUrls: payload.diagnostics?.scriptUrls || [],
          attempts: payload.diagnostics?.attempts || []
        }));
      } catch (error) {
        console.error(JSON.stringify({
          event: 'water_su_startup_probe_error',
          error: error?.message || String(error)
        }));
      }
    }, 750);
  }
});
