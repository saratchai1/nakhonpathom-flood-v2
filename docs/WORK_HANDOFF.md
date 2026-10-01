# WORK HANDOFF — Nakhon Pathom Flood Digital Twin v2

Repository: `saratchai1/nakhonpathom-flood-v2`  
Branch: `main`  
Baseline commit at handoff: `4e821bee718fbe9eeae082f6bc99ed45e2228b28`  
Live URL: https://nakhonpathom-flood-v2.onrender.com

## Objective

Continue implementation and browser QA in ChatGPT Work. The current app already has:

- MapLibre 3D map
- realtime data from `https://water.su.ac.th/api/v1/water/latest-all`
- rainfall supplement from `https://water.su.ac.th/api/v1/readings/latest`
- 13 realtime stations
- DEM terrain from Terrarium
- flood contour screening model
- current visual terrain exaggeration toggle 1x / 5x
- current 3D auto-rotation button
- Render deployment from `main`

Do not change the hydraulic calculations merely to make the visualization more dramatic. Visual exaggeration and model values must stay separate.

---

# User changes requested

## 1. Change terrain exaggeration from 5x to 10x

Default visual vertical exaggeration must be:

```
10x
```

Requirements:

- UI toggle should be `ความสูง ×1 / ×10`
- default should be `×10`
- badge should clearly say `Vertical exaggeration ×10`
- this is VISUAL ONLY
- DEM values used in calculations must remain actual elevation
- flood-depth calculation must continue to call terrain elevation with:
  `queryTerrainElevation(..., { exaggerated: false })`
- realtime water level, freeboard, bank level, flood depth and exported values must NOT be multiplied by 10

Acceptance:
- terrain difference is clearly visible on the flat Nakhon Pathom landscape
- switching to 1x returns to near-real vertical relief
- switching back to 10x does not alter sensor/model numeric values

---

## 2. Add basemap selector: Satellite / Map / Contour

User wants behavior similar to Google Maps layer selection.

Provide a compact basemap control with at least:

```
แผนที่
ดาวเทียม
ภูมิประเทศ / Contour
```

Implementation rules:

- Keep MapLibre and existing custom overlays.
- Prefer changing/toggling BASE layers without destroying:
  - sensor layers
  - province boundary
  - flood contour
  - DEM terrain
  - custom UI state
- Avoid `map.setStyle(...)` if it causes custom layers/sources to disappear or require fragile rehydration.
- A safer design is dedicated base raster/vector sources/layers underneath overlays, then toggle visibility.
- Satellite imagery must use a source that is legally usable in this public app and include required attribution.
- Contour/terrain basemap should make terrain structure readable, with labels where practical.
- The visual `×10` terrain exaggeration must work in all three basemap modes.
- Flood overlay visibility must remain independent from basemap selection.

Desired UX:
- one compact layer button
- popover or segmented menu:
  - แผนที่
  - ดาวเทียม
  - Contour
- selected mode visibly highlighted
- selection should not reset camera, pitch, bearing, selected sensor, or flood contour

Browser QA:
- switch through all 3 basemaps
- verify tiles load
- verify attribution
- verify sensors remain clickable
- verify flood contour remains visible
- verify 3D terrain remains active

---

## 3. Replace auto-rotation with manual 3D rotation controls

The current `3D หมุน` auto-rotation behavior is not what the user wants.

Remove or stop using continuous auto-rotation as the primary interaction.

User wants explicit manual control over camera orientation.

Implement a compact manual 3D control set such as:

```
↺ หมุนซ้าย
↻ หมุนขวา
↑ เงย/เพิ่ม pitch
↓ ลด pitch
N กลับทิศเหนือ
```

Recommended behavior:

- rotate left/right in sensible steps, e.g. 10–15 degrees per click
- pitch up/down in ~5–10 degree steps
- clamp pitch to MapLibre-safe limits
- reset north sets bearing to 0 without changing center/zoom
- preserve 10x terrain state
- retain native MapLibre drag rotation on desktop
- retain touch rotation where supported
- no infinite auto-rotation by default

Optional:
- press-and-hold rotate buttons may repeat smoothly
- keyboard shortcuts can be added only if they do not conflict with map controls

Acceptance:
- user can deliberately select viewing direction
- no uncontrolled continuous spinning
- camera keeps current center and zoom
- controls work in Satellite, Map and Contour modes

---

# Realtime data constraints

Canonical source currently verified:

```
GET https://water.su.ac.th/api/v1/water/latest-all
```

Rainfall supplement:

```
GET https://water.su.ac.th/api/v1/readings/latest
```

Expected:
- 13 realtime stations
- startup probe should report `mode=live`
- fallback CSV remains available only if upstream is unavailable

Do not regress realtime mode.

---

# Flood contour constraint

Current model is a DEM + realtime sensor screening model.

Keep calculations based on actual elevation and actual water levels.

Visual terrain exaggeration must not change:

```
water_msl_m
water_depth_m
bank_level_msl_m
local_height_m
freeboard_m
flood depth calculation
```

The UI should continue to disclose that flood contour is a screening visualization and not an officially certified flood boundary or full 2D hydrodynamic simulation.

---

# Required implementation workflow in Work

1. Inspect current live deployment in browser.
2. Read current `public/app.js`, `public/index.html`, `public/styles.css`, `src/water-su.js`.
3. Implement 10x visual terrain exaggeration.
4. Implement basemap selector.
5. Replace auto-rotation with manual 3D camera controls.
6. Run:
   ```
   npm test
   ```
   This includes syntax checks for server, adapter and browser app.
7. Push to `main`.
8. Let/trigger Render deploy.
9. Wait for deploy status = `live`.
10. Browser QA the actual public URL on desktop and mobile-sized viewport.
11. Verify realtime sensor source remains `live`.
12. Report:
   - commit SHA
   - deploy ID
   - live URL
   - test result
   - basemap QA
   - 1x/10x QA
   - manual 3D control QA
   - realtime source QA

## Stop conditions

Do not claim complete if:
- satellite tiles fail or violate provider terms
- contour mode removes sensors/flood layers
- switching basemap resets important UI/map state
- 10x changes model numeric values
- realtime falls back to CSV unexpectedly
- deploy is not live
- browser QA shows console/runtime errors

