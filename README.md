# Nakhon Pathom Flood Digital Twin v2

Digital twin สำหรับดูสถานการณ์น้ำในจังหวัดนครปฐม โดยเอา **ระดับน้ำจาก sensor** มาวางบน **ภูมิประเทศ DEM จริง** แล้วสร้าง flood-depth contour จากระดับผิวน้ำเทียบกับระดับพื้นดิน

ต้นแบบหน้าแผนที่อ้างอิงแนวคิดและ field data จาก `https://water.su.ac.th/` และใช้ CSV ที่ให้มากับงานนี้เป็น fallback snapshot เพื่อให้ระบบยังเปิดดูได้เมื่อ live source ติดต่อไม่ได้

## สิ่งที่ทำแล้ว

- มุมมอง **ภาพรวมพื้นที่** บนแผนที่ 3D
- DEM จริงจาก AWS Terrain Tiles (Terrarium) + hillshade
- ขอบเขตจังหวัดนครปฐมจาก Open GIS Data Thailand
- จุด sensor N1–N12 พร้อมสี `ปกติ / เฝ้าระวัง / วิกฤต`
- คลิกสถานีเพื่อดู gauge แบบเดียวกับแนวคิดใน water.su.ac.th:
  - ระดับน้ำ ม.รทก.
  - ระดับตลิ่ง ม.รทก.
  - ระดับน้ำจริง
  - ระดับตลิ่งจริง
  - freeboard
  - ปริมาณฝน
- มุมมอง **ระดับน้ำแต่ละสถานี** เรียงจาก freeboard ต่ำสุดก่อน
- **Flood contour จาก DEM**: interpolate water surface จาก sensor แล้วหาความลึก `water_msl - terrain_elevation`
- refresh sensor ทุก 60 วินาที
- server adapter สำหรับพยายามหา live endpoint ของ water.su.ac.th จาก HTML/JavaScript ของเว็บจริง และ fallback เป็นข้อมูล CSV เมื่อหา live feed ไม่ได้
- `/api/diagnostics` สำหรับดูว่า live adapter ใช้ source ไหนและลอง endpoint อะไรไปแล้ว

## CSV ที่ใช้เป็น fallback

ไฟล์ต้นทางที่ได้รับ:

`Sensors data [2026-06-30 to 2026-09-30]`

- 91,741 records
- 13 device IDs: `N1, N2, N3, N4, N5, N6, N7, N8, N9, N9-2, N10, N11, N12`
- ช่วงข้อมูล: 30 มิ.ย. 2569 – 30 ก.ย. 2569

เพื่อไม่ commit ไฟล์ดิบขนาดใหญ่เข้า repository รอบแรก จึงเก็บ `data/fallback.json` เป็น latest snapshot + สถิติต่อสถานีจาก CSV เดิม การทำงาน realtime จะเลือก live source ก่อน fallback เสมอ

## Live data adapter

ตั้งค่าได้ด้วย environment variables:

```bash
WATER_SU_BASE_URL=https://water.su.ac.th
# ถ้าทราบ endpoint จริงภายหลัง ให้ระบุเพื่อข้าม auto-discovery
WATER_SU_DATA_URL=https://water.su.ac.th/<actual-data-endpoint>
WATER_SU_CACHE_MS=60000
WATER_SU_FETCH_TIMEOUT_MS=8000
```

เมื่อ `WATER_SU_DATA_URL` ยังไม่ระบุ ระบบจะ:

1. ตรวจหน้า `index.html`, `dashboard.html`, `water-comparison.html`
2. อ่าน `<script src=...>` ของหน้าเหล่านั้น
3. หา URL ที่ใช้ใน `fetch(...)`, `apiUrl`, `dataUrl`, download/export paths
4. ทดลอง normalize JSON/CSV ที่พบ
5. ถ้าได้ข้อมูล sensor ที่ใช้ได้ จะตอบ `mode=live`
6. ถ้ายังไม่ได้ จะตอบ `mode=csv-fallback`

## Flood contour model

โมเดลใน UI ใช้ขั้นตอนนี้:

1. โหลด DEM Terrarium เข้าสู่ MapLibre terrain
2. สร้าง grid ใน monitored corridor
3. interpolate `water_msl_m` จาก sensor ใกล้เคียงด้วย inverse-distance weighting
4. query elevation จริงจาก DEM ทุก grid cell
5. คำนวณ `depth = max(0, water_surface_msl - terrain_msl)`
6. ตัดจุดที่ไกล sensor เกิน confidence radius
7. สร้าง contour ที่ 0.05, 0.15, 0.30, 0.50, 1.00 และ 1.50 เมตร

**สำคัญ:** contour นี้คือ hydraulic screening model จาก DEM + sensor ไม่ใช่ขอบเขตน้ำท่วมรับรองทางราชการ และยังไม่ได้แทน 2D hydrodynamic solver ที่คำนึงถึงคันกั้นน้ำ ท่อ ประตูระบายน้ำ roughness และ flow routing

## พิกัดสถานี

พิกัดส่วนใหญ่ผูกจาก public location references ตามชื่อสถานี แต่ `N3`, `N7`, `N8`, `N11` ยังระบุ `coordSource` ว่าเป็นตำแหน่งอ้างอิง/ประมาณจากแผนที่และควร cross-check กับ pin ต้นฉบับของ water.su.ac.th ก่อนใช้วิเคราะห์ระดับ parcel/ถนน

`N12` ตรวจชื่อจากภาพต้นฉบับเป็น **วัดงิ้วราย** และผูกพิกัด public reference ของวัด

## Run

ต้องการ Node.js 20+ และไม่ต้องติดตั้ง dependency ฝั่ง server

```bash
npm start
# http://localhost:3000
```

ทดสอบ:

```bash
npm test
```

Health check:

```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/sensors
curl http://localhost:3000/api/diagnostics
```

## Deploy

มี `render.yaml` และ `Dockerfile` พร้อมสำหรับ deploy เป็น web service

- start command: `npm start`
- health check: `/api/health`
- port: ใช้ `PORT` จาก platform

## Data attribution

- Sensor/data reference: `water.su.ac.th`
- Historical fallback: CSV ที่ให้มากับงานนี้
- DEM: AWS Terrain Tiles / Terrarium
- Basemap: OpenFreeMap / OpenStreetMap contributors
- Administrative boundary: OpenGISData-Thailand
