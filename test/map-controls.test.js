import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { FLOOD_BANDS, buildFloodBands } from '../public/flood-bands.js';

const app = (await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '');
const fixture = [{ id: 's1', name: 'Station', lat: 13.805, lng: 100.075,
  water_msl_m: 11, bank_msl_m: 12, freeboard_m: 1, water_depth_m: 2, bank_local_m: 3,
  TotalRainFall: 4, fill_percent: 66, status: 'normal' }];

function harness({ webgl = true, elevation = 10 } = {}) {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      const n = { dataset: {}, style: {}, attrs: {}, handlers: {}, checked: true,
        textContent: '', innerHTML: '', disabled: false,
        classList: { add: (x) => classes.add(x), remove: (x) => classes.delete(x),
          contains: (x) => classes.has(x), toggle: (x, v) => {
            const on = v === undefined ? !classes.has(x) : v;
            on ? classes.add(x) : classes.delete(x); return on;
          } },
        setAttribute: (k, v) => { n.attrs[k] = v; },
        addEventListener: (e, fn) => { n.handlers[e] = fn; }
      };
      nodes.set(id, n);
    }
    return nodes.get(id);
  }
  const baseButtons = ['map', 'satellite', 'contour'].map((mode) => {
    const n = node(mode); n.dataset.basemap = mode; return n;
  });
  const cameraButtons = ['left', 'right', 'up', 'down', 'north'].map((action) => {
    const n = node(action); n.dataset.camera = action; return n;
  });
  const events = {}; const once = {}; const layers = new Map(); const sources = new Map();
  layers.set('background', { id: 'background' });
  layers.set('roads', { id: 'roads', layout: { visibility: 'visible' } });
  const queries = [];
  const m = {
    bearing: -7, pitch: 55, zoom: 10.35, center: { lng: 100.075, lat: 13.805 },
    on: (e, fn) => { if (typeof fn === 'function') events[e] = fn; },
    once: (e, fn) => { once[e] = fn; }, addControl() {},
    getStyle: () => ({ layers: [...layers.values()], sources: Object.fromEntries(sources) }),
    addSource: (id, src) => sources.set(id, { ...src, setData(data) { this.data = data; } }),
    getSource: (id) => sources.get(id), getLayer: (id) => layers.get(id),
    addLayer: (layer) => layers.set(layer.id, layer),
    setLayoutProperty: (id, key, val) => { const l = layers.get(id); l.layout ??= {}; l.layout[key] = val; },
    setPaintProperty: (id, key, val) => { const l = layers.get(id); l.paint ??= {}; l.paint[key] = val; },
    setTerrain: (terrain) => { m.terrain = terrain; },
    getCenter: () => m.center, getZoom: () => m.zoom,
    getBearing: () => m.bearing, getPitch: () => m.pitch, stop() {},
    easeTo: (camera) => {
      m.lastCamera = camera;
      if (camera.bearing !== undefined) m.bearing = camera.bearing;
      if (camera.pitch !== undefined) m.pitch = camera.pitch;
      if (camera.center) m.center = camera.center;
      if (camera.zoom !== undefined) m.zoom = camera.zoom;
    }, areTilesLoaded: () => true,
    queryTerrainElevation: (coord, options) => { queries.push(options); return elevation; }
  };
  let contourValues;
  const context = vm.createContext({
    document: { getElementById: node, createElement: () => ({ getContext: () => webgl ? { getExtension: () => null } : null }),
      addEventListener() {}, querySelectorAll: (selector) => selector === '[data-basemap]' ? baseButtons : selector === '[data-camera]' ? cameraButtons : [] },
    maplibregl: { Map: function() { return m; }, NavigationControl: function() {}, ScaleControl: function() {} },
    fetch: async (url) => ({ ok: true, json: async () => url.startsWith('/api/') ? { mode: 'live', sensors: fixture } : { features: [] } }),
    setTimeout() {}, setInterval() {}, requestAnimationFrame: (fn) => fn(),
    d3Contours: () => { const f = (values) => { contourValues = values.slice(); return [{ value: 1, coordinates: [[[[0, 0], [10, 0], [10, 10], [0, 0]]]] }]; }; f.size = () => f; f.thresholds = () => f; return f; },
    FLOOD_BANDS, buildFloodBands, turf: {}, Intl, Date, Math, Number, String, console
  });
  vm.runInContext(app, context);
  return { context, m, node, events, layers, sources, queries, get contourValues() { return contourValues; },
    run: (code) => vm.runInContext(code, context), load: async () => { await events.load(); } };
}

for (const mode of ['map', 'satellite', 'contour']) {
  test(`${mode}: basemap preserves camera, selection, overlays, terrain and numerical values`, async () => {
    const h = harness(); await h.load();
    h.run("state.selectedId = 's1'; selectStation('s1', false)");
    h.node('contour-toggle').handlers.change({ target: { checked: false } });
    const snapshot = h.run('JSON.stringify({ sensors: state.sensors, contour: state.contourData, selected: state.selectedId })');
    const camera = JSON.stringify([h.m.center, h.m.zoom, h.m.pitch, h.m.bearing]);
    h.run(`state.basemap = '${mode}'; applyBasemap()`);
    assert.equal(h.layers.get('flood-fill').layout.visibility, 'none');
    assert.ok(h.layers.has('sensor-points'));
    assert.ok(h.sources.has('sensors'));
    assert.equal(h.m.terrain.exaggeration, 10);
    assert.equal(JSON.stringify([h.m.center, h.m.zoom, h.m.pitch, h.m.bearing]), camera);
    assert.equal(h.run('JSON.stringify({ sensors: state.sensors, contour: state.contourData, selected: state.selectedId })'), snapshot);
    for (const raster of ['satellite', 'contour']) assert.equal(h.layers.get(`base-${raster}`).layout.visibility, mode === raster ? 'visible' : 'none');
    assert.equal(h.layers.get('roads').layout.visibility, mode === 'map' ? 'visible' : 'none');
  });
}

test('1x and 10x produce identical actual-elevation flood depths and sensor details', async () => {
  const h = harness(); await h.load();
  h.run("selectStation('s1', false)");
  const details = ['detail-msl', 'detail-depth', 'detail-freeboard', 'detail-bank-msl'].map((id) => h.node(id).textContent);
  await h.run('rebuildFloodModel()');
  const high = JSON.stringify(h.contourValues);
  h.node('relief-btn').handlers.click();
  assert.equal(h.m.terrain.exaggeration, 1);
  await h.run('rebuildFloodModel()');
  assert.equal(JSON.stringify(h.contourValues), high);
  h.node('relief-btn').handlers.click();
  assert.equal(h.m.terrain.exaggeration, 10);
  assert.ok(h.queries.length > 0);
  assert.ok(h.queries.every((q) => q.exaggerated === false));
  assert.deepEqual(['detail-msl', 'detail-depth', 'detail-freeboard', 'detail-bank-msl'].map((id) => h.node(id).textContent), details);
});

test('missing DEM never becomes elevation zero or a successful flood model', async () => {
  const h = harness({ elevation: null }); await h.load();
  await h.run('rebuildFloodModel()');
  assert.equal(h.run('state.modelReady'), false);
  assert.equal(h.run('state.contourData.features.length'), 0);
  assert.match(h.node('model-status').textContent, /DEM tiles/);
});

for (const mode of ['map', 'satellite', 'contour']) {
  test(`${mode}: manual camera steps, pitch clamp and north preserve center/zoom/exaggeration`, async () => {
    const h = harness(); await h.load();
    h.run(`state.basemap = '${mode}'; applyBasemap()`);
    const center = JSON.stringify(h.m.center); const zoom = h.m.zoom;
    h.node('left').handlers.click(); assert.equal(h.m.bearing, -22);
    h.node('right').handlers.click(); assert.equal(h.m.bearing, -7);
    h.node('up').handlers.click(); assert.equal(h.m.pitch, 65);
    for (let i = 0; i < 20; i++) h.node('up').handlers.click();
    assert.equal(h.m.pitch, 75);
    for (let i = 0; i < 20; i++) h.node('down').handlers.click();
    assert.equal(h.m.pitch, 0);
    h.node('north').handlers.click(); assert.equal(h.m.bearing, 0);
    assert.equal(JSON.stringify(h.m.center), center); assert.equal(h.m.zoom, zoom);
    assert.equal(h.m.terrain.exaggeration, 10);
    assert.equal(h.run('state.rotating3d'), undefined);
  });
}

test('no WebGL shows an actionable message and still fetches live sensors', async () => {
  const h = harness({ webgl: false });
  await h.run('refreshSensors()');
  assert.equal(h.run('state.mode'), 'live');
  assert.equal(h.run('state.sensors.length'), 1);
  assert.match(h.node('map-status').textContent, /WebGL/);
  assert.equal(h.node('map').dataset.renderer, 'unavailable');
});
