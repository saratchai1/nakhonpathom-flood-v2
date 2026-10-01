import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRow, parseCsv, discoverCandidatesFromText } from '../src/water-su.js';

test('normalizeRow maps water.su style fields', () => {
  const row = normalizeRow({
    device_id: 'N5',
    received_at: '2026-10-01T15:30:00+07:00',
    TotalRainFall: '8.10',
    water_msl_m: '1.17',
    water_depth_m: '0.57',
    freeboard_m: '0.53'
  });
  assert.equal(row.device_id, 'N5');
  assert.equal(row.TotalRainFall, 8.1);
  assert.equal(row.water_msl_m, 1.17);
  assert.equal(row.freeboard_m, 0.53);
});

test('parseCsv supports quoted cells', () => {
  const rows = parseCsv('device_id,received_at,water_msl_m\nN1,"2026-10-01T15:30:00+07:00",2.5\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].device_id, 'N1');
  assert.equal(rows[0].water_msl_m, '2.5');
});

test('discoverCandidatesFromText resolves fetch endpoints', () => {
  const urls = discoverCandidatesFromText("fetch('/api/water/latest?format=json'); const dataUrl = './data/current.json';", 'https://water.su.ac.th/js/app.js');
  assert.ok(urls.includes('https://water.su.ac.th/api/water/latest?format=json'));
  assert.ok(urls.some((url) => url.includes('/js/data/current.json')));
});
