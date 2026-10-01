// One display scale for the legend, fills and popup; metres are never exaggerated.
export const FLOOD_BANDS = Object.freeze([
  { min: 0.05, max: 0.15, color: '#c9f0ff', opacity: 0.22, label: '0.05–0.15 ม.' },
  { min: 0.15, max: 0.30, color: '#7dd3fc', opacity: 0.32, label: '0.15–0.30 ม.' },
  { min: 0.30, max: 0.50, color: '#38bdf8', opacity: 0.42, label: '0.30–0.50 ม.' },
  { min: 0.50, max: 1.00, color: '#2563eb', opacity: 0.50, label: '0.50–1.00 ม.' },
  { min: 1.00, max: 1.50, color: '#4f46e5', opacity: 0.56, label: '1.00–1.50 ม.' },
  { min: 1.50, max: null, color: '#7e22ce', opacity: 0.64, label: '≥1.50 ม.' }
]);

/** D3 returns cumulative polygons (depth >= threshold). Remove the next polygon
 * from each one so every location receives exactly one fill, not stacked alpha.
 * Do not fall back to overlapping geometry if polygon subtraction fails.
 */
export function buildFloodBands(contours, bbox, nx, ny, difference) {
  const cumulative = contours.map((contour) => ({
    type: 'Feature', properties: { depth: Number(contour.value) },
    geometry: {
      type: 'MultiPolygon',
      coordinates: contour.coordinates.map((polygon) => polygon.map((ring) => ring.map(([x, y]) => [
        bbox[0] + (x / (nx - 1)) * (bbox[2] - bbox[0]),
        bbox[1] + (y / (ny - 1)) * (bbox[3] - bbox[1])
      ])))
    }
  })).sort((a, b) => a.properties.depth - b.properties.depth);

  const features = [];
  for (let i = 0; i < cumulative.length; i += 1) {
    const current = cumulative[i];
    if (!current.geometry.coordinates.length) continue;
    const next = cumulative.slice(i + 1).find((feature) => feature.geometry.coordinates.length);
    const band = FLOOD_BANDS.find((entry) => entry.min === current.properties.depth);
    if (!band) throw new Error(`Unknown flood-depth band: ${current.properties.depth}`);
    const result = next ? difference({ type: 'FeatureCollection', features: [current, next] }) : current;
    if (!result?.geometry?.coordinates?.length) continue;
    features.push({ ...result, properties: {
      depth: band.min, depth_max: band.max, depth_label: band.label,
      color: band.color, opacity: band.opacity
    } });
  }
  return { type: 'FeatureCollection', features };
}
