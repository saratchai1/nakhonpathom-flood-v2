import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRow, parseCsv, discoverCandidatesFromText, extractRows } from '../src/water-su.js';

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


test('extractRows supports official latest-all response', () => {
  const rows = extractRows({
    success: true,
    data: {
      generated_at: '2026-10-01T10:01:52.149Z',
      stations: [{
        device_id: 'N12',
        station_name: 'วัดงิ้วราย',
        latitude: 13.809166,
        longitude: 100.219367,
        water_msl_m: 1.38,
        water_depth_m: 2.98,
        bank_level_msl_m: 1.2,
        local_height_m: 2.8,
        water_level_percent: 106.4,
        freeboard_m: -0.18,
        status: 'critical',
        received_at: '2026-10-01T09:59:34.727Z'
      }]
    }
  });
  assert.equal(rows.length, 1);
  const row = normalizeRow(rows[0]);
  assert.equal(row.device_id, 'N12');
  assert.equal(row.name, 'วัดงิ้วราย');
  assert.equal(row.lat, 13.809166);
  assert.equal(row.lng, 100.219367);
  assert.equal(row.bank_msl_m, 1.2);
  assert.equal(row.fill_percent, 106.4);
  assert.equal(row.status, 'critical');
});

test('normalizeRow flattens readings/latest nested data', () => {
  const row = normalizeRow({
    device_id: 'N1',
    location_th: 'วัดวังตะกู',
    received_at: '2026-10-01T09:59:59.596Z',
    bank_msl: '4.38',
    local_height: '2.50',
    data: {
      TotalRainFall: 0,
      water_depth_m: 0.859063,
      freeboard_m: 1.640937,
      water_msl_m: 2.739063,
      water_level_percent: 34.36
    }
  });
  assert.equal(row.device_id, 'N1');
  assert.equal(row.name, 'วัดวังตะกู');
  assert.equal(row.water_msl_m, 2.739063);
  assert.equal(row.TotalRainFall, 0);
  assert.equal(row.bank_msl_m, 4.38);
});
