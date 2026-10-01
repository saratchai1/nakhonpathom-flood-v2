import test from 'node:test';
import assert from 'node:assert/strict';
import { contours } from 'd3-contour';
import { difference } from '@turf/difference';
import { area } from '@turf/area';
import { FLOOD_BANDS, buildFloodBands } from '../public/flood-bands.js';

const bbox = [100, 13.7, 100.02, 13.72];
const collection = (features) => ({ type: 'FeatureCollection', features });

test('real D3/Turf geometry has no overlapping depth fills and preserves total extent', () => {
  const nx = 30, ny = 30;
  const depths = Array.from({ length: nx * ny }, (_, i) => {
    const r = Math.hypot(i % nx - 14.5, Math.floor(i / nx) - 14.5);
    return Math.max(0, 2.3 - r * 0.17);
  });
  const unchanged = depths.slice();
  const raw = contours().size([nx, ny]).thresholds(FLOOD_BANDS.map((b) => b.min))(depths);
  const original = structuredClone(raw);
  const bands = buildFloodBands(raw, bbox, nx, ny, difference);
  assert.equal(bands.features.length, 6);
  const footprint = buildFloodBands([raw[0]], bbox, nx, ny, difference).features[0];
  const totalArea = bands.features.reduce((sum, f) => sum + area(f), 0);
  assert.ok(Math.abs(totalArea - area(footprint)) < area(footprint) * 1e-6);
  for (let i = 0; i < bands.features.length; i++) {
    const a = bands.features[i];
    const scale = FLOOD_BANDS[i];
    assert.equal(a.properties.depth, scale.min);
    assert.equal(a.properties.depth_max, scale.max);
    assert.equal(a.properties.color, scale.color);
    assert.equal(a.properties.opacity, scale.opacity);
    for (let j = i + 1; j < bands.features.length; j++) {
      const remaining = difference(collection([a, bands.features[j]]));
      const overlapArea = area(a) - (remaining ? area(remaining) : 0);
      assert.ok(Math.abs(overlapArea) < area(footprint) * 1e-6, `bands ${i}/${j} overlap`);
    }
  }
  assert.deepEqual(depths, unchanged);
  assert.deepEqual(raw, original);
});

test('dry/under-5cm and unknown grids produce no heatmap fill', () => {
  for (const value of [0, 0.049, NaN]) {
    const raw = contours().size([5, 5]).thresholds(FLOOD_BANDS.map((b) => b.min))(Array(25).fill(value));
    assert.equal(buildFloodBands(raw, bbox, 5, 5, difference).features.length, 0);
  }
});

test('uniform deep water is one purple band instead of six stacked fills', () => {
  const raw = contours().size([5, 5]).thresholds(FLOOD_BANDS.map((b) => b.min))(Array(25).fill(2));
  const bands = buildFloodBands(raw, bbox, 5, 5, difference);
  assert.equal(bands.features.length, 1);
  assert.equal(bands.features[0].properties.depth, 1.5);
  assert.equal(bands.features[0].properties.color, '#7e22ce');
});

test('geometry failure is surfaced instead of falling back to cumulative alpha stacking', () => {
  const raw = contours().size([5, 5]).thresholds(FLOOD_BANDS.map((b) => b.min))(Array(25).fill(2));
  assert.throws(() => buildFloodBands(raw, bbox, 5, 5, () => { throw new Error('clip failed'); }), /clip failed/);
});
