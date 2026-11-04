// Alert email: a short report readable on a phone — what changed, where, the before / after /
// change images, the week / month / year comparisons, and a link back to the website.
import { hotspotKm2, narrative, PURPOSES, REGIONS, type MonitorRun } from '../../src/lib/monitor';

export interface HorizonResult {
  horizon: 'confirmed' | 'latest' | 'week' | 'month' | 'year';
  run: MonitorRun;
  images: Record<string, string>;
  /** the images as data URLs (kept in memory for this run, so the email can carry them inline) */
  raw?: Record<string, string>;
  /** database id of this comparison (for links back to the website) */
  id?: string;
}

const H_TH: Record<HorizonResult['horizon'], string> = { confirmed: 'ยืนยันแล้ว (ภาพก่อนเปลี่ยน → ภาพล่าสุด)', latest: 'ล่าสุด (เทียบภาพที่ใช้ได้ก่อนหน้า)', week: '1 สัปดาห์', month: '1 เดือน', year: '1 ปี' };
const LV_TH: Record<string, string> = { significant: 'เปลี่ยนแปลงมีนัยสำคัญ', minor: 'เปลี่ยนแปลงเล็กน้อย', none: 'ไม่พบการเปลี่ยนแปลงเกินเกณฑ์' };
const LV_COLOR: Record<string, string> = { significant: '#d0705f', minor: '#d5aa69', none: '#8fb98a' };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const d10 = (s?: string) => (s ? s.slice(0, 10) : '—');
const rai = (km2: number) => Math.round(km2 * 625).toLocaleString('en-US');

export function alertSubject(areaName: string, r: MonitorRun) {
  return `[Orbital Vision] ${LV_TH[r.level ?? 'none']}: ${areaName} · ภาพ ${d10(r.B?.datetime)}`;
}

export interface AlertItem { areaName: string; region: string; purpose: string; areaUrl: string; results: HorizonResult[] }

const FOOT = `<p style="font-size:11px;color:#6f7875;line-height:1.5">ผลวิเคราะห์อัตโนมัติจากภาพดาวเทียมแบบเปิด (Copernicus Sentinel-2 ผ่าน Microsoft Planetary Computer) ยังไม่ผ่านการตรวจสอบภาคพื้นดิน ใช้ประกอบการตัดสินใจเท่านั้น · พื้นที่ที่มีเมฆหรือไม่มีข้อมูลไม่ถูกนับเป็นการเปลี่ยนแปลง</p>`;
const wrap = (inner: string) => `<!doctype html><html><body style="margin:0;background:#141719;color:#e6e9e7;font-family:'IBM Plex Sans Thai',Sarabun,Arial,sans-serif">
<div style="max-width:720px;margin:0 auto;padding:20px">
  <div style="font-size:11px;letter-spacing:2px;color:#91a58d">ORBITAL VISION · เฝ้าระวังพื้นที่อัตโนมัติ</div>
  ${inner}
  ${FOOT}
</div></body></html>`;
const primary = (o: AlertItem) => o.results.find((x) => x.horizon === 'confirmed') ?? o.results.find((x) => x.horizon === 'latest') ?? o.results[0];
const rank = (o: AlertItem) => {
  const r = primary(o).run;
  return (r.level === 'significant' ? 2 : r.level === 'minor' ? 1 : 0) * 1e6 + (r.stats?.interestKm2 ?? 0);
};

export function digestSubject(items: AlertItem[]) {
  const sig = items.filter((o) => primary(o).run.level === 'significant').length;
  return `[Orbital Vision] ภาพใหม่ ${items.length} พื้นที่${sig ? ` · มีนัยสำคัญ ${sig}` : ''}`;
}

/** One email for every area that changed in this run: a table of all of them, then full reports of the top ones. */
export function digestEmail(items: AlertItem[], listUrl: string): string {
  const sorted = [...items].sort((a, b) => rank(b) - rank(a));
  const rows = sorted.map((o) => {
    const r = primary(o).run;
    return `<tr><td style="padding:4px 8px"><a href="${o.areaUrl}" style="color:#e6e9e7">${esc(o.areaName)}</a></td>
      <td style="padding:4px 8px;color:${LV_COLOR[r.level ?? 'none']}">${LV_TH[r.level ?? 'none']}</td>
      <td style="padding:4px 8px;text-align:right">${r.stats ? `${r.stats.interestKm2.toFixed(3)} ตร.กม.` : '—'}</td>
      <td style="padding:4px 8px;font-family:monospace">${d10(r.A?.datetime)} → ${d10(r.B?.datetime)}</td></tr>`;
  }).join('');
  const TOP = 8;
  const top = sorted.slice(0, TOP).map((o) => `<div style="margin-top:28px;padding-top:14px;border-top:1px solid #343b3f">${section(o)}</div>`).join('');
  return wrap(`<h1 style="font-size:20px;margin:6px 0 10px;color:#fff">ภาพใหม่ ${items.length} พื้นที่</h1>
  <table style="width:100%;border-collapse:collapse;font-size:13px;background:#1b2023">${rows}</table>
  ${items.length > TOP ? `<p style="font-size:12px;color:#939d9a">รายละเอียดด้านล่างแสดง ${TOP} พื้นที่ที่เปลี่ยนแปลงมากที่สุด · <a href="${listUrl}" style="color:#91a58d">ดูทั้งหมดในเว็บ</a></p>` : ''}
  ${top}`);
}

export function alertEmail(o: AlertItem): string {
  return wrap(section(o));
}

function section(o: AlertItem): string {
  const latest = primary(o);
  const sep = o.areaUrl.includes('?') ? '&' : '?';
  const saved = (o.results.find((x) => x.horizon === 'latest') ?? latest).id;
  const HL: Record<HorizonResult['horizon'], string> = { confirmed: 'ยืนยันแล้ว', latest: 'ภาพก่อนหน้า', week: '1 สัปดาห์', month: '1 เดือน', year: '1 ปี' };
  // a link that carries everything the page needs (scenes, result, spots), so it works on its own
  const link = (x: HorizonResult, extra = '') => {
    const rr = x.run;
    const hs = (rr.hotspots ?? []).slice(0, 8).map((h) => `${h.lat.toFixed(5)},${h.lon.toFixed(5)}`).join(';');
    const q = [
      saved ? `run=${saved}` : '', `hz=${x.horizon === 'confirmed' ? 'latest' : x.horizon}`, 'view=swipe',
      rr.A ? `a=${encodeURIComponent(`${rr.A.collection}:${rr.A.id}`)}` : '', rr.B ? `b=${encodeURIComponent(`${rr.B.collection}:${rr.B.id}`)}` : '',
      `hl=${encodeURIComponent(HL[x.horizon])}`, rr.level ? `lv=${rr.level}` : '', rr.stats ? `km2=${rr.stats.interestKm2.toFixed(3)}` : '',
      hs ? `hs=${encodeURIComponent(hs)}` : '', extra,
    ].filter(Boolean).join('&');
    return `${o.areaUrl}${sep}${q}`;
  };
  const show = (h: HorizonResult['horizon']) => link(o.results.find((x) => x.horizon === h) ?? latest);
  const at = (lat: number, lon: number) => link(latest, `pt=${lat.toFixed(5)},${lon.toFixed(5)}`);
  const r = latest.run;
  const lines = narrative(r, 'th');
  const purpose = PURPOSES.find((p) => p.id === o.purpose)?.labelTh ?? o.purpose;
  const region = REGIONS.find((x) => x.id === o.region)?.labelTh ?? o.region;
  const img = (src: string | undefined, cap: string) =>
    src ? `<td style="padding:4px;vertical-align:top;width:33%"><img src="${src}" alt="${esc(cap)}" style="width:100%;border:1px solid #343b3f;display:block"><div style="font-size:12px;color:#939d9a;margin-top:4px">${esc(cap)}</div></td>` : '';
  const spots = (r.hotspots ?? []).slice(0, 8).map((h) =>
    `<tr><td style="padding:4px 8px">${h.n}</td><td style="padding:4px 8px;color:#939d9a">${h.shape === 'linear' ? `แนวยาว ~${Math.round((h.lengthKm ?? 0) * 1000)} ม. (อาจเป็นถนน/ทาง)` : 'ผืน (ลานดิน/ที่โล่ง/สิ่งปลูกสร้าง)'}</td><td style="padding:4px 8px;font-family:monospace">${h.lat.toFixed(5)}, ${h.lon.toFixed(5)}</td><td style="padding:4px 8px;text-align:right">${hotspotKm2(h).toFixed(3)} ตร.กม. (${rai(hotspotKm2(h))} ไร่)</td><td style="padding:4px 8px;white-space:nowrap"><a href="${at(h.lat, h.lon)}" style="color:#91a58d">ดูในเว็บ</a> · <a href="https://www.google.com/maps?q=${h.lat},${h.lon}" style="color:#939d9a">Google Maps</a></td></tr>`).join('');
  const horizons = o.results.map((x) => {
    const rr = x.run;
    const ok = rr.status === 'ok';
    return `<tr>
      <td style="padding:4px 8px">${H_TH[x.horizon]}</td>
      <td style="padding:4px 8px;font-family:monospace">${d10(rr.A?.datetime)} → ${d10(rr.B?.datetime)}</td>
      <td style="padding:4px 8px;color:${ok ? LV_COLOR[rr.level ?? 'none'] : '#939d9a'}">${ok ? LV_TH[rr.level ?? 'none'] : 'ข้อมูลไม่พอ'}</td>
      <td style="padding:4px 8px;text-align:right">${ok && rr.stats ? `${rr.stats.interestKm2.toFixed(3)} ตร.กม.` : '—'}</td>
      <td style="padding:4px 8px;text-align:right">${ok ? `<a href="${show(x.horizon)}" style="display:inline-block;padding:3px 10px;text-decoration:none;font-weight:600;${rr.level === 'significant' ? 'background:#d0705f;color:#141719' : 'border:1px solid #91a58d;color:#91a58d'}">แสดง</a>` : ''}</td></tr>`;
  }).join('');
  return `<h1 style="font-size:20px;margin:6px 0 2px;color:#fff">${esc(o.areaName)}</h1>
  <div style="font-size:13px;color:#939d9a">${esc(region)} · ${esc(purpose)}</div>
  <div style="margin:14px 0;padding:10px 12px;border-left:4px solid ${LV_COLOR[r.level ?? 'none']};background:#1b2023">
    <div style="font-size:16px;font-weight:600;color:${LV_COLOR[r.level ?? 'none']}">${LV_TH[r.level ?? 'none']}</div>
    ${lines.map((l) => `<div style="font-size:14px;margin-top:4px">${esc(l)}</div>`).join('')}
  </div>
  <table style="width:100%;border-collapse:collapse"><tr>
    ${img(latest.images.before, `ก่อน · ${d10(r.A?.datetime)}`)}${img(latest.images.after, `หลัง · ${d10(r.B?.datetime)}`)}${img(latest.images.change, 'ผลการเปลี่ยนแปลง')}
  </tr></table>
  ${spots ? `<h2 style="font-size:15px;margin:18px 0 6px">จุดที่ตรวจพบ</h2><table style="width:100%;border-collapse:collapse;font-size:13px;background:#1b2023">${spots}</table>` : ''}
  <h2 style="font-size:15px;margin:18px 0 6px">เทียบย้อนหลัง</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;background:#1b2023">${horizons}</table>
  <p style="margin:18px 0"><a href="${show(latest.horizon)}" style="display:inline-block;background:#91a58d;color:#141719;padding:10px 16px;text-decoration:none;font-weight:600">ดูภาพก่อน–หลังบนแผนที่</a>
  <a href="${o.areaUrl}" style="display:inline-block;margin-left:8px;border:1px solid #91a58d;color:#91a58d;padding:9px 14px;text-decoration:none">เปิดพื้นที่ / พิมพ์รายงาน PDF</a></p>
  <p style="font-size:12px;color:#939d9a;margin-top:-8px">“แสดง” จะเปิดเว็บ ซูมไปที่พื้นที่ และเปิดการเลื่อนเทียบภาพก่อน/หลัง (กด “A ก่อน” / “B หลัง” เพื่อสลับดูทีละภาพ)</p>`;
}
