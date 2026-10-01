# Basemap sources

- **Map**: existing OpenFreeMap Bright / OpenStreetMap vector style. Existing attribution is retained.
- **Satellite**: Esri public World Imagery tile service (satellite/aerial mosaic, not realtime flood imagery). Source attribution and a link to Esri terms are supplied to MapLibre's attribution control. This public scientific dashboard provides imagery at no charge, without advertising or commercial transactions. Esri's noncommercial external use grant applies; it is not a blanket commercial or redistribution licence. No bulk download, redistribution or tile proxy is introduced.
  - https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer
  - https://www.esri.com/en-us/legal/terms/web-site-service (sections 2.2 and 2.7)
- **Contour**: OpenTopoMap raster tiles; map data © OpenStreetMap contributors and SRTM, map style © OpenTopoMap, CC BY-SA 3.0. Provider attribution and licence links are supplied to MapLibre's attribution control.
  - https://opentopomap.org/about#verwendung
  - https://creativecommons.org/licenses/by-sa/3.0/

Attribution remains available in the MapLibre attribution control on desktop and mobile. Neither raster layer represents a measured flood extent. Contour spacing and imagery resolution depend on provider zoom; the low relief of Nakhon Pathom can produce sparse topographic contour lines.

All basemaps share the existing terrain DEM and custom overlays. Switching uses layer visibility, not `setStyle`. Visual exaggeration does not rescale any model inputs or exported sensor values. Satellite, contour and DEM providers remain external dependencies; failures are shown in the map status instead of silently claiming success.
