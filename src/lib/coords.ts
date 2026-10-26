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

// ---------------------------------------------------------------- tables (QGIS / Excel paste, CSV, GeoJSON)

export interface PointRow {
  /** original text of the row, for messages */
  line: string;
  name: string;
  r: ParseResult;
}

/** One coordinate value that names its hemisphere, e.g. 11°34.2819'N or 104° 40.8893' E. */
export function parseOne(cell: string): { v: number; axis: 'lat' | 'lon' } | null {
  const s = normalise(cell).trim();
  const m = s.match(/^([NSEW])?\s*(-?\d+(?:\.\d+)?)\s*°?\s*(?:(\d+(?:\.\d+)?)\s*'?\s*)?(?:(\d+(?:\.\d+)?)\s*"?\s*)?([NSEW])?$/i);
  if (!m) return null;
  const h = (m[1] || m[5] || '').toUpperCase();
  if (!h || (m[1] && m[5])) return null; // a lone number is not a coordinate
  const d = Math.abs(+m[2]), mi = m[3] ? +m[3] : 0, se = m[4] ? +m[4] : 0;
  if (mi >= 60 || se >= 60) return null;
  let v = d + mi / 60 + se / 3600;
  if (h === 'S' || h === 'W' || m[2].startsWith('-')) v = -v;
  const axis = h === 'N' || h === 'S' ? 'lat' : 'lon';
  if ((axis === 'lat' && Math.abs(v) > 90) || Math.abs(v) > 180) return null;
  return { v: +v.toFixed(7), axis };
}

const WKT_POINT = /POINT\s*Z?M?\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/i;

/** Split delimited text into rows of cells; a cell is quoted only when it starts with a quote. */
export function splitRows(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const n = text.length;
  while (i <= n) {
    let cell = '';
    if (text[i] === '"') {
      i++;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        cell += text[i++];
      }
      while (i < n && text[i] !== delim && text[i] !== '\n' && text[i] !== '\r') cell += text[i++];
    } else while (i < n && text[i] !== delim && text[i] !== '\n' && text[i] !== '\r') cell += text[i++];
    row.push(cell.trim());
    if (i >= n || text[i] !== delim) {
      if (row.some((c) => c)) rows.push(row);
      row = [];
      if (text[i] === '\r' && text[i + 1] === '\n') i++;
    }
    i++;
  }
  return rows;
}

const isNull = (c: string) => !c || /^(null|nan|none|-|—)$/i.test(c);

/**
 * Rows of a table → points. In each row the LAST latitude-like cell and the LAST longitude-like
 * cell are used (so later "corrected" columns win), else a WKT POINT. The name is made from the
 * first two other non-empty cells. A first row without coordinates is treated as the header.
 */
export function parseTable(text: string, delim?: string): { rows: PointRow[]; header: string[] | null } {
  const d = delim ?? (text.includes('\t') ? '\t' : (text.split(';').length > text.split(',').length ? ';' : ','));
  const rows = splitRows(text, d);
  const out: PointRow[] = [];
  let header: string[] | null = null;
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i];
    let lat: number | null = null, lon: number | null = null;
    const coordIdx = new Set<number>();
    for (let k = 0; k < cells.length; k++) {
      const p = parseOne(cells[k]);
      if (!p) continue;
      coordIdx.add(k);
      if (p.axis === 'lat') lat = p.v;
      else lon = p.v;
    }
    if (lat == null || lon == null) {
      const k = cells.findIndex((c) => WKT_POINT.test(c));
      if (k >= 0) {
        const m = cells[k].match(WKT_POINT)!;
        lon = +m[1];
        lat = +m[2];
        coordIdx.add(k);
      }
    }
    // plain decimal columns: a "lat"/"lon" header, or exactly two numeric cells
    if ((lat == null || lon == null) && header) {
      const li = header.findIndex((h) => /^(lat|latitude|y|lati)$/i.test(h)), oi = header.findIndex((h) => /^(lon|lng|long|longitude|x|lonti)$/i.test(h));
      if (li >= 0 && oi >= 0 && Number.isFinite(parseFloat(cells[li])) && Number.isFinite(parseFloat(cells[oi]))) {
        lat = parseFloat(cells[li]);
        lon = parseFloat(cells[oi]);
        coordIdx.add(li).add(oi);
      }
    }
    const nameCells = cells.filter((c, k) => !coordIdx.has(k) && !isNull(c) && !WKT_POINT.test(c) && parseOne(c) == null);
    const name = nameCells.slice(0, 2).join(' ').replace(/\s+/g, ' ').slice(0, 80);
    const line = cells.filter((c) => !isNull(c)).join(' · ').slice(0, 120);
    if (lat == null || lon == null) {
      if (i === 0) header = cells;
      else out.push({ line, name, r: { ok: false, error: 'ไม่พบพิกัดในแถวนี้' } });
      continue;
    }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) out.push({ line, name, r: { ok: false, error: 'พิกัดเกินช่วง' } });
    else out.push({ line, name, r: { ok: true, value: { lat, lon } } });
  }
  return { rows: out, header };
}

/** GeoJSON (QGIS “Save Features As → GeoJSON”) → points. Name from Area/TGT/name properties. */
export function parseGeoJson(text: string): PointRow[] {
  const j = JSON.parse(text);
  const feats: any[] = j.type === 'FeatureCollection' ? j.features : j.type === 'Feature' ? [j] : [];
  const out: PointRow[] = [];
  for (const f of feats) {
    const p = f.properties ?? {};
    const keys = ['Area', 'area', 'TGT', 'tgt', 'name', 'Name', 'NAME', 'title'];
    const name = keys.map((k) => p[k]).filter((v) => v != null && !isNull(String(v))).slice(0, 2).join(' ').slice(0, 80);
    const g = f.geometry;
    const c = g?.type === 'Point' ? g.coordinates : g?.type === 'MultiPoint' ? g.coordinates[0] : null;
    if (!c) {
      out.push({ line: name || '(feature)', name, r: { ok: false, error: 'ไม่ใช่จุด (Point)' } });
      continue;
    }
    out.push({ line: name || `${c[1]}, ${c[0]}`, name, r: Math.abs(c[1]) <= 90 && Math.abs(c[0]) <= 180 ? { ok: true, value: { lat: +c[1], lon: +c[0] } } : { ok: false, error: 'พิกัดเกินช่วง (ไฟล์ต้องเป็น EPSG:4326)' } });
  }
  return out;
}

/** Text typed or pasted into the box: a table if it has tabs, otherwise one "name | coordinates" per line. */
export function parsePointsText(text: string): PointRow[] {
  if (text.includes('\t')) return parseTable(text, '\t').rows;
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf('|');
      return { line: l, name: i >= 0 ? l.slice(0, i).trim() : '', r: parseCoord(i >= 0 ? l.slice(i + 1).trim() : l) };
    });
}
