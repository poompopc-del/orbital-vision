// Parse and format geographic coordinates typed or pasted by people.
// Accepts degrees-minutes (11°34.2819'N, 104°40.8893'E), degrees-minutes-seconds
// (11°34'16.9"N 104°40'53.4"E), leading hemispheres (N 11 34.2819 E 104 40.8893) and
// plain decimals (11.571365, 104.681488 — latitude first, as Google Maps copies them).

export interface LatLon {
  lat: number;
  lon: number;
}

export type ParseResult = { ok: true; value: LatLon } | { ok: false; error: string };

interface Part {
  hemi?: string;
  leading: boolean;
  closed: boolean;
  nums: (number | undefined)[];
  negative: boolean;
}

const normalise = (s: string) =>
  s
    .replace(/[º˚]/g, '°')
    .replace(/[′’‘`´]/g, "'")
    .replace(/[″“”]/g, '"')
    .replace(/''/g, '"')
    .replace(/\b(lat|lon|lng|latitude|longitude)\b\s*[:=]?/gi, ' ');

/** Parse one coordinate pair. Errors are in Thai (shown in the UI as-is). */
export function parseCoord(text: string): ParseResult {
  const s = normalise(text.trim());
  if (!s) return { ok: false, error: 'ยังไม่ได้ใส่พิกัด' };
  const parts: Part[] = [];
  let cur: Part | null = null;
  const re = /(-?\d+(?:\.\d+)?)\s*([°'"])?|([NSEWnsew])(?![a-zA-Z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[3]) {
      const h = m[3].toUpperCase();
      if (cur && !cur.closed && cur.nums.some((x) => x !== undefined) && !cur.hemi && !cur.leading) {
        cur.hemi = h; // trailing hemisphere: 11°34'N
        cur.closed = true;
      } else {
        cur = { hemi: h, leading: true, closed: false, nums: [], negative: false };
        parts.push(cur);
      }
      continue;
    }
    const raw = m[1];
    const mark = m[2] ?? '';
    const n = Math.abs(parseFloat(raw));
    const has = cur ? cur.nums.some((x) => x !== undefined) : false;
    const startNew = !cur || cur.closed || (has && mark === '°') || (has && mark === '' && !cur.leading) || (cur.nums.length >= 3 && mark === '');
    if (startNew) {
      cur = { leading: false, closed: false, nums: [], negative: false };
      parts.push(cur);
    }
    const c = cur!;
    const slot = mark === '°' ? 0 : mark === "'" ? 1 : mark === '"' ? 2 : c.nums.length;
    if (slot > 2 || c.nums[slot] !== undefined) return { ok: false, error: `อ่านพิกัดไม่ได้ตรงตัวเลข ${raw}` };
    c.nums[slot] = n;
    if (raw.startsWith('-') && slot === 0) c.negative = true;
  }
  const used = parts.filter((p) => p.nums.some((x) => x !== undefined));
  if (used.length !== 2) return { ok: false, error: used.length < 2 ? 'ต้องมีพิกัด 2 ค่า (ละติจูดและลองจิจูด)' : 'มีตัวเลขมากเกินไป — ใส่ได้ 1 จุดต่อบรรทัด' };
  const vals: { v: number; hemi?: string }[] = [];
  for (const p of used) {
    const [d = 0, mi = 0, se = 0] = p.nums;
    if (mi >= 60 || se >= 60) return { ok: false, error: 'ลิปดา/ฟิลิปดาต้องน้อยกว่า 60' };
    if (p.nums[0] === undefined) return { ok: false, error: 'ไม่พบค่าองศา' };
    let v = d + mi / 60 + se / 3600;
    if (p.negative || p.hemi === 'S' || p.hemi === 'W') v = -v;
    vals.push({ v, hemi: p.hemi });
  }
  let lat: number, lon: number;
  const isLat = (h?: string) => h === 'N' || h === 'S';
  const isLon = (h?: string) => h === 'E' || h === 'W';
  if (isLon(vals[0].hemi) || isLat(vals[1].hemi)) [lon, lat] = [vals[0].v, vals[1].v];
  else [lat, lon] = [vals[0].v, vals[1].v];
  if ((isLat(vals[0].hemi) && isLat(vals[1].hemi)) || (isLon(vals[0].hemi) && isLon(vals[1].hemi))) return { ok: false, error: 'ต้องมีละติจูด (N/S) 1 ค่า และลองจิจูด (E/W) 1 ค่า' };
  if (Math.abs(lat) > 90) return { ok: false, error: `ละติจูด ${lat.toFixed(4)} เกิน ±90 — ใส่ละติจูดก่อนลองจิจูด หรือใส่ N/E กำกับ` };
  if (Math.abs(lon) > 180) return { ok: false, error: `ลองจิจูด ${lon.toFixed(4)} เกิน ±180` };
  return { ok: true, value: { lat: +lat.toFixed(7), lon: +lon.toFixed(7) } };
}

const dmm = (v: number, pos: string, neg: string) => {
  const a = Math.abs(v);
  let d = Math.floor(a);
  let m = +((a - d) * 60).toFixed(4);
  if (m >= 60) {
    d += 1;
    m = 0;
  }
  return `${d}°${m.toFixed(4)}'${v < 0 ? neg : pos}`;
};

/** 11°34.2819'N, 104°40.8893'E */
export const formatDMM = (p: LatLon) => `${dmm(p.lat, 'N', 'S')}, ${dmm(p.lon, 'E', 'W')}`;
/** 11.571365, 104.681488 */
export const formatDec = (p: LatLon) => `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;

/** Square of `sizeKm` × `sizeKm` centred on the point. */
export function squareAround(p: LatLon, sizeKm: number): GeoJSON.Polygon {
  const h = sizeKm / 2;
  const dLat = h / 110.574;
  const dLon = h / (111.32 * Math.cos((p.lat * Math.PI) / 180));
  const r = (x: number) => +x.toFixed(6);
  const w = r(p.lon - dLon), e = r(p.lon + dLon), s = r(p.lat - dLat), n = r(p.lat + dLat);
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}
