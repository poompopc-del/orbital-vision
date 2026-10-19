# ORBITAL VISION

แพลตฟอร์มเว็บสำหรับสำรวจโลก ติดตามดาวเทียมสำรวจโลก ค้นภาพจาก archive และเตรียมคำขอถ่ายภาพใหม่ (tasking) จากผู้ให้บริการหลายราย

สร้างด้วย React + TypeScript + Vite + CesiumJS + Tailwind, ใช้ Supabase (Postgres + PostGIS) เป็น backend และ deploy บน Vercel

---

## เริ่มใช้งานบนเครื่อง

```powershell
npm install
copy .env.example .env    # ใส่ค่าที่มี (ไม่บังคับ)
npm run dev               # เปิด http://localhost:5173
```

`npm run build` จะได้โฟลเดอร์ `dist/` ส่วน `npm run typecheck` ใช้ตรวจ type แยกต่างหาก (build ไม่ได้บล็อกเพราะ type)

> ตอนรัน `npm run dev` ยังไม่มี `/api/tle` ให้เรียก แอปจึงดึง TLE จาก CelesTrak ตรงจากเบราว์เซอร์แทน และ cache ไว้ 2 ชั่วโมง
> พอ deploy บน Vercel แอปจะเรียกผ่าน `/api/tle` ซึ่งมี edge cache

## ตัวแปรแวดล้อม (ทุกตัวไม่บังคับ)

| ตัวแปร | ถ้าไม่ตั้งค่า |
|---|---|
| `VITE_CESIUM_ION_TOKEN` | ใช้แผนที่ฐาน Esri World Imagery และโหมด Terrain จะถูกปิดไว้ |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | โปรเจกต์ คำขอ และ audit log จะเก็บในเบราว์เซอร์นี้เท่านั้น (UI ขึ้นป้ายว่า local) |

**ห้าม** ใส่ Supabase secret key หรือ API key ของผู้ให้บริการภาพลงในตัวแปร `VITE_*` เด็ดขาด เพราะตัวแปรเหล่านี้ถูกส่งไปที่เบราว์เซอร์ทั้งหมด

## ตั้งค่า Supabase

1. สร้างโปรเจกต์ใหม่ใน Supabase
2. เปิด SQL Editor แล้วรันไฟล์ `supabase/schema.sql` (เปิดใช้ PostGIS, สร้างตาราง และตั้ง RLS ให้เรียบร้อย)
3. ไปที่ Authentication → URL Configuration แล้วใส่ URL ของเว็บ (เช่น `https://<project>.vercel.app`) ลงใน Site URL / Redirect URLs
4. นำ Project URL กับ Publishable key ไปตั้งค่าใน `.env` และใน Vercel
5. ล็อกอินครั้งแรกแล้ว ให้ตั้งตัวเองเป็น admin ด้วยคำสั่ง SQL ที่อยู่ท้ายไฟล์ schema

## Deploy บน Vercel

```powershell
git init
git add .
git commit -m "ORBITAL VISION initial"
git branch -M main
git remote add origin https://github.com/<user>/orbital-vision.git
git push -u origin main
```

จากนั้นไปที่ Vercel → Add New Project → เลือก repo นี้ (Framework: Vite) → ใส่ Environment Variables → Deploy

ไฟล์ `vercel.json` ตั้ง SPA rewrite ไว้ให้แล้ว ส่วน `api/tle.js` จะกลายเป็น serverless function เอง

---

## หน้าต่าง ๆ

| | หน้า | สิ่งที่ทำได้จริงตอนนี้ |
|---|---|---|
| A | Mission Control | globe 3D/2D, ตำแหน่งดาวเทียมคำนวณด้วย SGP4 จาก TLE จริง, วงโคจร, ground track, swath, คลิกดูรายละเอียดดาว, filter, ค้นสถานที่/พิกัด, วาด POI/สี่เหลี่ยม/polygon, import GeoJSON/KML, timeline, โหมด Live / Historical / Coverage |
| B | Imagery Explorer | ค้นภาพจริงจาก Earth Search STAC (Sentinel-2 L2A, Landsat C2 L2, Sentinel-1 GRD), กรองเมฆ/วันที่, % ครอบคลุม AOI, footprint บน globe, ลิงก์ portal ทางการของผู้ให้บริการเชิงพาณิชย์ |
| C | New Acquisition | wizard 5 ขั้น แสดงตัวเลือกตามชนิดเซนเซอร์ (optical/SAR), เลือกผู้ให้บริการที่รับ tasking, export request package (GeoJSON), ลิงก์ช่องทางสั่งซื้อทางการ |
| D | Satellite Catalog | ตาราง mission + ดาวเทียมทุกดวงพร้อม metadata ครบ (NORAD, designator, perigee/apogee, inclination, period, epoch, TLE, sensor) |
| E | Provider Marketplace | ไดเรกทอรีผู้ให้บริการ, filter ตามประเภทข้อมูล/เซนเซอร์/ความละเอียด/archive/tasking, ตารางเปรียบเทียบ |
| F | Coverage Planner | ประมาณช่วงที่ดาวผ่าน AOI จาก SGP4 + swath ที่มีเอกสารยืนยัน, กลางวัน/กลางคืน, ความเชื่อมั่นตามอายุ TLE |
| G | Image Analysis | swipe เปรียบเทียบภาพ 2 ภาพ, timeline การถ่ายภาพบน AOI, metadata, วัดระยะ/พื้นที่, export metadata |
| H | Orders & Projects | ติดตามสถานะคำขอทั้ง 13 สถานะ พร้อมประวัติว่าใครเป็นคนรายงาน (platform / user-reported / provider API), จัดคำขอเป็นโปรเจกต์ |
| I | Administration | ผู้ใช้/role, สถานะ integration, การตั้งค่า credential, quota การเรียก API สาธารณะ, audit log |

## หลักความถูกต้องที่ฝังไว้ในระบบ

- ตำแหน่งดาวเทียมทุกจุดมาจากการคำนวณ (PROPAGATED ORBIT · SGP4) ไม่ใช่ telemetry สด UI แสดง epoch ของ TLE และเตือนเมื่อข้อมูลเก่า
- ถ้าโหลดข้อมูลวงโคจรไม่ได้ ระบบจะไม่แสดงดาวเลย แทนที่จะสร้างตำแหน่งปลอมขึ้นมา
- ภาพทุกภาพเป็นข้อมูลจริงจาก STAC และมีป้ายกำกับว่าเป็น preview แบบ JPEG ที่ georeference แบบประมาณ
- ไม่มีการแต่งราคาขึ้นมาเอง ผู้ให้บริการเชิงพาณิชย์ทุกรายขึ้นว่า "Quote from provider"
- คำขอที่สร้างในระบบจะไม่ถูกแสดงว่าเป็นคำสั่งซื้อที่ยืนยันแล้ว สถานะฝั่งผู้ให้บริการที่ผู้ใช้กรอกเองจะติดป้าย **user-reported**
- การที่ดาวผ่าน AOI ไม่ได้หมายความว่าจะถ่ายภาพได้ หน้า Coverage Planner ระบุแหล่งที่มาและข้อจำกัดของการประมาณทุกครั้ง

## แหล่งข้อมูลและเงื่อนไขการใช้

- **CelesTrak GP** (TLE): ไม่ควรดาวน์โหลดซ้ำถี่กว่าประมาณทุก 2 ชั่วโมง ระบบ cache ไว้ให้แล้ว
- **Earth Search STAC** (Element 84 / AWS Open Data): Sentinel และ Landsat เป็นข้อมูลเปิด
- **OpenStreetMap Nominatim**: จำกัดไม่เกิน 1 request/วินาที ห้ามใช้แบบ bulk หากใช้งานจริงจังควรเปลี่ยนไปใช้ geocoder ของตัวเอง
- **Esri World Imagery**: ต้องแสดง attribution ซึ่ง Cesium แสดงให้อัตโนมัติ โปรดตรวจเงื่อนไขการใช้งานของ Esri ก่อนใช้เชิงพาณิชย์

## งานที่ยังไม่ได้ทำ (Roadmap)

- เชื่อม API ผู้ให้บริการจริง (Planet, Capella, ICEYE ฯลฯ) ผ่าน serverless function ใน `/api` โดยเก็บ key ไว้ฝั่ง server
- อ่าน COG ราย band เพื่อทำ false-color, ปรับการแสดงผล SAR (dB) และอ่านค่า pixel
- ดึง TLE ย้อนหลังจาก Space-Track (ต้องมีบัญชี) เพื่อให้ Historical replay แม่นยำ
- ระบบจัดการผู้ใช้หลายคนในหน้า Admin (ต้องใช้ Supabase service role ผ่าน server)
