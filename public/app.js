import { contours as d3Contours } from 'https://cdn.jsdelivr.net/npm/d3-contour@4.0.2/+esm';
import * as turf from 'https://cdn.jsdelivr.net/npm/@turf/turf@7.4.0/+esm';
import { FLOOD_BANDS, buildFloodBands } from './flood-bands.js?v=20261001-depth-heatmap';

const MAP_BOUNDS = [99.86, 13.62, 100.29, 13.96];
const FLOOD_THRESHOLDS = FLOOD_BANDS.map((band) => band.min);
const REFRESH_MS = 60_000;
const TERRAIN_EXAGGERATION_NORMAL = 1;
const TERRAIN_EXAGGERATION_HIGH = 10;

const state = {
  sensors: [],
  selectedId: null,
  mode: 'loading',
  boundary: null,
  contourData: featureCollection([]),
  modelReady: false,
  modelRunning: false,
  terrainEnabled: true,
  terrainExaggeration: TERRAIN_EXAGGERATION_HIGH,
  boundaryEnabled: true,
  basemap: 'map',
  baseLayers: [],
  mapReady: false
};

const el = (id) => document.getElementById(id);
const fmt = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';

// Sensor data must still load when this browser cannot render WebGL.
let map = null;
function initializeMap() {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) throw new Error('WebGL unavailable');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    map = new maplibregl.Map({
      container: 'map',
      style: 'https://tiles.openfreemap.org/styles/bright',
      center: [100.075, 13.805], zoom: 10.35, pitch: 55, bearing: -7,
      maxPitch: 75, dragRotate: true, touchPitch: true, antialias: true, hash: false
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-right');
    map.on('error', (event) => {
      el('map-status').textContent = `โหลดแผนที่ไม่สำเร็จ: ${event.error?.message || 'ตรวจการเชื่อมต่อ'}`;
      el('map-status').classList.remove('is-hidden');
    });
    map.on('load', async () => {
      state.baseLayers = map.getStyle().layers.map((layer) => ({
        id: layer.id, visibility: layer.layout?.visibility || 'visible'
      }));
      addBasemaps();
      addTerrain();
      addProvinceBoundary();
      addFloodLayers();
      addSensorLayers();
      tryAdd3DBuildings();
      state.mapReady = true;
      el('map').dataset.renderer = 'webgl';
      setMapControlsEnabled(true);
      updateSensorSource();
      applyBasemap();
      updateCameraReadout();
      map.on('move', updateCameraReadout);
      map.on('idle', () => {
        el('map').dataset.tilesLoaded = String(map.areTilesLoaded());
      });
      await refreshSensors();
      // Sample only after the currently visible DEM tiles have settled.
      if (map.areTilesLoaded()) await rebuildFloodModel();
      else map.once('idle', () => rebuildFloodModel());
    });
  } catch {
    map = null;
    el('map-status').textContent = 'แผนที่ 3D ใช้ WebGL ซึ่ง browser นี้ไม่รองรับ กรุณาเปิดด้วย browser ที่รองรับ WebGL — ข้อมูลสถานียังดูได้ตามปกติ';
    el('map-status').classList.remove('is-hidden');
    el('map').dataset.renderer = 'unavailable';
    el('model-status').textContent = 'คำนวณ contour ไม่ได้: WebGL ไม่พร้อม';
  }
}

function setMapControlsEnabled(enabled) {
  document.querySelectorAll('[data-map-control]').forEach((button) => { button.disabled = !enabled; });
  el('contour-toggle').disabled = !enabled;
}

function addBasemaps() {
  const before = state.baseLayers[0]?.id;
  // Public noncommercial map display; see docs/BASEMAP_SOURCES.md for terms.
  map.addSource('base-satellite', {
    type: 'raster', tileSize: 256, maxzoom: 19,
    tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Imagery © Esri, Vantor, Earthstar Geographics, GIS User Community · <a href="https://www.esri.com/en-us/legal/terms/web-site-service" target="_blank" rel="noopener">Esri terms</a>'
  });
  map.addSource('base-contour', {
    type: 'raster', tileSize: 256, maxzoom: 17,
    tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'],
    attribution: 'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM · Map style © <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA</a>)'
  });
  for (const mode of ['satellite', 'contour']) {
    map.addLayer({ id: `base-${mode}`, type: 'raster', source: `base-${mode}`,
      layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0 } }, before);
  }
}

function applyBasemap() {
  if (!map || !state.mapReady) return;
  for (const layer of state.baseLayers) {
    map.setLayoutProperty(layer.id, 'visibility', state.basemap === 'map' ? layer.visibility : 'none');
  }
  for (const mode of ['satellite', 'contour']) {
    map.setLayoutProperty(`base-${mode}`, 'visibility', state.basemap === mode ? 'visible' : 'none');
  }
  document.querySelectorAll('[data-basemap]').forEach((button) => {
    const active = button.dataset.basemap === state.basemap;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const names = { map: 'แผนที่', satellite: 'ดาวเทียม', contour: 'Contour' };
  el('basemap-btn').textContent = `ชั้นแผนที่ · ${names[state.basemap]}`;
  el('map').dataset.basemap = state.basemap;
  el('map').dataset.tilesLoaded = 'false';
  el('map-status').classList.add('is-hidden');
  // No setStyle, camera changes, overlay mutations or model recomputation here.
}

function updateCameraReadout() {
  if (!map) return;
  el('camera-readout').textContent = `ทิศ ${Math.round(map.getBearing())}° · เงย ${Math.round(map.getPitch())}°`;
}

function adjustCamera(action) {
  if (!map || !state.mapReady) return;
  map.stop();
  const camera = { center: map.getCenter(), zoom: map.getZoom(), duration: 200 };
  if (action === 'left') camera.bearing = map.getBearing() - 15;
  if (action === 'right') camera.bearing = map.getBearing() + 15;
  if (action === 'up') camera.pitch = Math.min(75, map.getPitch() + 10);
  if (action === 'down') camera.pitch = Math.max(0, map.getPitch() - 10);
  if (action === 'north') camera.bearing = 0;
  map.easeTo(camera);
}

function featureCollection(features) {
  return { type: 'FeatureCollection', features };
}

function addTerrain() {
  if (!map.getSource('terrain-dem')) {
    map.addSource('terrain-dem', {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      tileSize: 256,
      encoding: 'terrarium',
      maxzoom: 14
    });
  }
  if (!map.getLayer('terrain-hillshade')) {
    map.addLayer({
      id: 'terrain-hillshade',
      type: 'hillshade',
      source: 'terrain-dem',
      paint: {
        'hillshade-exaggeration': 0.62,
        'hillshade-shadow-color': '#50657b',
        'hillshade-highlight-color': '#ffffff'
      }
    });
  }
  state.terrainEnabled = true;
  state.terrainExaggeration = TERRAIN_EXAGGERATION_HIGH;
  applyTerrainView();
}

function applyTerrainView() {
  if (!map.getSource('terrain-dem')) return;

  if (state.terrainEnabled) {
    map.setTerrain({ source: 'terrain-dem', exaggeration: state.terrainExaggeration });
    if (map.getLayer('terrain-hillshade')) {
      map.setLayoutProperty('terrain-hillshade', 'visibility', 'visible');
      map.setPaintProperty(
        'terrain-hillshade',
        'hillshade-exaggeration',
        state.terrainExaggeration === TERRAIN_EXAGGERATION_HIGH ? 0.62 : 0.28
      );
    }
  } else {
    map.setTerrain(null);
    if (map.getLayer('terrain-hillshade')) map.setLayoutProperty('terrain-hillshade', 'visibility', 'none');
  }

  el('map').dataset.exaggeration = String(state.terrainExaggeration);
  el('map').dataset.terrainEnabled = String(state.terrainEnabled);
  const terrainButton = el('terrain-btn');
  if (terrainButton) {
    terrainButton.classList.toggle('is-active', state.terrainEnabled);
    terrainButton.setAttribute('aria-pressed', String(state.terrainEnabled));
  }

  const reliefButton = el('relief-btn');
  if (reliefButton) {
    const isHigh = state.terrainExaggeration === TERRAIN_EXAGGERATION_HIGH;
    reliefButton.textContent = `ความสูง ×${isHigh ? 10 : 1}`;
    reliefButton.classList.toggle('is-active', isHigh && state.terrainEnabled);
    reliefButton.setAttribute(
      'aria-pressed',
      String(isHigh && state.terrainEnabled)
    );
  }

  const reliefBadge = el('relief-badge');
  if (reliefBadge) {
    reliefBadge.textContent = state.terrainEnabled
      ? `Vertical exaggeration ×${state.terrainExaggeration}`
      : 'ปิดภูมิประเทศ 3D';
  }
}

async function addProvinceBoundary() {
  const sources = [
    'https://raw.githubusercontent.com/chingchai/OpenGISData-Thailand/master/provinces.geojson',
    'https://raw.githubusercontent.com/knottx/opengisdata-thailand/master/provinces.geojson'
  ];
  for (const url of sources) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const geo = await response.json();
      const feature = (geo.features || []).find((f) => Object.values(f.properties || {}).some((v) => /นครปฐม|Nakhon\s*Pathom/i.test(String(v))));
      if (!feature) continue;
      state.boundary = feature;
      if (!map.getSource('province-boundary')) map.addSource('province-boundary', { type: 'geojson', data: feature });
      if (!map.getLayer('province-boundary-fill')) map.addLayer({
        id: 'province-boundary-fill', type: 'fill', source: 'province-boundary',
        paint: { 'fill-color': '#0f766e', 'fill-opacity': 0.025 }
      });
      if (!map.getLayer('province-boundary-line')) map.addLayer({
        id: 'province-boundary-line', type: 'line', source: 'province-boundary',
        paint: { 'line-color': '#0b1e30', 'line-width': 2.2, 'line-opacity': 0.78 }
      });
      return;
    } catch {}
  }
}

function addSensorLayers() {
  map.addSource('sensors', { type: 'geojson', data: featureCollection([]) });
  map.addLayer({
    id: 'sensor-halo', type: 'circle', source: 'sensors',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 10, 13, 16],
      'circle-color': '#ffffff', 'circle-opacity': 0.88
    }
  });
  map.addLayer({
    id: 'sensor-points', type: 'circle', source: 'sensors',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 6.5, 13, 10],
      'circle-color': ['match', ['get', 'status'], 'critical', '#dc2626', 'warning', '#e58a1f', 'normal', '#14857b', '#94a3b8'],
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5
    }
  });
  map.addLayer({
    id: 'sensor-labels', type: 'symbol', source: 'sensors', minzoom: 11,
    layout: {
      'text-field': ['concat', ['get', 'id'], ' · ', ['get', 'name']],
      'text-size': 10, 'text-offset': [0, 1.55], 'text-anchor': 'top', 'text-allow-overlap': false
    },
    paint: { 'text-color': '#142536', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 }
  });

  map.on('mouseenter', 'sensor-points', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'sensor-points', () => { map.getCanvas().style.cursor = ''; });
  map.on('click', 'sensor-points', (event) => {
    const feature = event.features?.[0];
    if (feature?.properties?.id) selectStation(feature.properties.id, true);
  });
}

function addFloodLayers() {
  map.addSource('flood-contours', { type: 'geojson', data: state.contourData });
  map.addLayer({
    id: 'flood-fill', type: 'fill', source: 'flood-contours',
    paint: {
      'fill-color': ['get', 'color'],
      'fill-opacity': ['get', 'opacity'],
      'fill-antialias': false
    }
  });
  map.addLayer({
    id: 'flood-line', type: 'line', source: 'flood-contours',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.3, 13, 0.8],
      'line-opacity': 0.45
    }
  });
}

function tryAdd3DBuildings() {
  const style = map.getStyle();
  const vectorSource = Object.entries(style.sources || {}).find(([, source]) => source.type === 'vector')?.[0];
  if (!vectorSource) return;
  if (map.getLayer('3d-buildings')) return;
  try {
    map.addLayer({
      id: '3d-buildings', type: 'fill-extrusion', source: vectorSource, 'source-layer': 'building', minzoom: 14,
      paint: {
        'fill-extrusion-color': '#d8e0e7',
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 5],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
        'fill-extrusion-opacity': 0.72
      }
    });
  } catch {}
}

async function refreshSensors(force = false) {
  el('refresh-btn').disabled = true;
  try {
    const response = await fetch(`/api/sensors${force ? '?force=1' : ''}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.sensors = (payload.sensors || []).filter((s) => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)));
    state.mode = payload.mode;
    updateSensorSource();
    renderStatus(payload);
    renderOverview();
    renderStationTable();
    if (state.selectedId) selectStation(state.selectedId, false);
  } catch (error) {
    el('source-mode').textContent = 'โหลดข้อมูลไม่สำเร็จ';
    el('last-updated').textContent = error.message;
    el('live-dot').className = 'live-dot';
  } finally {
    el('refresh-btn').disabled = false;
  }
}

function updateSensorSource() {
  const features = state.sensors.map((sensor) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(sensor.lng), Number(sensor.lat)] },
    properties: { ...sensor, id: sensor.id || sensor.device_id, name: sensor.name || sensor.device_id }
  }));
  map?.getSource('sensors')?.setData(featureCollection(features));
}

function renderStatus(payload) {
  const live = payload.mode === 'live';
  const dot = el('live-dot');
  dot.className = `live-dot ${live ? 'live' : 'fallback'}`;
  el('source-mode').textContent = live ? 'LIVE · water.su.ac.th' : 'CSV fallback · รอ live endpoint';
  const newest = state.sensors.map((s) => Date.parse(s.timestamp || 0)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  el('last-updated').textContent = newest ? `ข้อมูลล่าสุด ${formatThaiTime(newest)}` : `ประมวลผล ${formatThaiTime(Date.now())}`;
}

function renderOverview() {
  const critical = state.sensors.filter((s) => s.status === 'critical');
  const warning = state.sensors.filter((s) => s.status === 'warning');
  const known = state.sensors.filter((s) => Number.isFinite(Number(s.freeboard_m))).sort((a, b) => Number(a.freeboard_m) - Number(b.freeboard_m));
  const closest = known[0];

  el('metric-critical').textContent = critical.length;
  el('metric-warning').textContent = warning.length;
  el('metric-min-freeboard').textContent = closest ? `${fmt(closest.freeboard_m)} ม.` : '—';
  el('metric-min-station').textContent = closest ? `${closest.id || closest.device_id} · ${closest.name || ''}` : '—';
  el('station-count').textContent = `${state.sensors.length} สถานี`;

  const priority = [...known].slice(0, 6);
  el('priority-list').innerHTML = priority.map((s) => `
    <div class="priority-item" data-station="${escapeHtml(s.id || s.device_id)}">
      <i class="status-dot ${escapeHtml(s.status || 'unknown')}"></i>
      <div class="priority-main"><div class="priority-name">${escapeHtml(s.name || s.device_id)}</div><div class="priority-meta">${escapeHtml(s.id || s.device_id)} · ${escapeHtml(s.group || 'สถานีตรวจวัด')} · ${escapeHtml(trendText(s.trend, s.change_1h_m))}</div></div>
      <div class="priority-value"><strong>${fmt(s.freeboard_m)} ม.</strong><span>ต่ำกว่าตลิ่ง</span></div>
    </div>`).join('');
  document.querySelectorAll('[data-station]').forEach((node) => node.addEventListener('click', () => selectStation(node.dataset.station, true)));
}

function renderStationTable() {
  const rows = [...state.sensors].sort((a, b) => numeric(a.freeboard_m, 999) - numeric(b.freeboard_m, 999));
  el('station-table').innerHTML = rows.map((s) => `
    <tr data-table-station="${escapeHtml(s.id || s.device_id)}">
      <td><strong>${escapeHtml(s.name || s.device_id)}</strong><br><small>${escapeHtml(s.id || s.device_id)} · ${escapeHtml(s.group || '')}</small></td>
      <td>${fmt(s.water_msl_m)}</td><td>${fmt(s.bank_msl_m)}</td><td>${fmt(s.freeboard_m)}</td>
      <td class="change-cell ${changeClass(s.change_1h_m)}">${formatChange(s.change_1h_m)}</td>
      <td>${escapeHtml(trendText(s.trend, s.change_1h_m))}</td>
      <td><span class="status-pill ${escapeHtml(s.status || 'unknown')}">${statusText(s.status)}</span></td>
    </tr>`).join('');
  document.querySelectorAll('[data-table-station]').forEach((node) => node.addEventListener('click', () => selectStation(node.dataset.tableStation, true)));
}

function selectStation(id, fly) {
  const sensor = state.sensors.find((s) => (s.id || s.device_id) === id);
  if (!sensor) return;
  state.selectedId = id;
  el('detail-panel').classList.remove('is-hidden');
  el('detail-name').textContent = sensor.name || sensor.device_id;
  el('detail-id').textContent = sensor.id || sensor.device_id;
  el('detail-msl').textContent = fmt(sensor.water_msl_m);
  el('detail-bank-msl').textContent = fmt(sensor.bank_msl_m);
  el('detail-depth').textContent = fmt(sensor.water_depth_m);
  el('detail-bank-local').textContent = fmt(sensor.bank_local_m);
  el('detail-rain').textContent = fmt(sensor.TotalRainFall);
  el('detail-freeboard').textContent = fmt(sensor.freeboard_m);
  el('detail-change').textContent = formatChange(sensor.change_1h_m, false);
  el('detail-trend').textContent = trendText(sensor.trend, sensor.change_1h_m);
  el('detail-time').textContent = sensor.timestamp ? `${sensor.is_stale ? 'ข้อมูลอาจล่าช้า · ' : 'ข้อมูลสถานี · '}${formatThaiTime(Date.parse(sensor.timestamp))}` : 'ไม่พบเวลาล่าสุด';

  const percent = Math.max(0, Math.min(120, numeric(sensor.fill_percent, 0)));
  const visiblePercent = Math.min(percent, 100);
  el('gauge-fill').style.height = `${visiblePercent}%`;
  el('gauge-fill').style.background = statusColor(sensor.status);
  el('gauge-percent').textContent = Number.isFinite(Number(sensor.fill_percent)) ? `${Number(sensor.fill_percent).toFixed(2)}%` : '—';
  el('gauge-percent').style.color = statusColor(sensor.status);
  el('gauge-status').textContent = statusText(sensor.status);
  el('gauge-status').style.color = statusColor(sensor.status);

  const alert = el('detail-alert');
  alert.className = `detail-alert ${sensor.status || ''}`;
  alert.textContent = sensor.status === 'critical'
    ? `สูงกว่าตลิ่ง ${fmt(Math.abs(Number(sensor.freeboard_m)))} ม.`
    : sensor.status === 'warning'
      ? `เหลือ freeboard เพียง ${fmt(sensor.freeboard_m)} ม.`
      : `ต่ำกว่าตลิ่ง ${fmt(sensor.freeboard_m)} ม.`;

  if (fly && map && state.mapReady) {
    map.flyTo({ center: [Number(sensor.lng), Number(sensor.lat)], zoom: Math.max(map.getZoom(), 12.2), pitch: 52, duration: 900 });
  }
}

async function rebuildFloodModel() {
  if (!map || !state.mapReady || !state.terrainEnabled || state.modelRunning || !state.sensors.length || !map.getSource('terrain-dem')) return;
  state.modelRunning = true;
  el('rebuild-model').disabled = true;
  el('model-status').textContent = 'กำลังอ่าน DEM… 0%';

  try {
    const bbox = modelBbox();
    const nx = 84;
    const ny = 68;
    const values = new Array(nx * ny).fill(NaN);
    let terrainSamples = 0;

    for (let y = 0; y < ny; y += 1) {
      const lat = bbox[1] + (y / (ny - 1)) * (bbox[3] - bbox[1]);
      for (let x = 0; x < nx; x += 1) {
        const lng = bbox[0] + (x / (nx - 1)) * (bbox[2] - bbox[0]);
        if (state.boundary && !safePointInBoundary([lng, lat], state.boundary)) continue;
        let elevation = null;
        try { elevation = map.queryTerrainElevation([lng, lat], { exaggerated: false }); } catch {}
        if (elevation === null || elevation === undefined || !Number.isFinite(Number(elevation))) continue;
        terrainSamples += 1;
        const water = interpolateWaterSurface(lng, lat);
        if (!water || water.nearestKm > 14 || water.confidence < 0.10) continue;
        const depth = Math.max(0, Math.min(3.0, water.level - Number(elevation)));
        values[y * nx + x] = depth;
      }
      if (y % 4 === 0) {
        el('model-status').textContent = `กำลังอ่าน DEM… ${Math.round((y / (ny - 1)) * 75)}%`;
        await nextFrame();
      }
    }

    if (terrainSamples < nx * ny * 0.08) {
      throw new Error('DEM tiles ยังโหลดไม่พอ ลองซูม/รอสักครู่แล้วคำนวณใหม่');
    }

    el('model-status').textContent = 'กำลังสร้าง heatmap ความลึก… 85%';
    await nextFrame();
    const raw = d3Contours().size([nx, ny]).thresholds(FLOOD_THRESHOLDS)(values);
    state.contourData = buildFloodBands(raw, bbox, nx, ny, turf.difference);
    map.getSource('flood-contours')?.setData(state.contourData);
    state.modelReady = true;
    el('model-status').textContent = `พร้อม · ${terrainSamples.toLocaleString('th-TH')} DEM samples`;
  } catch (error) {
    el('model-status').textContent = error.message || 'คำนวณไม่สำเร็จ';
  } finally {
    state.modelRunning = false;
    el('rebuild-model').disabled = false;
  }
}

function interpolateWaterSurface(lng, lat) {
  const candidates = state.sensors
    .filter((s) => Number.isFinite(Number(s.water_msl_m)) && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)))
    .map((s) => ({ sensor: s, d: haversineKm(lat, lng, Number(s.lat), Number(s.lng)) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 6);
  if (!candidates.length) return null;
  if (candidates[0].d < 0.15) return { level: Number(candidates[0].sensor.water_msl_m), nearestKm: candidates[0].d, confidence: 1 };

  let weighted = 0;
  let weights = 0;
  for (const item of candidates) {
    const distance = Math.max(item.d, 0.15);
    const localBank = Number(item.sensor.bank_msl_m);
    const freeboard = Number(item.sensor.freeboard_m);
    const reliability = Number.isFinite(freeboard) ? 1 : 0.7;
    const w = reliability / Math.pow(distance, 2.2);
    weighted += Number(item.sensor.water_msl_m) * w;
    weights += w;
    if (Number.isFinite(localBank)) {
      // Bank datum keeps the interpolation from being dominated by one high-elevation upstream station.
      const bankBiasWeight = 0.03 / Math.pow(distance + 1, 1.5);
      weighted += (localBank - Math.max(0.1, numeric(item.sensor.freeboard_m, 0.5))) * bankBiasWeight;
      weights += bankBiasWeight;
    }
  }
  const nearestKm = candidates[0].d;
  return { level: weighted / weights, nearestKm, confidence: Math.exp(-nearestKm / 7.5) };
}

function modelBbox() {
  if (state.boundary) {
    try {
      const b = turf.bbox(state.boundary);
      // Sensors are concentrated in the central/southern monitored corridor; limit expensive DEM sampling to their envelope plus buffer.
      const monitored = turf.bbox(featureCollection(state.sensors.map((s) => turf.point([Number(s.lng), Number(s.lat)]))));
      return [Math.max(b[0], monitored[0] - 0.045), Math.max(b[1], monitored[1] - 0.045), Math.min(b[2], monitored[2] + 0.045), Math.min(b[3], monitored[3] + 0.045)];
    } catch {}
  }
  return MAP_BOUNDS;
}

function safePointInBoundary(coord, boundary) {
  try { return turf.booleanPointInPolygon(turf.point(coord), boundary); } catch { return true; }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fitStations() {
  const coords = state.sensors.map((s) => [Number(s.lng), Number(s.lat)]).filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
  if (!map || !state.mapReady || !coords.length) return;
  const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  map.fitBounds(bounds, { padding: { top: 80, bottom: 80, left: 80, right: 380 }, duration: 900, maxZoom: 12 });
}

function setView(view) {
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));
  el('overview-panel').classList.toggle('is-hidden', view !== 'overview');
  el('canals-panel').classList.toggle('is-hidden', view !== 'canals');
}

function numeric(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatChange(value, includeUnit = true) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(3)}${includeUnit ? ' ม.' : ''}`;
}

function changeClass(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) < 0.005) return 'steady';
  return n > 0 ? 'rising' : 'falling';
}

function trendText(trend, change) {
  const key = String(trend || '').toLowerCase();
  if (['rising', 'rise', 'up', 'increasing'].includes(key)) return '↑ เพิ่มขึ้น';
  if (['falling', 'fall', 'down', 'decreasing'].includes(key)) return '↓ ลดลง';
  if (['steady', 'stable'].includes(key)) return '→ ทรงตัว';
  const n = Number(change);
  if (!Number.isFinite(n) || Math.abs(n) < 0.005) return '→ ทรงตัว';
  return n > 0 ? '↑ เพิ่มขึ้น' : '↓ ลดลง';
}

function statusText(status) {
  return status === 'critical' ? 'วิกฤต' : status === 'warning' ? 'เฝ้าระวัง' : status === 'normal' ? 'ปกติ' : 'ข้อมูลล่าช้า';
}

function statusColor(status) {
  return status === 'critical' ? '#dc2626' : status === 'warning' ? '#e58a1f' : '#14857b';
}

function formatThaiTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(ms));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
el('refresh-btn').addEventListener('click', () => refreshSensors(true));
el('rebuild-model').addEventListener('click', rebuildFloodModel);
el('close-detail').addEventListener('click', () => { state.selectedId = null; el('detail-panel').classList.add('is-hidden'); });
el('fit-stations').addEventListener('click', fitStations);
el('collapse-overview').addEventListener('click', () => el('overview-panel').classList.toggle('compact'));

el('contour-toggle').addEventListener('change', (event) => {
  const visible = event.target.checked ? 'visible' : 'none';
  if (map.getLayer('flood-fill')) map.setLayoutProperty('flood-fill', 'visibility', visible);
  if (map.getLayer('flood-line')) map.setLayoutProperty('flood-line', 'visibility', visible);
});

document.querySelectorAll('[data-camera]').forEach((button) => {
  button.addEventListener('click', () => adjustCamera(button.dataset.camera));
});
el('basemap-btn').addEventListener('click', () => {
  const open = el('basemap-menu').classList.contains('is-hidden');
  el('basemap-menu').classList.toggle('is-hidden', !open);
  el('basemap-btn').setAttribute('aria-expanded', String(open));
});
document.querySelectorAll('[data-basemap]').forEach((button) => {
  button.addEventListener('click', () => {
    state.basemap = button.dataset.basemap;
    applyBasemap();
    el('basemap-menu').classList.add('is-hidden');
    el('basemap-btn').setAttribute('aria-expanded', 'false');
  });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    el('basemap-menu').classList.add('is-hidden');
    el('basemap-btn').setAttribute('aria-expanded', 'false');
  }
});

el('terrain-btn').addEventListener('click', () => {
  state.terrainEnabled = !state.terrainEnabled;
  applyTerrainView();
});

el('relief-btn').addEventListener('click', () => {
  state.terrainEnabled = true;
  state.terrainExaggeration = state.terrainExaggeration === TERRAIN_EXAGGERATION_HIGH
    ? TERRAIN_EXAGGERATION_NORMAL
    : TERRAIN_EXAGGERATION_HIGH;
  applyTerrainView();

});

el('boundary-btn').addEventListener('click', () => {
  state.boundaryEnabled = !state.boundaryEnabled;
  ['province-boundary-fill', 'province-boundary-line'].forEach((layer) => {
    if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', state.boundaryEnabled ? 'visible' : 'none');
  });
  el('boundary-btn').classList.toggle('is-active', state.boundaryEnabled);
  el('boundary-btn').setAttribute('aria-pressed', String(state.boundaryEnabled));
});

el('flood-legend').innerHTML = FLOOD_BANDS.map((band) =>
  `<span><i style="background:${band.color}"></i>${band.label}</span>`).join('');
setMapControlsEnabled(false);
initializeMap();
refreshSensors();
setInterval(() => refreshSensors(false), REFRESH_MS);
