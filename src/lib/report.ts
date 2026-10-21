// OPP-style landscape report (16:9 pages) built as a standalone HTML document that the browser
// prints to PDF. Every number and sentence comes from stored monitoring runs; images are the
// rendered scenes saved with each run; the basemap comes from Esri World Imagery (export API).
import { getImage, narrative, rai, confTh, levelTh, PURPOSES, REGIONS, type MonitorAoi, type MonitorRun } from './monitor';
import { areaKm2, centroid } from './geo';

type Lang = 'th' | 'en';
type BBox = { west: number; south: number; east: number; north: number };

const ESRI = 'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export';
const esri = (b: BBox, w: number, h: number) => `${ESRI}?bbox=${b.west},${b.south},${b.east},${b.north}&bboxSR=4326&imageSR=4326&size=${w},${h}&format=jpg&f=image`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const f1 = (v: number, d = 1) => v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

/** Expand a bbox to the given width/height ratio (degrees, plate carrée) with padding. */
function fit(b: BBox, ratio: number, pad = 0.15): BBox {
  let w = (b.east - b.west) * (1 + pad * 2), h = (b.north - b.south) * (1 + pad * 2);
  w = Math.max(w, 0.02); h = Math.max(h, 0.02);
  if (w / h > ratio) h = w / ratio;
  else w = h * ratio;
  const cx = (b.west + b.east) / 2, cy = (b.south + b.north) / 2;
  return { west: cx - w / 2, east: cx + w / 2, south: cy - h / 2, north: cy + h / 2 };
}
const bboxOfPoly = (g: GeoJSON.Polygon): BBox => {
  const xs = g.coordinates[0].map((c) => c[0]), ys = g.coordinates[0].map((c) => c[1]);
  return { west: Math.min(...xs), east: Math.max(...xs), south: Math.min(...ys), north: Math.max(...ys) };
};
const union = (bs: BBox[]): BBox => ({ west: Math.min(...bs.map((b) => b.west)), east: Math.max(...bs.map((b) => b.east)), south: Math.min(...bs.map((b) => b.south)), north: Math.max(...bs.map((b) => b.north)) });

/** % position of lon/lat inside a frame bbox. */
const px = (f: BBox, lon: number, lat: number) => [((lon - f.west) / (f.east - f.west)) * 100, ((f.north - lat) / (f.north - f.south)) * 100];
const placed = (f: BBox, b: BBox) => {
  const [l, t] = px(f, b.west, b.north);
  const [r, bt] = px(f, b.east, b.south);
  return `left:${l}%;top:${t}%;width:${r - l}%;height:${bt - t}%`;
};
const polyPath = (f: BBox, g: GeoJSON.Polygon) => g.coordinates[0].map(([x, y], i) => `${i ? 'L' : 'M'}${px(f, x, y)[0].toFixed(3)},${px(f, x, y)[1].toFixed(3)}`).join(' ') + 'Z';

function scaleBar(f: BBox, frameWidthMm: number) {
  const lat = (f.north + f.south) / 2;
  const km = (f.east - f.west) * 111.32 * Math.cos((lat * Math.PI) / 180);
  const target = km / 5;
  const nice = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].find((n) => n >= target * 0.6) ?? 500;
  const pct = (nice / km) * 100;
  return `<div class="scale"><div class="bar" style="width:${(pct * frameWidthMm) / 100}mm"></div><span>${nice} km</span></div>`;
}
const NORTH = `<svg class="north" viewBox="0 0 40 40"><circle cx="20" cy="20" r="19" fill="#0b1524" stroke="#fff" stroke-width="1.5"/><path d="M20 6 L27 28 L20 23 L13 28 Z" fill="#fff"/><text x="20" y="38" text-anchor="middle" font-size="8" fill="#fff" font-weight="700">N</text></svg>`;

const zulu = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')} ${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getUTCMonth()]} ${d.getUTCFullYear()} / ${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
const dmy = (s?: string) => (s ? new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase() : '—');

export interface ReportInput {
  title: string;
  lang: Lang;
  requirement: string;
  items: { aoi: MonitorAoi; run: MonitorRun | undefined }[];
}

export async function buildReportHtml(inp: ReportInput): Promise<string> {
  const th = inp.lang === 'th';
  const L = (a: string, b: string) => (th ? a : b);
  const now = new Date();
  const items = inp.items.map((x, i) => ({ ...x, n: i + 1 }));
  const counts = { significant: 0, minor: 0, none: 0, insufficient: 0 };
  items.forEach(({ run }) => {
    if (!run || run.status !== 'ok') counts.insufficient++;
    else counts[run.level ?? 'none']++;
  });

  const imgs: Record<string, { before: string | null; after: string | null; change: string | null }> = {};
  for (const { run } of items) if (run?.status === 'ok') imgs[run.id] = { before: await getImage(`${run.id}:before`), after: await getImage(`${run.id}:after`), change: await getImage(`${run.id}:change`) };

  const footer = (pg: number) => `<div class="foot"><span>${esc(inp.title)}</span><span class="warn">${L('ผลวิเคราะห์จากภาพดาวเทียมแบบเปิด ไม่ได้ผ่านการตรวจสอบภาคพื้นดิน · ใช้ประกอบการตัดสินใจเท่านั้น', 'Derived from open satellite imagery, not ground-verified · for planning support only')}</span><span>${pg}</span></div>`;
  const pages: string[] = [];

  // ---- 1. cover
  pages.push(`<section class="page cover">
  <h1>${esc(inp.title)}</h1><div class="rule"></div>
  <h2>${L('ความต้องการข้อมูล', 'Query Requirements')}</h2><p>${esc(inp.requirement)}</p>
  <h2>${L('วันเวลาออกรายงาน', 'Product Release Date / Time')}</h2><p class="mono">${zulu(now)}</p>
  <h2>${L('ภาพรวมรายงาน', 'Product Overview')}</h2>
  <p>– ${L(
    `วิเคราะห์การเปลี่ยนแปลงจากภาพดาวเทียม ${items.length} พื้นที่ (AOI): พบการเปลี่ยนแปลงมีนัยสำคัญ ${counts.significant} พื้นที่ · เล็กน้อย ${counts.minor} พื้นที่ · ไม่พบ ${counts.none} พื้นที่ · ข้อมูลไม่เพียงพอ ${counts.insufficient} พื้นที่`,
    `Satellite change analysis of ${items.length} areas of interest (AOIs): ${counts.significant} with significant change, ${counts.minor} minor, ${counts.none} with no detected change, ${counts.insufficient} with insufficient imagery.`,
  )}</p>
  <div class="disc">${L(
    'ข้อมูลภาพและการประเมินในรายงานนี้ใช้เพื่อประกอบการวางแผนเท่านั้น วิเคราะห์จากภาพดาวเทียมแบบเปิด (Copernicus Sentinel) โดยระบบ ORBITAL VISION และยังไม่ผ่านการตรวจสอบโดยผู้เชี่ยวชาญหรือภาคพื้นดิน หน่วยงานผู้ขอรับผิดชอบการเผยแพร่ต่อ',
    'The imagery and assessment in this product are for planning support only. They were produced automatically by ORBITAL VISION from open satellite imagery (Copernicus Sentinel) and have not been vetted by an analyst or on the ground. The requesting organisation is responsible for further release.',
  )}</div>
  ${footer(1)}</section>`);

  // ---- 2. key findings & overview
  const allB = union(items.map((x) => bboxOfPoly(x.aoi.geometry)));
  const ovFrame = fit(allB, 120 / 128, 0.25);
  const rows = items
    .map(({ aoi, run, n }) => {
      const [lon, lat] = centroid(aoi.geometry);
      const lv = !run || run.status !== 'ok' ? L('ข้อมูลไม่พอ', 'Insufficient') : th ? levelTh(run.level) : run.level;
      const finding = run ? narrative(run, inp.lang)[0] : L('ยังไม่ได้วิเคราะห์', 'Not analysed yet');
      return `<tr><td class="c">${n}</td><td>${esc(aoi.name)}</td><td class="mono c">${lat.toFixed(3)},<br>${lon.toFixed(3)}</td><td class="c lv-${run?.status === 'ok' ? run.level : 'x'}">${esc(String(lv))}</td><td>${esc(finding)}</td></tr>`;
    })
    .join('');
  const ovMarks = items
    .map(({ aoi, n }) => {
      const [x, y] = px(ovFrame, ...centroid(aoi.geometry));
      return `<div class="mk" style="left:${x}%;top:${y}%"><b>${n}</b></div>`;
    })
    .join('');
  pages.push(`<section class="page">
  <h1>${L('ข้อค้นพบสำคัญและภาพรวมพื้นที่', 'Key Findings & AOI Overview')}</h1><div class="rule"></div>
  <div class="two"><table class="kf"><thead><tr><th>AOI</th><th>${L('ชื่อ', 'Name')}</th><th>LAT, LON</th><th>${L('ระดับ', 'Level')}</th><th>${L('ข้อค้นพบ', 'Key Findings')}</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="map ov"><img src="${esri(ovFrame, 900, 960)}" alt=""/>${ovMarks}${NORTH}${scaleBar(ovFrame, 120)}</div></div>
  <div class="src">${L('แผนที่ฐาน: Esri World Imagery', 'Basemap: Esri World Imagery')}</div>
  ${footer(2)}</section>`);

  // ---- 3+. one page per AOI
  let pg = 3;
  const loc: BBox = { west: 96.5, east: 106.5, south: 5.0, north: 21.0 };
  for (const { aoi, run, n } of items) {
    const b = bboxOfPoly(aoi.geometry);
    const frame = fit(b, 190 / 128, 0.12);
    const im = run ? imgs[run.id] : undefined;
    const [clon, clat] = centroid(aoi.geometry);
    const region = REGIONS.find((r) => r.id === aoi.region);
    const purpose = PURPOSES.find((p) => p.id === aoi.purpose);
    const bullets = (run ? narrative(run, inp.lang) : [L('ยังไม่มีผลวิเคราะห์', 'No analysis yet')]).map((x) => `<li>${esc(x)}</li>`).join('');
    const hs = (run?.hotspots ?? []).slice(0, 10);
    const hsMarks = hs.map((h) => {
      const [x, y] = px(frame, h.lon, h.lat);
      return `<div class="hs" style="left:${x}%;top:${y}%">${h.n}</div>`;
    }).join('');
    const hsRows = hs.slice(0, 6).map((h) => `<tr><td>${h.n}</td><td class="mono">${h.lat.toFixed(4)}, ${h.lon.toFixed(4)}</td><td class="r">${f1(h.areaHa)}</td></tr>`).join('');
    const legend = (run?.legend ?? []).map((l) => `<span><i style="background:${l.color}"></i>${esc(th ? l.labelTh : l.label)}</span>`).join('');
    const [lx, ly] = px(loc, clon, clat);
    const sensorTxt = run?.sensor === 'sar' ? 'Sentinel-1 RTC (SAR)' : 'Sentinel-2 L2A';
    pages.push(`<section class="page">
    <h1>AOI ${n}: ${esc(aoi.name)}</h1><div class="rule"></div>
    <div class="aoi">
      <div class="side">
        <div class="box"><h3>${L('อัปเดตภาพ', 'Imagery Update')}: ${dmy(run?.B?.datetime)}</h3>
          <div class="meta">${esc(th ? region?.labelTh ?? '' : region?.label ?? '')} · ${esc(th ? purpose?.labelTh ?? '' : purpose?.label ?? '')}</div>
          <ul>${bullets}</ul>
          ${run?.status === 'ok' ? `<div class="kv"><span>${L('พื้นที่ที่ตรวจพบ', 'Detected area')}</span><b>${f1((run.stats?.interestKm2 ?? 0) * 100)} ha · ${f1(rai(run.stats?.interestKm2 ?? 0), 0)} ${L('ไร่', 'rai')}</b></div>
          <div class="kv"><span>${L('ระดับ / ความเชื่อมั่น', 'Level / confidence')}</span><b>${th ? levelTh(run.level) : run.level} · ${th ? confTh(run.confidence) : run.confidence}</b></div>` : ''}
          ${hsRows ? `<table class="hst"><tr><th>#</th><th>LAT, LON</th><th>ha</th></tr>${hsRows}</table>` : ''}
        </div>
        <div class="loc"><img src="${esri(loc, 300, 480)}" alt=""/><div class="locmk" style="left:${lx}%;top:${ly}%"></div><span>AOI ${n}</span></div>
      </div>
      <div class="map main">
        <img src="${esri(frame, 1140, 768)}" alt=""/>
        ${im?.after && run?.bounds ? `<img class="ov" style="${placed(frame, run.bounds)}" src="${im.after}" alt=""/>` : ''}
        ${im?.change && run?.overlayBounds ? `<img class="ov" style="${placed(frame, run.overlayBounds)}" src="${im.change}" alt=""/>` : ''}
        <svg class="aoiline" viewBox="0 0 100 100" preserveAspectRatio="none"><path d="${polyPath(frame, aoi.geometry)}" fill="none" stroke="#fff" stroke-width="0.35" stroke-dasharray="1.2 0.8" vector-effect="non-scaling-stroke"/></svg>
        ${hsMarks}
        <div class="tag tl mono">${dmy(run?.B?.datetime)} · ${clat.toFixed(3)}, ${clon.toFixed(3)}</div>
        ${im?.before && run?.bounds ? `<div class="inset"><img src="${im.before}" alt=""/><div class="tag mono">${L('ก่อน', 'BEFORE')} ${dmy(run?.A?.datetime)}</div></div>` : ''}
        ${NORTH}${scaleBar(frame, 190)}
        <div class="legend"><b>${L('คำอธิบาย', 'LEGEND')}</b><span><i class="line"></i>AOI</span><span><i class="dot">1</i>${L('จุดที่ตรวจพบ', 'Detected patch')}</span>${legend}<span class="muted">${L('ช่วงที่ตรวจ', 'Change window')}: ${dmy(run?.A?.datetime)} → ${dmy(run?.B?.datetime)}</span></div>
      </div>
    </div>
    <div class="src">${run?.status === 'ok' ? `${sensorTxt}: ${esc(run.A?.id ?? '')} (${dmy(run.A?.datetime)}), ${esc(run.B?.id ?? '')} (${dmy(run.B?.datetime)}) · Microsoft Planetary Computer · ` : ''}${L('แผนที่ฐาน Esri World Imagery', 'Esri World Imagery basemap')} · ${f1(areaKm2(aoi.geometry), 1)} km²</div>
    ${footer(pg++)}</section>`);
  }

  // ---- last: method & sources
  const srcRows = items
    .map(({ aoi, run, n }) => `<tr><td class="c">${n}</td><td>${esc(aoi.name)}</td><td>${run?.status === 'ok' ? `${esc(run.A?.id ?? '')}<br>${esc(run.B?.id ?? '')}` : esc(run?.reason ?? L('ไม่มีข้อมูล', 'no data'))}</td><td class="mono">${run ? dmy(run.at) : '—'}</td><td>${esc(run?.method ?? '')}</td></tr>`)
    .join('');
  pages.push(`<section class="page">
  <h1>${L('วิธีการ แหล่งข้อมูล และข้อจำกัด', 'Method, Sources & Limitations')}</h1><div class="rule"></div>
  <table class="kf small"><thead><tr><th>AOI</th><th>${L('ชื่อ', 'Name')}</th><th>${L('ภาพที่ใช้ (ก่อน / หลัง)', 'Scenes (before / after)')}</th><th>${L('วิเคราะห์เมื่อ', 'Analysed')}</th><th>${L('วิธี', 'Method')}</th></tr></thead><tbody>${srcRows}</tbody></table>
  <h2>${L('ข้อจำกัด', 'Limitations')}</h2><ul class="lim">
  <li>${L('ความละเอียด 10 เมตร (Sentinel) — ตรวจจับการถางหรือดินเปิดขนาดตั้งแต่ราว 0.2 เฮกตาร์ขึ้นไปได้ แต่ไม่เห็นสิ่งปลูกสร้างขนาดเล็ก ทางเดินแคบ หรือยานพาหนะ', '10 m resolution (Sentinel): clearings or bare ground from about 0.2 ha are detectable; small structures, narrow tracks and vehicles are not.')}</li>
  <li>${L('เมฆและเงาเมฆถูกตัดออกด้วยชั้น SCL ของ Sentinel-2 พื้นที่ที่ถูกตัดจะไม่ถูกนับ ส่วนเรดาร์อาจเปลี่ยนจากความชื้น ฝน หรือพืชไร่', 'Cloud and shadow are masked with Sentinel-2 SCL and excluded; radar change can also come from moisture, rain or crops.')}</li>
  <li>${L('ตำแหน่งเป็นพิกัดศูนย์กลางของกลุ่มพิกเซล ความคลาดเคลื่อนราว 10–20 เมตร เส้นชายแดนในแผนที่ (ถ้ามี) เป็นเส้นโดยประมาณจาก Natural Earth ไม่ใช่เส้นเขตแดนตามกฎหมาย', 'Positions are pixel-cluster centroids (±10–20 m). Any border line shown is approximate (Natural Earth), not the legal boundary.')}</li>
  <li>${L('การเปลี่ยนแปลงของค่าดัชนีไม่ใช่หลักฐานยืนยันสาเหตุ ต้องตรวจสอบด้วยภาพความละเอียดสูงหรือภาคพื้นดินก่อนสรุป', 'A change in index values is not proof of cause; confirm with very-high-resolution imagery or ground checks before drawing conclusions.')}</li></ul>
  <h2>${L('แหล่งข้อมูล', 'Sources')}</h2><ul class="lim">
  <li>Copernicus Sentinel-1/-2 (ESA) — Microsoft Planetary Computer STAC & data API, ${L('เข้าถึงเมื่อ', 'accessed')} ${dmy(now.toISOString())}</li>
  <li>Esri World Imagery (basemap) · Natural Earth (country outlines)</li></ul>
  ${footer(pg)}</section>`);

  const font = th ? "'Sarabun'" : "'Inter'";
  return `<!doctype html><html lang="${inp.lang}"><head><meta charset="utf-8"><title>${esc(inp.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
@page{size:297mm 167mm;margin:0}
*{box-sizing:border-box}
body{margin:0;background:#666;font-family:${font},'Inter',sans-serif;color:#111;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{position:relative;width:297mm;height:167mm;background:#fff;margin:6mm auto;padding:7mm 10mm 12mm;overflow:hidden;page-break-after:always}
@media print{body{background:#fff}.page{margin:0}.bar-top{display:none}}
h1{margin:0;font-size:22pt;font-weight:600;letter-spacing:.2px}
.rule{height:2.2mm;margin:1.5mm 0 3mm;background:linear-gradient(90deg,#2b1a6b,#6d5bd0 45%,rgba(255,255,255,0))}
h2{font-size:13pt;color:#3b2a8a;margin:4mm 0 1mm}
p{margin:0 0 1mm;font-size:11pt;line-height:1.45}
.mono{font-family:'JetBrains Mono',monospace}
.cover p{font-size:12pt}
.disc{position:absolute;left:25mm;right:25mm;bottom:17mm;background:#a7d39a;border:1px solid #426b33;border-radius:2mm;padding:2mm 4mm;font-size:8.5pt;font-weight:600;text-align:center}
.foot{position:absolute;left:10mm;right:10mm;bottom:4mm;display:flex;justify-content:space-between;gap:6mm;font-size:7.5pt;color:#555;border-top:1.5px solid #2b1a6b;padding-top:1.2mm}
.foot .warn{color:#c00;text-align:center}
.two{display:grid;grid-template-columns:1fr 120mm;gap:4mm;height:128mm}
table{border-collapse:collapse;width:100%}
.kf th{background:#f2f2f2;font-size:9pt;border:1px solid #333;padding:1mm}
.kf td{font-size:8.3pt;border:1px solid #333;padding:1mm 1.5mm;vertical-align:middle;line-height:1.3}
.kf.small td{font-size:7.5pt}
.c{text-align:center}.r{text-align:right}
.lv-significant{background:#fde2e2;font-weight:700}.lv-minor{background:#fff1cc}.lv-none{background:#e6f4ea}.lv-x{background:#eee}
.map{position:relative;overflow:hidden;background:#222;border:1px solid #333}
.map>img{position:absolute;inset:0;width:100%;height:100%;object-fit:fill}
.map img.ov{position:absolute;object-fit:fill;inset:auto}
.ov.map{height:128mm}
.mk{position:absolute;transform:translate(-50%,-50%);width:6mm;height:6mm;border:1.5px solid #fff;background:rgba(0,0,0,.55);color:#fff;font-size:8pt;display:flex;align-items:center;justify-content:center}
.north{position:absolute;right:3mm;top:3mm;width:9mm;height:9mm}
.scale{position:absolute;left:4mm;bottom:3mm;color:#fff;font-size:8pt;font-weight:700;text-shadow:0 0 2px #000}
.scale .bar{height:2mm;background:#fff;border:1px solid #000;margin-bottom:.5mm}
.src{position:absolute;left:10mm;bottom:9mm;font-size:7pt;color:#444;max-width:270mm}
.aoi{display:grid;grid-template-columns:62mm 1fr;gap:3mm;height:128mm}
.side{display:flex;flex-direction:column;gap:2mm}
.box{border:1px solid #bbb;background:#f6f6f8;padding:2mm 2.5mm;flex:1;overflow:hidden}
.box h3{margin:0 0 1mm;font-size:10pt}
.box .meta{font-size:7.5pt;color:#3b2a8a;margin-bottom:1mm}
.box ul{margin:0;padding-left:4mm;font-size:8.3pt;line-height:1.35}
.box li{margin-bottom:.8mm}
.kv{display:flex;justify-content:space-between;gap:2mm;font-size:8pt;border-top:1px solid #ddd;padding-top:.8mm;margin-top:.8mm}
.hst{margin-top:1.5mm;font-size:7.5pt}.hst th,.hst td{border-bottom:1px solid #ddd;padding:.4mm .8mm;text-align:left}
.loc{position:relative;height:42mm;border:1px solid #333;overflow:hidden}
.loc img{width:100%;height:100%;object-fit:fill}
.loc span{position:absolute;left:1.5mm;bottom:1mm;color:#fff;font-size:7pt;font-weight:700;text-shadow:0 0 2px #000}
.locmk{position:absolute;width:3mm;height:3mm;border:1.5px solid #fff;background:#e11;transform:translate(-50%,-50%)}
.main{height:128mm}
.aoiline{position:absolute;inset:0;width:100%;height:100%}
.hs{position:absolute;transform:translate(-50%,-50%);min-width:4.2mm;height:4.2mm;border-radius:50%;background:#fff;color:#c00;border:1.5px solid #c00;font-size:6.5pt;font-weight:700;display:flex;align-items:center;justify-content:center}
.tag{background:rgba(11,21,36,.85);color:#fff;font-size:7.5pt;padding:.6mm 1.5mm}
.tag.tl{position:absolute;left:2mm;top:2mm}
.inset{position:absolute;right:3mm;top:15mm;width:52mm;height:40mm;border:1.5px solid #fff;background:#000}
.inset img{width:100%;height:100%;object-fit:cover}
.inset .tag{position:absolute;left:0;top:0}
.legend{position:absolute;left:0;right:0;bottom:0;background:rgba(11,21,36,.88);color:#fff;font-size:7.5pt;display:flex;flex-wrap:wrap;gap:3mm;align-items:center;padding:1.2mm 3mm 1.2mm 30mm}
.legend i{display:inline-block;width:3.5mm;height:3mm;margin-right:1mm;vertical-align:-0.5mm;border:1px solid rgba(255,255,255,.6)}
.legend i.line{border:1px dashed #fff;background:transparent}
.legend i.dot{width:3.5mm;height:3.5mm;border-radius:50%;background:#fff;color:#c00;font-style:normal;font-size:6pt;text-align:center;line-height:3.3mm;border:1px solid #c00}
.legend .muted{opacity:.75}
.lim{margin:0;padding-left:5mm;font-size:9pt;line-height:1.45}
.bar-top{position:sticky;top:0;z-index:5;background:#0b1524;color:#fff;padding:8px 14px;font:14px 'Sarabun',sans-serif;display:flex;gap:12px;align-items:center}
.bar-top button{background:#22d3ee;border:0;border-radius:6px;padding:6px 14px;font-weight:700;cursor:pointer}
</style></head><body>
<div class="bar-top"><button onclick="window.print()">${L('บันทึกเป็น PDF / พิมพ์', 'Save as PDF / Print')}</button><span>${L('เลือกปลายทาง “บันทึกเป็น PDF” · ขนาดหน้า 16:9 · เปิด “กราฟิกพื้นหลัง”', 'Choose “Save as PDF” · 16:9 pages · enable “Background graphics”')}</span></div>
${pages.join('\n')}
</body></html>`;
}

export function hotspotsCsv(items: { aoi: MonitorAoi; run: MonitorRun | undefined }[]) {
  const head = 'aoi,aoi_name,run_date,before_scene,after_scene,sensor,patch,lat,lon,area_ha,area_rai,class,level,confidence';
  const rows: string[] = [];
  items.forEach(({ aoi, run }, i) => {
    if (!run || run.status !== 'ok') {
      rows.push([i + 1, `"${aoi.name}"`, run?.at ?? '', '', '', '', '', '', '', '', '', '', run ? 'insufficient' : 'not_run', ''].join(','));
      return;
    }
    (run.hotspots ?? []).forEach((h) =>
      rows.push([i + 1, `"${aoi.name}"`, run.at, run.A?.id, run.B?.id, run.sensor, h.n, h.lat.toFixed(6), h.lon.toFixed(6), h.areaHa.toFixed(3), (h.areaHa * 6.25).toFixed(1), `"${run.legend?.find((l) => l.id === h.cls)?.label ?? h.cls}"`, run.level, run.confidence].join(',')),
    );
    if (!run.hotspots?.length) rows.push([i + 1, `"${aoi.name}"`, run.at, run.A?.id, run.B?.id, run.sensor, '', '', '', '0', '0', '', run.level, run.confidence].join(','));
  });
  return '﻿' + head + '\n' + rows.join('\n');
}

export function resultsGeoJson(items: { aoi: MonitorAoi; run: MonitorRun | undefined }[]) {
  const features: any[] = [];
  items.forEach(({ aoi, run }, i) => {
    features.push({
      type: 'Feature',
      geometry: aoi.geometry,
      properties: { aoi: i + 1, name: aoi.name, region: aoi.region, purpose: aoi.purpose, run_at: run?.at, status: run?.status ?? 'not_run', reason: run?.reason, level: run?.level, confidence: run?.confidence, detected_ha: run?.stats ? run.stats.interestKm2 * 100 : null, valid_km2: run?.stats?.validKm2, before: run?.A?.id, after: run?.B?.id, method: run?.method },
    });
    run?.hotspots?.forEach((h) => features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [h.lon, h.lat] }, properties: { aoi: i + 1, patch: h.n, area_ha: +h.areaHa.toFixed(3), class: h.cls } }));
  });
  return { type: 'FeatureCollection', features };
}
