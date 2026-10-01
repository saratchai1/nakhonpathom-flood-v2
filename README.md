# Nakhon Pathom Flood Digital Twin v2

Digital twin สำหรับติดตามสถานการณ์น้ำในจังหวัดนครปฐม โดยใช้ **realtime sensor จาก water.su.ac.th**, ภูมิประเทศ **DEM จริง** และ flood-depth contour จากระดับผิวน้ำเทียบระดับพื้นดิน

**Live:** https://nakhonpathom-flood-v2.onrender.com

## สถานะปัจจุบัน

- `LIVE` ต่อข้อมูล sensor จริงจาก `water.su.ac.th`
- official endpoint หลัก: `https://water.su.ac.th/api/v1/water/latest-all`
- rainfall supplement: `https://water.su.ac.th/api/v1/readings/latest`
- 13 สถานี
- refresh ทุก 60 วินาที
- ถ้า upstream ใช้งานไม่ได้ ระบบ fallback ไป snapshot จาก CSV ที่ให้มากับงาน
- Render deploy จาก branch `main`
- build gate: `npm test`

ข้อมูล realtime ที่นำมาใช้ประกอบด้วย:

- station name / latitude / longitude
- `water_msl_m`
- `water_depth_m`
- `bank_level_msl_m`
- `local_height_m`
- `water_level_percent`
- `freeboard_m`
- `change_1h_m`
- `rate_m_per_hour`
- `trend`
- `status`
- `is_stale`
- `received_at`
- `TotalRainFall` จาก readings endpoint

## UI

### ภาพรวมพื้นที่

- MapLibre 3D
- ปุ่ม `3D หมุน` สำหรับเริ่ม/หยุด auto-rotation ของมุมมอง 3D
- DEM Terrarium + hillshade
- vertical exaggeration เริ่มต้นที่ `×5` เพื่อให้ภูมิประเทศราบเห็นความสูง–ต่ำชัดขึ้น
- มีปุ่มสลับ `ความสูง ×1 / ×5`; เป็นการขยายเฉพาะการแสดงผล ไม่เปลี่ยน DEM/ระดับน้ำที่ใช้คำนวณ
- ขอบเขตจังหวัดนครปฐม
- sensor marker ตามพิกัด realtime จาก official API
- สีสถานะ `ปกติ / เฝ้าระวัง / วิกฤต / ข้อมูลล่าช้า`
- สถานีที่ freeboard ต่ำแสดงก่อน
- คลิกสถานีเปิด gauge และค่าระดับน้ำโดยละเอียด

### ระดับน้ำแต่ละคลอง / สถานี

ตารางแสดง:

- ระดับน้ำ ม.รทก.
- ระดับตลิ่ง ม.รทก.
- freeboard
- การเปลี่ยนแปลง 1 ชั่วโมง
- แนวโน้มเพิ่มขึ้น / ลดลง / ทรงตัว
- สถานะ realtime

## Flood contour model

โมเดลใน browser ใช้ขั้นตอน:

1. โหลด DEM Terrarium เข้าสู่ MapLibre terrain
2. สร้าง grid ใน monitored corridor
3. interpolate `water_msl_m` จากสถานีใกล้เคียงด้วย inverse-distance weighting
4. query elevation จาก DEM ของแต่ละ grid cell
5. คำนวณ `depth = max(0, water_surface_msl - terrain_msl)`
6. ตัดตำแหน่งที่ไกล sensor เกิน confidence radius
7. สร้าง contour ที่ 0.05, 0.15, 0.30, 0.50, 1.00 และ 1.50 เมตร

> Contour ปัจจุบันเป็น **DEM + sensor screening model** ไม่ใช่ผลจาก 2D hydrodynamic solver และไม่ใช่ขอบเขตน้ำท่วมรับรองทางราชการ
>
> `Vertical exaggeration ×5` มีผลเฉพาะการมองเห็นภูมิประเทศใน 3D เท่านั้น การคำนวณ contour ใช้ elevation จริงด้วย `queryTerrainElevation(..., { exaggerated: false })`

สิ่งที่ยังต้องเพิ่มหากต้องการแบบจำลองเชิง hydraulic เต็มรูปแบบ ได้แก่ flow routing, drainage network, culvert/pipe, flood gate, levee/road barrier, roughness และ boundary conditions

## Realtime adapter

Happy path จะเรียก official API โดยตรงก่อน:

```
GET https://water.su.ac.th/api/v1/water/latest-all
GET https://water.su.ac.th/api/v1/readings/latest
```

หาก canonical endpoint ใช้ไม่ได้ จึงค่อยใช้ discovery recovery path โดยตรวจ HTML/ES modules ของ public site เพื่อค้นหา endpoint ใหม่ แล้วสุดท้ายจึง fallback ไป CSV

Environment variables:

```bash
WATER_SU_BASE_URL=https://water.su.ac.th
WATER_SU_DATA_URL=https://water.su.ac.th/api/v1/water/latest-all
WATER_SU_CACHE_MS=60000
WATER_SU_FETCH_TIMEOUT_MS=5000
```

## Historical CSV fallback

ไฟล์ต้นทาง:

`sensors data [2026-06-30 to 2026-09-30](1).csv`

- 91,741 records
- 13 device IDs
- ช่วงข้อมูล 30 มิ.ย. 2569 – 30 ก.ย. 2569

Repository เก็บ `data/fallback.json` เป็น latest snapshot + สถิติ ไม่ commit CSV ดิบขนาดใหญ่

## Run

ต้องการ Node.js 20+

```bash
npm test
npm start
```

Local URL:

```
http://localhost:3000
```

API:

```
GET /api/health
GET /api/stations
GET /api/sensors
GET /api/sensors?force=1
GET /api/diagnostics
```

## Deploy

Render service:

```
https://nakhonpathom-flood-v2.onrender.com
```

- build: `npm test`
- start: `npm start`
- runtime: Node
- region: Singapore
- branch: `main`

## Data attribution

- Realtime sensor: `water.su.ac.th`
- Historical fallback: CSV ที่ให้มากับงาน
- DEM: AWS Terrain Tiles / Terrarium
- Basemap: OpenFreeMap / OpenStreetMap contributors
- Administrative boundary: OpenGISData-Thailand
