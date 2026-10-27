// Import many coordinates / areas at once from the files people actually have:
//   CSV · TSV · TXT (Excel exports in UTF-8, UTF-16 or Thai Windows-874), Excel .xlsx, GeoJSON / JSON,
//   KML · KMZ (Google Earth / My Maps), GPX (GPS units, phone apps), ESRI Shapefile (.zip or .shp+.dbf+.prj),
//   WKT, and plain pasted text — one place per line in decimal degrees, degrees-minutes-seconds,
//   UTM ("47P 668000 1520000"), or a Google Maps link.
// Projected data (UTM WGS84 / Indian 1975, Web Mercator) is converted to WGS84 lon/lat.
// Nothing here touches the DOM, so it runs (and is tested) outside the browser too.

import { crsFromText, crsLabel, toWgs84, type Crs } from './projection';
import { isZip, unzip } from './zip';

export type Msg = { th: string; en: string };
export type PlaceKind = 'point' | 'polygon' | 'line';
export interface ImportedPlace {
  id: string;
  name: string;
  kind: PlaceKind;
  /** The point itself, or the centre of the shape's bounding box. */
  lon: number;
  lat: number;
  /** Polygon outer ring (closed) or line vertices, WGS84 [lon, lat]. */
  ring?: [number, number][];
  /** Box size (km) given for this row in the file — points only. */
  sizeKm?: number;
  /** File (and sheet / layer) it came from. */
  source: string;
}
export interface ImportOptions {
  /** UTM zone for UTM values that come without one (Thailand: 47 west of 102°E, 48 east of it). */
  utmZone?: number;
  utmNorth?: boolean;
}
export interface ImportResult {
  places: ImportedPlace[];
  warnings: Msg[];
  /** Rows / features that held something but could not be read as a coordinate. */
  skipped: number;
  /** Formats recognised, e.g. "CSV", "KML". */
  formats: string[];
  /** Some UTM values had no zone, so `utmZone` was assumed. */
  usedDefaultZone: boolean;
}
export interface InputFile { name: string; bytes: Uint8Array }

export const ACCEPT = '.csv,.tsv,.txt,.xlsx,.json,.geojson,.kml,.kmz,.gpx,.zip,.shp,.dbf,.prj,.cpg,.wkt';
const MAX_PLACES = 5000;
const MAX_VERTICES = 1000;

// ---------------------------------------------------------------- collector

let seq = 0;
const newId = () => `imp_${Date.now().toString(36)}_${(seq++).toString(36)}`;

type Raw = { name: string; kind: PlaceKind; coords: [number, number][]; size?: number; /** separate line parts / rings, kept for boundary import */ parts?: [number, number][][] };

class Ctx {
  places: ImportedPlace[] = [];
  warnings: Msg[] = [];
  skipped = 0;
  formats = new Set<string>();
  usedDefaultZone = false;
  private seen = new Set<string>();
  private dup = 0;
  private skipRefs: string[] = [];
  constructor(public opts: Required<ImportOptions>) {}

  warn(th: string, en: string) {
    if (!this.warnings.some((w) => w.en === en)) this.warnings.push({ th, en });
  }
  skip(ref: string) {
    this.skipped++;
    if (this.skipRefs.length < 6) this.skipRefs.push(ref);
  }
  /** Add a place already in WGS84. Returns false when it was rejected. */
  add(source: string, r: Raw): boolean {
    if (this.places.length >= MAX_PLACES) {
      this.warn(`นำเข้าได้สูงสุด ${MAX_PLACES.toLocaleString()} รายการต่อครั้ง ส่วนที่เกินถูกตัดออก`, `At most ${MAX_PLACES.toLocaleString()} places per import — the rest were dropped`);
      return false;
    }
    let coords = r.coords.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (!coords.length || coords.some(([x, y]) => Math.abs(x) > 180 || Math.abs(y) > 90)) return false;
    coords = coords.map(([x, y]) => [round7(x), round7(y)]);
    let kind = r.kind;
    if (kind === 'polygon') {
      if (coords.length && !samePt(coords[0], coords[coords.length - 1])) coords.push(coords[0]);
      if (coords.length < 4) kind = coords.length === 1 ? 'point' : 'line';
    }
    if (kind === 'line' && coords.length === 1) kind = 'point';
    if (coords.length > MAX_VERTICES) coords = thin(coords, MAX_VERTICES, kind === 'polygon');
    const key = kind === 'point' ? `p${coords[0][0].toFixed(6)},${coords[0][1].toFixed(6)}` : `${kind}${coords.length}:${coords[0].join()}:${coords[coords.length >> 1].join()}`;
    if (this.seen.has(key)) {
      this.dup++;
      return true;
    }
    this.seen.add(key);
    let lon: number, lat: number;
    if (kind === 'point') [lon, lat] = coords[0];
    else {
      const b = bbox(coords);
      lon = round7((b[0] + b[2]) / 2);
      lat = round7((b[1] + b[3]) / 2);
    }
    const size = r.size && r.size > 0 && r.size <= 200 ? r.size : undefined;
    this.places.push({ id: newId(), name: r.name.trim() || '', kind, lon, lat, ring: kind === 'point' ? undefined : coords, sizeKm: kind === 'point' ? size : undefined, source });
    return true;
  }
  result(): ImportResult {
    // unnamed places get "<file> 1, 2, …" in file order
    const counters = new Map<string, number>();
    for (const p of this.places) {
      if (p.name) continue;
      const base = p.source.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim() || 'Point';
      const n = (counters.get(base) ?? 0) + 1;
      counters.set(base, n);
      p.name = `${base} ${n}`;
    }
    if (this.dup) this.warn(`ข้ามพิกัดซ้ำ ${this.dup} รายการ`, `${this.dup} duplicate place(s) skipped`);
    if (this.skipped)
      this.warn(
        `อ่านพิกัดไม่ได้ ${this.skipped} แถว/รายการ (เช่น ${this.skipRefs.join(', ')}) — ตรวจว่ามีทั้งละติจูดและลองจิจูด และอยู่ในช่วงที่ถูกต้อง`,
        `${this.skipped} row(s)/item(s) had no readable coordinate (e.g. ${this.skipRefs.join(', ')}) — check both latitude and longitude are present and in range`,
      );
    return { places: this.places, warnings: this.warnings, skipped: this.skipped, formats: [...this.formats], usedDefaultZone: this.usedDefaultZone };
  }
}

const round7 = (v: number) => Math.round(v * 1e7) / 1e7;
const samePt = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1];
function thin(c: [number, number][], max: number, closed: boolean): [number, number][] {
  const step = Math.ceil(c.length / max);
  const out = c.filter((_, i) => i % step === 0);
  if (closed && !samePt(out[0], out[out.length - 1])) out.push(out[0]);
  else if (!closed && !samePt(out[out.length - 1], c[c.length - 1])) out.push(c[c.length - 1]);
  return out;
}
export function bbox(c: [number, number][]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of c) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

/** Hand projected features to the collector, converting with the file's CRS or a stated guess. */
function emit(ctx: Ctx, source: string, feats: Raw[], crs: Crs | null) {
  if (!feats.length) return;
  let c = crs;
  if (!c) {
    const all = feats.flatMap((f) => f.coords);
    const geo = all.every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90);
    if (geo) c = { kind: 'geo', datum: 'wgs84' };
    else if (all.some(([x]) => Math.abs(x) > 1_000_000)) {
      c = { kind: 'merc' };
      ctx.warn(`${source}: ไม่ระบุระบบพิกัด ค่ามีขนาดใหญ่ จึงถือว่าเป็น Web Mercator (EPSG:3857) — ตรวจตำแหน่งบนแผนที่ก่อนเพิ่ม`, `${source}: no coordinate system given and values are large — read as Web Mercator (EPSG:3857). Check the positions on the map before adding.`);
    } else {
      c = { kind: 'utm', zone: ctx.opts.utmZone, north: ctx.opts.utmNorth, datum: 'wgs84' };
      ctx.usedDefaultZone = true;
      ctx.warn(`${source}: ไม่ระบุระบบพิกัด ค่าดูเหมือน UTM จึงใช้โซน ${ctx.opts.utmZone}${ctx.opts.utmNorth ? 'N' : 'S'} (WGS84) — เปลี่ยนโซนได้ด้านล่าง`, `${source}: no coordinate system given and values look like UTM — zone ${ctx.opts.utmZone}${ctx.opts.utmNorth ? 'N' : 'S'} (WGS84) assumed; change the zone below if needed.`);
    }
  } else if (c.kind !== 'geo' || c.datum !== 'wgs84') {
    ctx.warn(`${source}: แปลงจาก ${crsLabel(c)} เป็น WGS84`, `${source}: converted from ${crsLabel(c)} to WGS84`);
  }
  const cc = c;
  let bad = 0;
  feats.forEach((f, i) => {
    const coords = cc.kind === 'geo' && cc.datum === 'wgs84' ? f.coords : f.coords.map(([x, y]) => toWgs84(x, y, cc));
    if (!ctx.add(source, { ...f, coords })) {
      bad++;
      ctx.skip(`${source} #${i + 1}`);
    }
  });
  if (bad && bad === feats.length && cc.kind === 'geo')
    ctx.warn(`${source}: ค่าพิกัดอยู่นอกช่วงละติจูด/ลองจิจูด — ไฟล์อาจใช้ระบบพิกัดอื่น`, `${source}: values are outside latitude/longitude range — the file may use another coordinate system`);
}

// ---------------------------------------------------------------- text decoding

export function decodeText(b: Uint8Array): string {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-874').decode(b); // Thai Excel "CSV" (ANSI)
  }
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function xmlText(s: string | undefined): string {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m))
    .replace(/\s+/g, ' ')
    .trim();
}
const tagRe = (tag: string, flags = 'g') => new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, flags);
const firstTag = (s: string, tag: string) => s.match(tagRe(tag, ''))?.[1];
const attr = (s: string, name: string) => s.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`))?.[1];

// ---------------------------------------------------------------- angles & free-text coordinates

// length-preserving, so match positions still index the original text
const normalizeMarks = (s: string) => s.replace(/[′’‘`´]/g, "'").replace(/[″”“]/g, '"').replace(/''/g, '" ').replace(/[º˚]/g, '°').replace(/\u00a0/g, ' ');

/** One angle from a table cell: 13.7563 · -13,7563 · 13°45'22.7"N · N 13 45 22.7 · 100d30m15s E · 13:45:22 */
export function parseAngle(raw: string): { v: number; hemi?: 'N' | 'S' | 'E' | 'W' } | null {
  let s = normalizeMarks(String(raw ?? '')).trim();
  if (!s) return null;
  if (/^[-+]?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  let hemi: 'N' | 'S' | 'E' | 'W' | undefined;
  const h = s.match(/^([NSEW])\s*|\s*([NSEW])$/); // upper case only: a trailing "s" is seconds
  if (h) {
    hemi = (h[1] ?? h[2]).toUpperCase() as typeof hemi;
    s = s.replace(h[0], '').trim();
  }
  let neg = false;
  if (/^[-+]/.test(s)) {
    neg = s[0] === '-';
    s = s.slice(1).trim();
  }
  const m = s.match(/^(\d+(?:\.\d+)?)(?:\s*(?:°|deg|d|:)\s*|\s+)?(?:(\d+(?:\.\d+)?)(?:\s*(?:'|min|m|:)\s*|\s+)?(?:(\d+(?:\.\d+)?)\s*(?:"|sec|s)?)?)?$/i);
  if (!m) return null;
  const d = +m[1], mi = m[2] != null ? +m[2] : 0, se = m[3] != null ? +m[3] : 0;
  if ((m[2] != null && (mi >= 60 || /\./.test(m[1]))) || se >= 60 || (m[3] != null && /\./.test(m[2] ?? ''))) return null;
  let v = d + mi / 60 + se / 3600;
  if (neg || hemi === 'S' || hemi === 'W') v = -v;
  return { v, hemi };
}

type Pair = { a: number; b: number; order: 'latlon' | 'lonlat' | 'unknown' };
type Found =
  | ({ t: 'pair'; span: [number, number] } & Pair)
  | { t: 'utm'; e: number; n: number; zone?: number; north?: boolean; span: [number, number] }
  | { t: 'geom'; raw: Raw[]; span: [number, number] };

const validPair = (a: number, b: number) => (Math.abs(a) <= 90 && Math.abs(b) <= 180) || (Math.abs(a) <= 180 && Math.abs(b) <= 90);
const NUM = String.raw`-?\d+(?:\.\d+)?`;

/** UTM zone letter → hemisphere. MGRS bands C–M are south, N–X north; a bare "S" is read as south unless the northing fits band S (32–40°N). */
function hemiOf(letter: string | undefined, northing: number): boolean | undefined {
  if (!letter) return undefined;
  const L = letter.toUpperCase();
  if (L === 'S') return northing >= 3_500_000 && northing <= 4_450_000;
  return L >= 'N';
}

export function parseWkt(s: string): Raw[] | null {
  const m = s.match(/^\s*(?:SRID=\d+;\s*)?(POINT|MULTIPOINT|LINESTRING|MULTILINESTRING|POLYGON|MULTIPOLYGON)\s*(?:ZM|Z|M)?\s*(\([\s\S]*\))\s*$/i);
  if (!m) return null;
  const type = m[1].toUpperCase();
  const body = m[2];
  const nums = (t: string) => t.trim().split(/\s*,\s*/).map((p) => p.replace(/[()]/g, '').trim().split(/\s+/).map(Number)).filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])).map((c) => [c[0], c[1]] as [number, number]);
  // innermost "( … )" groups are rings / lines / single points
  const groups = [...body.matchAll(/\(([^()]*)\)/g)].map((g) => nums(g[1])).filter((g) => g.length);
  if (!groups.length) return null;
  if (type === 'POINT') return [{ name: '', kind: 'point', coords: [groups[0][0]] }];
  if (type === 'MULTIPOINT') return groups.flat().map((c) => ({ name: '', kind: 'point', coords: [c] }));
  if (type === 'LINESTRING' || type === 'MULTILINESTRING') return [{ name: '', kind: 'line', coords: groups.flat() }];
  if (type === 'POLYGON') return [{ name: '', kind: 'polygon', coords: groups[0] }];
  // MULTIPOLYGON: the outer ring of each polygon is the first ring after "((": take the largest ring
  return [{ name: '', kind: 'polygon', coords: largestRing(groups) }];
}

function ringArea(r: [number, number][]) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2);
}
const largestRing = (rings: [number, number][][]) => rings.reduce((best, r) => (ringArea(r) > ringArea(best) ? r : best), rings[0]);

/** Find one coordinate in a line of free text. */
const LABELS = /\b(?:lat(?:itude)?|lon(?:g(?:itude)?)?|lng|[xyXY])\s*[:=]|(?:ละติจูด|ลองจิจูด|ลติจูด|ลองติจูด)\s*[:=]?/gi;

export function findInText(line: string): Found | null {
  // labels like "Lat: … Lon: …" are blanked out (same length, so spans still index the original line)
  const s = normalizeMarks(line).replace(LABELS, (m) => ' '.repeat(m.length));
  // Google Maps / OSM links
  for (const re of [/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/, /[?&#](?:q|query|ll|sll|center|destination|daddr|saddr|map=\d+\/|mlat=)=?(?:loc:)?(-?\d+(?:\.\d+)?)(?:,|%2C|\/|&mlon=)\s*(?:\+|%20)?(-?\d+(?:\.\d+)?)/i]) {
    const m = s.match(re);
    if (m && validPair(+m[1], +m[2]) && Math.abs(+m[1]) <= 90) {
      const url = s.match(/(?:https?:\/\/|www\.)\S+/);
      const span: [number, number] = url ? [url.index!, url.index! + url[0].length] : [m.index!, m.index! + m[0].length];
      return { t: 'pair', a: +m[1], b: +m[2], order: 'latlon', span };
    }
  }
  // WKT
  const w = s.match(/\b(?:SRID=\d+;\s*)?(POINT|MULTIPOINT|LINESTRING|MULTILINESTRING|POLYGON|MULTIPOLYGON)\s*(?:ZM|Z|M)?\s*\(/i);
  if (w) {
    let depth = 0, end = -1;
    for (let i = w.index! + w[0].length - 1; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')' && --depth === 0) { end = i + 1; break; }
    }
    if (end > 0) {
      const raw = parseWkt(s.slice(w.index!, end));
      if (raw) return { t: 'geom', raw, span: [w.index!, end] };
    }
  }
  // degrees with hemisphere letters and/or ° ' " marks
  const ang = new RegExp(String.raw`(?<![A-Za-z\d.])([NSEW])?\s?(\d{1,3}(?:\.\d+)?)(?![\d.])\s*(°)?\s*(?:(\d{1,2}(?:\.\d+)?)\s*')?\s*(?:(\d{1,2}(?:\.\d+)?)\s*")?\s?([NSEW])?(?![A-Za-z])`, 'g');
  const toks: { v: number; hemi?: string; i: number; j: number }[] = [];
  for (let m = ang.exec(s); m; m = ang.exec(s)) {
    if (m[1] && m[6]) {
      // "N 13°45' E 100°30'": the trailing letter belongs to the next value
      ang.lastIndex = m.index + m[0].lastIndexOf(m[6]);
      m[6] = undefined as unknown as string;
    }
    const h = m[1] ?? m[6];
    if (!(h || m[3] || m[4])) continue;
    const neg = s.slice(Math.max(0, m.index - 1), m.index) === '-';
    let v = +m[2] + (m[4] ? +m[4] / 60 : 0) + (m[5] ? +m[5] / 3600 : 0);
    if (neg || h === 'S' || h === 'W') v = -v;
    toks.push({ v, hemi: h, i: m.index - (neg ? 1 : 0), j: m[6] || !m[1] ? m.index + m[0].length : ang.lastIndex || m.index + m[0].length });
    if (toks.length === 2) break;
  }
  if (toks.length === 2) {
    const [p, q] = toks;
    const span: [number, number] = [p.i, q.j];
    const isLat = (h?: string) => h === 'N' || h === 'S';
    const isLon = (h?: string) => h === 'E' || h === 'W';
    if (isLat(p.hemi) && isLon(q.hemi)) return { t: 'pair', a: p.v, b: q.v, order: 'latlon', span };
    if (isLon(p.hemi) && isLat(q.hemi)) return { t: 'pair', a: p.v, b: q.v, order: 'lonlat', span };
    if (validPair(p.v, q.v)) return { t: 'pair', a: p.v, b: q.v, order: Math.abs(p.v) > 90 ? 'lonlat' : Math.abs(q.v) > 90 ? 'latlon' : 'unknown', span };
  }
  // UTM with zone: "47P 668000 1520000", "47N 668000mE 1520000mN", "zone 48 E 245000 N 1650000"
  const uz = s.match(/(?<![\d.])(zone\s*)?([1-9]|[1-5]\d|60)\s?([C-HJ-NP-X])?(?![A-Za-z])(\s*[,;:\s]\s*)(?:E\s*[:=]?\s*)?(\d{6}(?:\.\d+)?)\s*(?:m?E)?\s*[,;\s]\s*(?:N\s*[:=]?\s*)?(\d{6,7}(?:\.\d+)?)(?![\d.])\s*(?:m?N\b)?/i);
  // "1, 668000, 1520000" is more likely an index column than zone 1 — a zone needs a letter, the word "zone", or just a space
  if (uz && (uz[1] || uz[3] || !/[,;]/.test(uz[4]))) {
    const e = +uz[5], n = +uz[6];
    if (e >= 100_000 && e <= 900_000) return { t: 'utm', e, n, zone: +uz[2], north: hemiOf(uz[3], n), span: [uz.index!, uz.index! + uz[0].length] };
  }
  // two decimal numbers
  const nums = [...s.matchAll(new RegExp(String.raw`(?<![\w.\-])[-+]?\d+(?:\.\d+)?(?![\w.])`, 'g'))].map((m) => ({ v: +m[0], dec: m[0].includes('.'), i: m.index!, j: m.index! + m[0].length }));
  for (let k = 0; k + 1 < nums.length; k++) {
    const p = nums[k], q = nums[k + 1];
    if (p.dec && q.dec && validPair(p.v, q.v) && !/[^\s,;|\t/]/.test(s.slice(p.j, q.i)))
      return { t: 'pair', a: p.v, b: q.v, order: Math.abs(p.v) > 90 ? 'lonlat' : Math.abs(q.v) > 90 ? 'latlon' : 'unknown', span: [p.i, q.j] };
  }
  if (nums.length === 2 && validPair(nums[0].v, nums[1].v) && !/[^\s,;|\t/]/.test(s.slice(nums[0].j, nums[1].i)))
    return { t: 'pair', a: nums[0].v, b: nums[1].v, order: Math.abs(nums[0].v) > 90 ? 'lonlat' : Math.abs(nums[1].v) > 90 ? 'latlon' : 'unknown', span: [nums[0].i, nums[1].j] };
  // bare UTM easting/northing — zone taken from the options
  const ub = s.match(/(?<![\d.])(\d{6}(?:\.\d+)?)\s*(?:m?E)?\s*[,;\s]\s*(\d{6,7}(?:\.\d+)?)(?![\d.])/);
  if (ub && +ub[1] >= 100_000 && +ub[1] <= 900_000) return { t: 'utm', e: +ub[1], n: +ub[2], span: [ub.index!, ub.index! + ub[0].length] };
  return null;
}

function nameAround(line: string, span: [number, number]): string {
  const cleaned = (line.slice(0, span[0]) + ' ' + line.slice(span[1]))
    .replace(/(?:https?:\/\/|www\.)\S+/g, ' ')
    .replace(/\b(?:lat(?:itude)?|lon(?:g(?:itude)?)?|lng|utm|zone|easting|northing|coordinates?|coords?)\b\s*[:=]?/gi, ' ')
    .replace(/(?:ละติจูด|ลองจิจูด|พิกัด)\s*[:=]?/g, ' ')
    .replace(/["']/g, ' ')
    .replace(/[\s,;|\t:=–\-]+$/g, '')
    .replace(/^[\s,;|\t:=–\-]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\d\s.#,;)]*$/, '') // only an index number left
    .trim();
  // drop brackets left unbalanced by cutting the coordinate out, keep "(อุนเซน)"
  const bal = (x: string) => (x.match(/\(/g)?.length ?? 0) - (x.match(/\)/g)?.length ?? 0);
  let n = cleaned;
  while (/^[\s()[\]]/.test(n) && (n[0] === ')' || n[0] === ']' || bal(n) > 0 || /^[([]\s*$/.test(n))) n = n.slice(1).trim();
  while (/[\s()[\]]$/.test(n) && (bal(n) > 0 || n.endsWith('(') || n.endsWith('['))) n = n.slice(0, -1).trim();
  if (bal(n) > 0) n += ')';
  return n.trim();
}

/** Turn a found pair / UTM / geometry into a WGS84 Raw (or null). `order` is the file-wide choice for ambiguous pairs. */
function resolve(ctx: Ctx, f: Found, name: string, order: 'latlon' | 'lonlat', size?: number): Raw[] | null {
  if (f.t === 'geom') {
    if (f.raw.some((r) => r.coords.some(([x, y]) => Math.abs(x) > 180 || Math.abs(y) > 90))) return null;
    return f.raw.map((r, i) => ({ ...r, name: f.raw.length > 1 && name ? `${name} #${i + 1}` : name, size }));
  }
  if (f.t === 'utm') {
    let zone = f.zone, north = f.north;
    if (zone == null) {
      zone = ctx.opts.utmZone;
      ctx.usedDefaultZone = true;
      ctx.warn(`มีค่า UTM ที่ไม่ระบุโซน จึงใช้โซน ${ctx.opts.utmZone}${ctx.opts.utmNorth ? 'N' : 'S'} — เปลี่ยนโซนได้ด้านล่าง`, `Some UTM values had no zone — zone ${ctx.opts.utmZone}${ctx.opts.utmNorth ? 'N' : 'S'} assumed; change it below if needed`);
    }
    if (north == null) north = f.zone == null ? ctx.opts.utmNorth : true;
    const [lon, lat] = toWgs84(f.e, f.n, { kind: 'utm', zone, north, datum: 'wgs84' });
    return [{ name, kind: 'point', coords: [[lon, lat]], size }];
  }
  const o = f.order === 'unknown' ? order : f.order;
  const [lon, lat] = o === 'latlon' ? [f.b, f.a] : [f.a, f.b];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [{ name, kind: 'point', coords: [[lon, lat]], size }];
}

const fileOrder = (fs: (Found | null)[]): 'latlon' | 'lonlat' =>
  fs.some((f) => f?.t === 'pair' && f.order === 'lonlat') && !fs.some((f) => f?.t === 'pair' && f.order === 'latlon') ? 'lonlat' : 'latlon';

/** One place per line. */
function readLines(ctx: Ctx, source: string, lines: string[], firstLineNo = 1) {
  const items = lines.map((l, i) => ({ l, no: i + firstLineNo })).filter(({ l }) => l.trim() && !/^\s*(#|\/\/)/.test(l));
  const found = items.map(({ l }) => findInText(l));
  const order = fileOrder(found);
  let n = 0;
  items.forEach(({ l, no }, i) => {
    const f = found[i];
    if (!f) {
      if (/\d/.test(l)) ctx.skip(`${source} line ${no}`);
      return;
    }
    const raws = resolve(ctx, f, nameAround(l, f.span), order);
    if (!raws) return ctx.skip(`${source} line ${no}`);
    for (const r of raws) if (ctx.add(source, r)) n++; else ctx.skip(`${source} line ${no}`);
  });
  return n;
}

// ---------------------------------------------------------------- tables (CSV, XLSX, DBF, JSON arrays)

const norm = (h: string) => String(h ?? '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[\s_\-.:/\\#*]+/g, '');
const COLS = {
  lat: ['lat', 'latitude', 'ละติจูด', 'ลติจูด', 'ละติจูต', 'ค่าละติจูด', 'latdd', 'latdeg', 'latwgs84', 'ycoord', 'พิกัดy', 'ค่าy', 'y'],
  lon: ['lon', 'lng', 'long', 'longitude', 'ลองจิจูด', 'ลองติจูด', 'ลองจิจูต', 'ค่าลองจิจูด', 'londd', 'londeg', 'lonwgs84', 'xcoord', 'พิกัดx', 'ค่าx', 'x'],
  east: ['easting', 'east', 'utme', 'utmx', 'utmeast', 'e', 'พิกัดe', 'ค่าe'],
  north: ['northing', 'north', 'utmn', 'utmy', 'utmnorth', 'n', 'พิกัดn', 'ค่าn'],
  zone: ['zone', 'utmzone', 'โซน', 'zoneutm', 'โซนutm'],
  coord: ['coordinates', 'coordinate', 'coords', 'coord', 'latlon', 'latlng', 'latlong', 'location', 'position', 'พิกัด', 'ตำแหน่ง', 'gps', 'googlemaps', 'googlemap', 'map', 'link', 'url', 'ลิงก์', 'ลิงค์', 'แผนที่'],
  wkt: ['wkt', 'geometry', 'geom', 'thegeom', 'shape', 'รูปร่าง', 'รูปแปลง'],
  name: ['name', 'ชื่อ', 'ชื่อจุด', 'ชื่อพื้นที่', 'ชื่อสถานที่', 'ชื่อแปลง', 'สถานที่', 'title', 'label', 'sitename', 'site', 'placename', 'place', 'station', 'จุด', 'หมู่บ้าน', 'บ้าน', 'description', 'id', 'รหัส', 'fid', 'no', 'ลำดับ'],
  size: ['sizekm', 'boxkm', 'km', 'ขนาดกม', 'ขนาด', 'size', 'boxsize'],
};
const SHORT = new Set(['x', 'y', 'e', 'n', 'no', 'id', 'km']);
function findCol(headers: string[], cands: string[], skip: Set<number> = new Set()): number {
  const hs = headers.map(norm);
  for (const c of cands) {
    const i = hs.findIndex((h, k) => !skip.has(k) && h === c);
    if (i >= 0) return i;
  }
  for (const c of cands) {
    if (SHORT.has(c) || c.length < 3) continue;
    const i = hs.findIndex((h, k) => !skip.has(k) && h.startsWith(c) && !/^(lat|lon|lng)/.test(h.slice(c.length)));
    if (i >= 0) return i;
  }
  return -1;
}

function zoneCell(v: string): { zone?: number; letter?: string } {
  const m = String(v ?? '').trim().match(/^(\d{1,2})\s*([A-Za-z])?/);
  return m ? { zone: +m[1], letter: m[2] } : {};
}

/** Rows with a header row → places. Returns false if no coordinate columns were recognised. */
function readTable(ctx: Ctx, source: string, rows: string[][], crs: Crs | null = null): boolean {
  const hi = rows.findIndex((r) => r.some((c) => String(c ?? '').trim()));
  if (hi < 0) return false;
  const head = rows[hi].map((c) => String(c ?? ''));
  const used = new Set<number>();
  const pick = (k: keyof typeof COLS) => {
    const i = findCol(head, COLS[k], used);
    if (i >= 0) used.add(i);
    return i;
  };
  const wkt = pick('wkt'), lat = pick('lat'), lon = pick('lon'), east = pick('east'), north = pick('north'), zone = pick('zone'), coord = pick('coord'), size = pick('size');
  const name = pick('name');
  const hasLL = lat >= 0 && lon >= 0, hasEN = east >= 0 && north >= 0;
  if (!hasLL && !hasEN && coord < 0 && wkt < 0) return false;
  const data = rows.slice(hi + 1).map((r, i) => ({ r: r.map((c) => String(c ?? '').trim()), no: hi + i + 2 })).filter(({ r }) => r.some(Boolean));
  const projected: Raw[] = [];
  const pending: { f: Found; name: string; size?: number; no: number }[] = [];
  let added = 0;
  for (const { r, no } of data) {
    const nm = name >= 0 ? r[name] : '';
    const sz = size >= 0 ? parseFloat(r[size].replace(',', '.')) : undefined;
    const ref = `${source} row ${no}`;
    if (wkt >= 0 && r[wkt]) {
      const g = parseWkt(r[wkt]);
      if (g) {
        projected.push(...g.map((x, i) => ({ ...x, name: g.length > 1 && nm ? `${nm} #${i + 1}` : nm })));
        continue;
      }
    }
    if (hasLL && r[lat] && r[lon]) {
      const a = parseAngle(r[lat]), b = parseAngle(r[lon]);
      if (a && b) {
        // hemisphere letters win over column names; lat/lon columns swapped by mistake are caught by range
        let la = a.v, lo = b.v;
        if ((a.hemi === 'E' || a.hemi === 'W') && (b.hemi === 'N' || b.hemi === 'S')) [la, lo] = [lo, la];
        if (Math.abs(la) > 90 && Math.abs(la) <= 180 && Math.abs(lo) <= 90) {
          [la, lo] = [lo, la];
          ctx.warn(`${source}: ค่าในคอลัมน์ละติจูด/ลองจิจูดสลับกัน จึงสลับให้อัตโนมัติ`, `${source}: latitude/longitude columns looked swapped — swapped automatically`);
        }
        if (Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
          if (crs) projected.push({ name: nm, kind: 'point', coords: [[lo, la]], size: sz });
          else if (ctx.add(source, { name: nm, kind: 'point', coords: [[lo, la]], size: sz })) added++;
          else ctx.skip(ref);
          continue;
        }
        if (Math.abs(la) > 180 || Math.abs(lo) > 180) {
          // projected values in "X/Y"-style columns
          const z = zone >= 0 ? zoneCell(r[zone]) : {};
          if (z.zone) {
            const [x, y] = toWgs84(lo, la, { kind: 'utm', zone: z.zone, north: hemiOf(z.letter, la) ?? true, datum: 'wgs84' });
            if (ctx.add(source, { name: nm, kind: 'point', coords: [[x, y]], size: sz })) added++;
            else ctx.skip(ref);
          } else projected.push({ name: nm, kind: 'point', coords: [[lo, la]], size: sz });
          continue;
        }
      }
    }
    if (hasEN && r[east] && r[north]) {
      const e = parseFloat(r[east].replace(/,/g, '')), n = parseFloat(r[north].replace(/,/g, ''));
      if (Number.isFinite(e) && Number.isFinite(n)) {
        const z = zone >= 0 ? zoneCell(r[zone]) : {};
        if (z.zone) {
          const [x, y] = toWgs84(e, n, { kind: 'utm', zone: z.zone, north: hemiOf(z.letter, n) ?? true, datum: 'wgs84' });
          if (ctx.add(source, { name: nm, kind: 'point', coords: [[x, y]], size: sz })) added++;
          else ctx.skip(ref);
        } else projected.push({ name: nm, kind: 'point', coords: [[e, n]], size: sz });
        continue;
      }
    }
    if (coord >= 0 && r[coord]) {
      const f = findInText(r[coord]);
      if (f) {
        pending.push({ f, name: nm || (name < 0 ? nameAround(r[coord], f.span) : ''), size: sz, no });
        continue;
      }
    }
    ctx.skip(ref);
  }
  const order = fileOrder(pending.map((p) => p.f));
  for (const p of pending) {
    const raws = resolve(ctx, p.f, p.name, order, p.size);
    if (!raws) ctx.skip(`${source} row ${p.no}`);
    else for (const r of raws) if (ctx.add(source, r)) added++; else ctx.skip(`${source} row ${p.no}`);
  }
  if (projected.length) emit(ctx, source, projected, crs);
  return true;
}

export function parseCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
    } else if (ch === '"' && cell.trim() === '') { q = true; cell = ''; }
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function sniffDelimiter(lines: string[]): string | null {
  const sample = lines.filter((l) => l.trim()).slice(0, 12);
  if (sample.length < 1) return null;
  const counts = (d: string) => sample.map((l) => parseCsv(l, d)[0]?.length ?? 1);
  for (const d of ['\t', ';', '|', ',']) {
    const c = counts(d);
    if (c[0] > 1 && c.every((x) => x === c[0])) return d;
  }
  for (const d of ['\t', ';', ',']) if (counts(d)[0] > 2) return d;
  return null;
}

// ---------------------------------------------------------------- GeoJSON / JSON

function nameFromProps(p: Record<string, unknown> | null | undefined, fallback?: unknown): string {
  if (p && typeof p === 'object') {
    const keys = Object.keys(p);
    const i = findCol(keys, COLS.name);
    if (i >= 0 && p[keys[i]] != null && String(p[keys[i]]).trim()) return String(p[keys[i]]).trim();
  }
  return fallback != null ? String(fallback) : '';
}

function geomToRaw(g: any, name: string, out: Raw[]) {
  if (!g || !g.type) return;
  const pt = (c: any): [number, number] => [+c[0], +c[1]];
  switch (g.type) {
    case 'Point':
      if (Array.isArray(g.coordinates) && g.coordinates.length >= 2) out.push({ name, kind: 'point', coords: [pt(g.coordinates)] });
      break;
    case 'MultiPoint':
      (g.coordinates ?? []).forEach((c: any, i: number) => out.push({ name: g.coordinates.length > 1 && name ? `${name} #${i + 1}` : name, kind: 'point', coords: [pt(c)] }));
      break;
    case 'LineString':
      out.push({ name, kind: 'line', coords: (g.coordinates ?? []).map(pt) });
      break;
    case 'MultiLineString':
      out.push({ name, kind: 'line', coords: (g.coordinates ?? []).flat().map(pt) });
      break;
    case 'Polygon':
      if (g.coordinates?.[0]) out.push({ name, kind: 'polygon', coords: g.coordinates[0].map(pt) });
      break;
    case 'MultiPolygon': {
      const rings = (g.coordinates ?? []).map((p: any) => (p?.[0] ?? []).map(pt)).filter((r: any[]) => r.length);
      if (rings.length) out.push({ name, kind: 'polygon', coords: largestRing(rings) });
      break;
    }
    case 'GeometryCollection':
      (g.geometries ?? []).forEach((x: any) => geomToRaw(x, name, out));
      break;
  }
}

function readJson(ctx: Ctx, source: string, doc: any) {
  // a plain array of records → table
  const arr = Array.isArray(doc) ? doc : doc && typeof doc === 'object' && !doc.type ? Object.values(doc).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object') : null;
  if (Array.isArray(arr) && arr.length && typeof arr[0] === 'object' && !arr[0]?.type) {
    const keys = [...new Set(arr.flatMap((o: any) => (o && typeof o === 'object' ? Object.keys(o) : [])))];
    const rows = [keys, ...arr.map((o: any) => keys.map((k) => (o?.[k] == null ? '' : typeof o[k] === 'object' ? JSON.stringify(o[k]) : String(o[k]))))];
    ctx.formats.add('JSON');
    if (!readTable(ctx, source, rows)) ctx.warn(`${source}: ไม่พบคอลัมน์พิกัด (เช่น lat, lon)`, `${source}: no coordinate fields found (e.g. lat, lon)`);
    return;
  }
  if (Array.isArray(doc) && doc.every((v) => Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number')) {
    // [[lon, lat], …]
    ctx.formats.add('JSON');
    emit(ctx, source, doc.map((c: number[]) => ({ name: '', kind: 'point' as const, coords: [[c[0], c[1]] as [number, number]] })), null);
    return;
  }
  ctx.formats.add('GeoJSON');
  const feats: any[] = doc?.type === 'FeatureCollection' ? doc.features ?? [] : doc?.type === 'Feature' ? [doc] : Array.isArray(doc) ? doc : [{ type: 'Feature', geometry: doc, properties: {} }];
  const raw: Raw[] = [];
  feats.forEach((f) => {
    const before = raw.length;
    geomToRaw(f?.type === 'Feature' ? f.geometry : f, nameFromProps(f?.properties, f?.id), raw);
    if (raw.length === before) ctx.skip(`${source} feature ${feats.indexOf(f) + 1}`);
  });
  const crsName = doc?.crs?.properties?.name ?? doc?.crs?.properties?.code;
  const crs = crsName != null ? crsFromText(String(crsName)) : null;
  if (crsName != null && !crs) ctx.warn(`${source}: ไม่รู้จักระบบพิกัด ${crsName}`, `${source}: unknown coordinate system ${crsName}`);
  emit(ctx, source, raw, crs);
}

// ---------------------------------------------------------------- KML / GPX

const kmlCoords = (s: string | undefined): [number, number][] =>
  (s ?? '')
    .replace(/\s*,\s*/g, ',')
    .trim()
    .split(/\s+/)
    .map((t) => t.split(',').map(Number))
    .filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
    .map((c) => [c[0], c[1]]);

function readKml(ctx: Ctx, source: string, text: string) {
  ctx.formats.add('KML');
  const raw: Raw[] = [];
  const marks = [...text.matchAll(tagRe('Placemark'))].map((m) => m[0]);
  marks.forEach((pm, idx) => {
    // the Placemark's own <name>, not one inside ExtendedData / nested elements further down
    const name = xmlText(pm.replace(tagRe('ExtendedData'), '').match(tagRe('name', ''))?.[1]) || xmlText(pm.match(/<(?:\w+:)?SimpleData\s+name=["'](?:name|ชื่อ|NAME|Name)["'][^>]*>([\s\S]*?)</)?.[1]);
    const before = raw.length;
    const polys = [...pm.matchAll(tagRe('Polygon'))].map((m) => kmlCoords(firstTag(firstTag(m[1], 'outerBoundaryIs') ?? m[1], 'coordinates'))).filter((r) => r.length >= 3);
    if (polys.length) raw.push({ name, kind: 'polygon', coords: largestRing(polys) });
    else {
      const lines = [...pm.matchAll(tagRe('LineString')), ...pm.matchAll(tagRe('LinearRing'))].map((m) => kmlCoords(firstTag(m[1], 'coordinates'))).filter((l) => l.length);
      const track = [...pm.matchAll(tagRe('coord'))].map((m) => m[1].trim().split(/\s+/).map(Number)).filter((c) => c.length >= 2).map((c) => [c[0], c[1]] as [number, number]);
      if (lines.length) raw.push({ name, kind: 'line', coords: lines.flat() });
      else if (track.length) raw.push({ name, kind: 'line', coords: track });
      else {
        const pts = [...pm.matchAll(tagRe('Point'))].map((m) => kmlCoords(firstTag(m[1], 'coordinates'))[0]).filter(Boolean);
        pts.forEach((p, i) => raw.push({ name: pts.length > 1 && name ? `${name} #${i + 1}` : name, kind: 'point', coords: [p] }));
      }
    }
    if (raw.length === before) ctx.skip(`${source} placemark ${idx + 1}`);
  });
  if (!marks.length) ctx.warn(`${source}: ไม่พบ Placemark ในไฟล์ KML`, `${source}: no Placemark found in the KML`);
  emit(ctx, source, raw, { kind: 'geo', datum: 'wgs84' });
}

function readGpx(ctx: Ctx, source: string, text: string) {
  ctx.formats.add('GPX');
  const raw: Raw[] = [];
  const ll = (a: string): [number, number] | null => {
    const la = parseFloat(attr(a, 'lat') ?? ''), lo = parseFloat(attr(a, 'lon') ?? '');
    return Number.isFinite(la) && Number.isFinite(lo) ? [lo, la] : null;
  };
  for (const m of text.matchAll(/<(?:\w+:)?wpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?wpt>)/g)) {
    const p = ll(m[1]);
    if (p) raw.push({ name: xmlText(firstTag(m[2] ?? '', 'name')), kind: 'point', coords: [p] });
    else ctx.skip(`${source} waypoint`);
  }
  for (const tag of ['trk', 'rte']) {
    for (const m of text.matchAll(tagRe(tag))) {
      const body = m[1];
      const name = xmlText(firstTag(body.replace(/<(?:\w+:)?(?:trkseg|rtept|trkpt)\b[\s\S]*/, ''), 'name'));
      const pts = [...body.matchAll(/<(?:\w+:)?(?:trkpt|rtept)\b([^>]*?)(?:\/>|>)/g)].map((x) => ll(x[1])).filter((x): x is [number, number] => !!x);
      if (pts.length) raw.push({ name, kind: pts.length > 1 ? 'line' : 'point', coords: pts });
    }
  }
  emit(ctx, source, raw, { kind: 'geo', datum: 'wgs84' });
}

// ---------------------------------------------------------------- Excel .xlsx

function colIndex(ref: string): number {
  const L = ref.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? 'A';
  let n = 0;
  for (const ch of L) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function xlsxSheets(files: Map<string, Uint8Array>): { name: string; rows: string[][] }[] {
  const txt = (p: string) => {
    const b = files.get(p) ?? files.get(p.replace(/^\//, ''));
    return b ? new TextDecoder().decode(b) : '';
  };
  const shared = [...txt('xl/sharedStrings.xml').matchAll(tagRe('si'))].map((m) => xmlText([...m[1].replace(tagRe('rPh'), '').matchAll(tagRe('t'))].map((t) => t[1]).join('')));
  const rels = new Map([...txt('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => [attr(m[1], 'Id') ?? '', attr(m[1], 'Target') ?? '']));
  const sheets = [...txt('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => {
    const t = rels.get(attr(m[1], 'r:id') ?? '') ?? '';
    return { name: xmlText(attr(m[1], 'name')), path: t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}` };
  });
  if (!sheets.length) for (const k of files.keys()) if (/^xl\/worksheets\/sheet\d+\.xml$/.test(k)) sheets.push({ name: k.match(/sheet\d+/)![0], path: k });
  return sheets.map(({ name, path }) => {
    const rows: string[][] = [];
    for (const rm of txt(path).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = (+(attr(rm[1], 'r') ?? rows.length + 1) || rows.length + 1) - 1;
      const row: string[] = [];
      for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = cm[1];
        const ci = attr(a, 'r') ? colIndex(attr(a, 'r')!) : row.length;
        const t = attr(a, 't');
        const body = cm[2] ?? '';
        let v = '';
        if (t === 's') v = shared[+(firstTag(body, 'v') ?? -1)] ?? '';
        else if (t === 'inlineStr') v = xmlText([...body.matchAll(tagRe('t'))].map((x) => x[1]).join(''));
        else v = xmlText(firstTag(body, 'v'));
        row[ci] = v;
      }
      for (let i = 0; i < row.length; i++) if (row[i] == null) row[i] = '';
      rows[r] = row;
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return { name, rows };
  });
}

// ---------------------------------------------------------------- Shapefile

function readShp(b: Uint8Array): (Raw[] | null)[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 100 || dv.getInt32(0, false) !== 9994) throw new Error('not a shapefile (.shp)');
  const out: (Raw[] | null)[] = [];
  let p = 100;
  while (p + 8 <= b.length) {
    const len = dv.getInt32(p + 4, false) * 2;
    const c = p + 8;
    p = c + len;
    if (len < 4 || p > b.length) break;
    const type = dv.getInt32(c, true);
    const base = type % 10; // 1 point, 3 polyline, 5 polygon, 8 multipoint (+10 Z, +20 M)
    const xy = (o: number): [number, number] => [dv.getFloat64(o, true), dv.getFloat64(o + 8, true)];
    if (type === 0) out.push(null);
    else if (base === 1) out.push([{ name: '', kind: 'point', coords: [xy(c + 4)] }]);
    else if (base === 8) {
      const n = dv.getInt32(c + 36, true);
      const pts = Array.from({ length: n }, (_, i) => xy(c + 40 + i * 16));
      out.push(pts.map((q) => ({ name: '', kind: 'point', coords: [q] })));
    } else if (base === 3 || base === 5) {
      const np = dv.getInt32(c + 36, true), n = dv.getInt32(c + 40, true);
      const parts = Array.from({ length: np }, (_, i) => dv.getInt32(c + 44 + i * 4, true));
      const p0 = c + 44 + np * 4;
      const pts = Array.from({ length: n }, (_, i) => xy(p0 + i * 16));
      const rings = parts.map((s, i) => pts.slice(s, i + 1 < parts.length ? parts[i + 1] : n));
      out.push([base === 5 ? { name: '', kind: 'polygon', coords: largestRing(rings), parts: rings } : { name: '', kind: 'line', coords: pts, parts: rings }]);
    } else out.push(null);
  }
  return out;
}

function readDbf(b: Uint8Array, cpg?: string): string[][] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = dv.getUint32(4, true), hlen = dv.getUint16(8, true), rlen = dv.getUint16(10, true);
  const fields: { name: string; len: number }[] = [];
  for (let o = 32; o + 32 <= hlen && b[o] !== 0x0d; o += 32) {
    let e = o;
    while (e < o + 11 && b[e]) e++;
    fields.push({ name: new TextDecoder('latin1').decode(b.subarray(o, e)), len: b[o + 16] });
  }
  const enc = (cpg ?? '').trim().toLowerCase();
  const decName = /874|tis|thai/.test(enc) ? 'windows-874' : /utf-?8/.test(enc) ? 'utf-8' : '';
  const decode = (u: Uint8Array) => {
    if (decName) return new TextDecoder(decName).decode(u);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u); } catch { return new TextDecoder('windows-874').decode(u); }
  };
  const rows: string[][] = [fields.map((f) => f.name)];
  for (let i = 0; i < n; i++) {
    let o = hlen + i * rlen;
    if (o + rlen > b.length) break;
    const deleted = b[o] === 0x2a;
    o++;
    const r = fields.map((f) => {
      const v = decode(b.subarray(o, o + f.len)).replace(/\0/g, '').trim();
      o += f.len;
      return v;
    });
    rows.push(deleted ? fields.map(() => '') : r);
  }
  return rows;
}

function readShapefileSet(ctx: Ctx, base: string, parts: Map<string, Uint8Array>) {
  const shp = parts.get('shp'), dbf = parts.get('dbf'), prj = parts.get('prj'), cpg = parts.get('cpg');
  const source = base.split('/').pop() + (shp ? '.shp' : '.dbf');
  const attrs = dbf ? readDbf(dbf, cpg ? new TextDecoder().decode(cpg) : undefined) : null;
  if (!shp) {
    // attribute table only — it may still hold lat/lon or UTM columns
    if (attrs && readTable(ctx, source, attrs)) ctx.formats.add('DBF');
    else ctx.warn(`${base}: มีแต่ไฟล์ .dbf ไม่มี .shp — เลือกไฟล์ .shp มาด้วย (หรือบีบรวมเป็น .zip)`, `${base}: only the .dbf was given — include the .shp too (or zip them together)`);
    return;
  }
  ctx.formats.add('Shapefile');
  const geoms = readShp(shp);
  const ni = attrs ? findCol(attrs[0], COLS.name) : -1;
  const raw: Raw[] = [];
  geoms.forEach((g, i) => {
    if (!g || !g.length) return ctx.skip(`${source} #${i + 1}`);
    const nm = ni >= 0 ? attrs![i + 1]?.[ni] ?? '' : '';
    g.forEach((x, k) => raw.push({ ...x, name: g.length > 1 && nm ? `${nm} #${k + 1}` : nm }));
  });
  let crs: Crs | null = null;
  if (prj) {
    const t = new TextDecoder().decode(prj);
    crs = crsFromText(t);
    if (!crs) ctx.warn(`${source}: ไม่รู้จักระบบพิกัดใน .prj (${t.match(/(?:PROJCS|PROJCRS)\["([^"]+)/)?.[1] ?? 'unknown'}) — ระบบจะเดาจากค่าพิกัด`, `${source}: unrecognised projection in the .prj (${t.match(/(?:PROJCS|PROJCRS)\["([^"]+)/)?.[1] ?? 'unknown'}) — guessing from the values`);
  } else ctx.warn(`${source}: ไม่มีไฟล์ .prj — ระบบจะเดาระบบพิกัดจากค่าพิกัด`, `${source}: no .prj file — the coordinate system is guessed from the values`);
  emit(ctx, source, raw, crs);
}

// ---------------------------------------------------------------- dispatch

const extOf = (n: string) => n.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';

function readText(ctx: Ctx, source: string, text: string) {
  const t = text.replace(/^﻿/, '');
  const s = t.trimStart();
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return readJson(ctx, source, JSON.parse(s));
    } catch {
      /* not JSON — fall through to lines */
    }
  }
  if (s.startsWith('<')) {
    if (/<(?:\w+:)?gpx\b/i.test(s)) return readGpx(ctx, source, s);
    if (/<(?:\w+:)?(?:kml|Placemark)\b/.test(s)) return readKml(ctx, source, s);
  }
  const lines = t.split(/\r\n|\n|\r/);
  const d = sniffDelimiter(lines);
  if (d) {
    const rows = parseCsv(t, d);
    if (readTable(ctx, source, rows)) {
      ctx.formats.add(d === '\t' ? 'TSV' : 'CSV');
      return;
    }
  }
  ctx.formats.add(d ? (d === '\t' ? 'TSV' : 'CSV') : 'Text');
  readLines(ctx, source, lines);
}

async function readFile(ctx: Ctx, f: InputFile, depth = 0): Promise<void> {
  const ext = extOf(f.name);
  const b = f.bytes;
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) {
    ctx.warn(`${f.name}: ไฟล์ Excel รุ่นเก่า (.xls) อ่านไม่ได้ — บันทึกเป็น .xlsx หรือ .csv ก่อน`, `${f.name}: old Excel (.xls) is not supported — save it as .xlsx or .csv first`);
    return;
  }
  if (isZip(b)) {
    const files = await unzip(b);
    if (files.has('xl/workbook.xml')) {
      ctx.formats.add('Excel');
      const sheets = xlsxSheets(files);
      let any = false;
      for (const sh of sheets) {
        const src = sheets.length > 1 ? `${f.name} › ${sh.name}` : f.name;
        if (!sh.rows.some((r) => r.some(Boolean))) continue;
        if (readTable(ctx, src, sh.rows)) any = true;
        else if (readLines(ctx, src, sh.rows.map((r) => r.filter(Boolean).join(', '))) > 0) any = true;
      }
      if (!any) ctx.warn(`${f.name}: ไม่พบพิกัดในชีตใด — ใส่หัวคอลัมน์ เช่น name, lat, lon`, `${f.name}: no coordinates found in any sheet — add column headers such as name, lat, lon`);
      return;
    }
    if (depth > 1) return;
    if (ext === 'kmz') ctx.formats.add('KMZ');
    await readFileSet(ctx, [...files].filter(([n]) => !/(^|\/)(__MACOSX|\.)/.test(n)).map(([name, bytes]) => ({ name, bytes })), depth + 1);
    return;
  }
  if (ext === 'shp' || ext === 'dbf') return; // handled as a set in readFileSet
  if (['prj', 'cpg', 'shx', 'sbn', 'sbx', 'qix', 'qmd', 'xml', 'png', 'jpg', 'jpeg', 'gif', 'tif', 'tiff'].includes(ext) && !(ext === 'xml' && /<(?:kml|gpx)\b/.test(decodeText(b.subarray(0, 512))))) return;
  const text = decodeText(b);
  if (ext === 'wkt') {
    ctx.formats.add('WKT');
    return void readLines(ctx, f.name, text.split(/\r?\n/));
  }
  readText(ctx, f.name, text);
}

async function readFileSet(ctx: Ctx, files: InputFile[], depth = 0) {
  // shapefile parts are grouped by base name
  const sets = new Map<string, Map<string, Uint8Array>>();
  for (const f of files) {
    const ext = extOf(f.name);
    if (['shp', 'dbf', 'prj', 'cpg'].includes(ext)) {
      const base = f.name.replace(/\.[^.]+$/, '');
      if (!sets.has(base.toLowerCase())) sets.set(base.toLowerCase(), new Map([['__name', new TextEncoder().encode(base)]]));
      sets.get(base.toLowerCase())!.set(ext, f.bytes);
    }
  }
  for (const [, parts] of sets) {
    if (!parts.has('shp') && !parts.has('dbf')) continue;
    try {
      readShapefileSet(ctx, new TextDecoder().decode(parts.get('__name')), parts);
    } catch (e: any) {
      ctx.warn(`อ่าน shapefile ไม่ได้: ${e?.message ?? e}`, `Could not read shapefile: ${e?.message ?? e}`);
    }
  }
  for (const f of files) {
    try {
      await readFile(ctx, f, depth);
    } catch (e: any) {
      ctx.warn(`${f.name}: อ่านไม่ได้ (${e?.message ?? e})`, `${f.name}: could not be read (${e?.message ?? e})`);
    }
  }
}

const withDefaults = (o: ImportOptions = {}): Required<ImportOptions> => ({ utmZone: o.utmZone ?? 47, utmNorth: o.utmNorth ?? true });

/** Import from one or more files (any mix of the supported formats). */
export async function importCoordFiles(files: InputFile[], opts?: ImportOptions): Promise<ImportResult> {
  const ctx = new Ctx(withDefaults(opts));
  await readFileSet(ctx, files);
  return ctx.result();
}

/** Import from pasted text: CSV/TSV with a header, GeoJSON, KML, or one coordinate per line. */
export function importCoordText(text: string, opts?: ImportOptions, label = 'pasted'): ImportResult {
  const ctx = new Ctx(withDefaults(opts));
  readText(ctx, label, text);
  return ctx.result();
}

export async function filesFromInput(list: FileList | File[]): Promise<InputFile[]> {
  return Promise.all([...list].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
}

// ---------------------------------------------------------------- places → watch geometry

/** Square box of `wKm` × `hKm` around a point (same convention as pointAoi in geo.ts). */
export function boxAround(lon: number, lat: number, wKm: number, hKm = wKm): GeoJSON.Polygon {
  const dLat = hKm / 2 / 110.574;
  const dLon = wKm / 2 / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  const r = (v: number) => round7(v);
  const [w, s, e, n] = [r(lon - dLon), r(lat - dLat), r(lon + dLon), r(lat + dLat)];
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

/** The polygon to watch for a place: points get a box of `pointKm` (or the row's own size), lines their extent (at least `pointKm`). */
export function placePolygon(p: ImportedPlace, pointKm: number): GeoJSON.Polygon {
  if (p.kind === 'polygon' && p.ring) return { type: 'Polygon', coordinates: [p.ring.map((c) => [c[0], c[1]])] };
  if (p.kind === 'line' && p.ring) {
    const [w, s, e, n] = bbox(p.ring);
    const cos = Math.max(0.05, Math.cos((((s + n) / 2) * Math.PI) / 180));
    const wk = Math.max(pointKm, (e - w) * 111.32 * cos + 0.5), hk = Math.max(pointKm, (n - s) * 110.574 + 0.5);
    return boxAround((w + e) / 2, (s + n) / 2, wk, hk);
  }
  return boxAround(p.lon, p.lat, p.sizeKm ?? pointKm);
}

/** Approximate area (km²) for display. */
export function approxKm2(g: GeoJSON.Polygon): number {
  const r = g.coordinates[0];
  const lat0 = (r.reduce((a, c) => a + c[1], 0) / r.length) * (Math.PI / 180);
  return ringArea(r.map(([x, y]) => [x * 111.32 * Math.cos(lat0), y * 110.574] as [number, number]));
}

/** Swap latitude and longitude (for files that put them the wrong way round). Null if the result is out of range. */
export function swapLatLon(p: ImportedPlace): ImportedPlace | null {
  if (Math.abs(p.lon) > 90) return null;
  return { ...p, lon: p.lat, lat: p.lon, ring: p.ring?.map(([x, y]) => [y, x]) };
}

export const TEMPLATE_CSV = [
  'name,lat,lon,size_km',
  'ตัวอย่าง จุดที่ 1,13.756300,100.501800,2',
  'ตัวอย่าง จุดที่ 2,14.021500,99.532100,',
  `ตัวอย่าง DMS,"13°45'22.7""N","100°30'06.5""E",`,
  '',
].join('\r\n');

// ---------------------------------------------------------------- boundary lines (full detail, no thinning)

/**
 * Line work from any supported file set (shapefile in a .zip or as .shp+.dbf+.prj, KML/KMZ, GeoJSON, GPX)
 * converted to WGS84, every part kept separately and at full detail — for the border-line import.
 * Returns a GeoJSON FeatureCollection of LineStrings (polygons contribute their rings as lines).
 */
export async function boundaryGeoJsonFromFiles(files: InputFile[], opts?: ImportOptions): Promise<{ geojson: { type: 'FeatureCollection'; features: any[] }; warnings: Msg[]; name: string }> {
  const o = withDefaults(opts);
  const warnings: Msg[] = [];
  const lines: [number, number][][] = [];
  const flat: InputFile[] = [];
  const expand = async (f: InputFile, depth: number) => {
    const ext = extOf(f.name);
    if (ext === 'rar' || (f.bytes[0] === 0x52 && f.bytes[1] === 0x61 && f.bytes[2] === 0x72 && f.bytes[3] === 0x21)) {
      warnings.push({ th: `${f.name}: เว็บเปิดไฟล์ .rar ไม่ได้ — แตกไฟล์แล้วเลือก .shp .dbf .prj พร้อมกัน หรือบีบอัดใหม่เป็น .zip`, en: `${f.name}: .rar cannot be opened in the browser — extract it and pick the .shp/.dbf/.prj together, or re-pack as .zip` });
      return;
    }
    if (isZip(f.bytes) && depth < 2) {
      for (const [name, bytes] of await unzip(f.bytes)) if (!/(^|\/)(__MACOSX|\.)/.test(name)) await expand({ name, bytes }, depth + 1);
      return;
    }
    flat.push(f);
  };
  for (const f of files) await expand(f, 0);

  const push = (parts: [number, number][][], crs: Crs | null, source: string) => {
    if (!parts.length) return;
    let c = crs;
    if (!c) {
      const all = parts.flat();
      if (all.every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90)) c = { kind: 'geo', datum: 'wgs84' };
      else if (all.some(([x]) => Math.abs(x) > 1_000_000)) {
        c = { kind: 'merc' };
        warnings.push({ th: `${source}: ไม่ระบุระบบพิกัด ถือเป็น Web Mercator`, en: `${source}: no CRS — read as Web Mercator` });
      } else {
        c = { kind: 'utm', zone: o.utmZone, north: o.utmNorth, datum: 'wgs84' };
        warnings.push({ th: `${source}: ไม่ระบุระบบพิกัด ถือเป็น UTM ${o.utmZone}N`, en: `${source}: no CRS — read as UTM ${o.utmZone}N` });
      }
    }
    const cc = c;
    if (cc.kind !== 'geo' || cc.datum !== 'wgs84') warnings.push({ th: `${source}: แปลงจาก ${crsLabel(cc)} เป็น WGS84`, en: `${source}: converted from ${crsLabel(cc)} to WGS84` });
    for (const p of parts) {
      const q = (cc.kind === 'geo' && cc.datum === 'wgs84' ? p : p.map(([x, y]) => toWgs84(x, y, cc))).map(([x, y]) => [round7(x), round7(y)] as [number, number]);
      if (q.length > 1 && q.every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90)) lines.push(q);
    }
  };

  // shapefiles, grouped by base name
  const sets = new Map<string, Map<string, Uint8Array>>();
  for (const f of flat) {
    const ext = extOf(f.name);
    if (!['shp', 'prj'].includes(ext)) continue;
    const base = f.name.replace(/\.[^.]+$/, '').toLowerCase();
    if (!sets.has(base)) sets.set(base, new Map());
    sets.get(base)!.set(ext, f.bytes);
  }
  for (const [base, parts] of sets) {
    const shp = parts.get('shp');
    if (!shp) continue;
    const src = `${base.split('/').pop()}.shp`;
    const prj = parts.get('prj');
    const crs = prj ? crsFromText(new TextDecoder().decode(prj)) : null;
    if (prj && !crs) warnings.push({ th: `${src}: ไม่รู้จักระบบพิกัดใน .prj — เดาจากค่าพิกัด`, en: `${src}: unknown projection in .prj — guessing` });
    push(readShp(shp).flatMap((r) => (r ?? []).flatMap((x) => x.parts ?? [x.coords])), crs, src);
  }
  // KML / GeoJSON / GPX
  for (const f of flat) {
    const ext = extOf(f.name);
    if (['shp', 'dbf', 'prj', 'cpg', 'shx', 'sbn', 'sbx', 'qix', 'qmd', 'xml'].includes(ext)) continue;
    const text = decodeText(f.bytes).replace(/^﻿/, '');
    const t = text.trimStart();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        const doc = JSON.parse(t);
        const parts: [number, number][][] = [];
        const walk = (g: any) => {
          if (!g) return;
          if (g.type === 'FeatureCollection') return g.features?.forEach((x: any) => walk(x));
          if (g.type === 'Feature') return walk(g.geometry);
          if (g.type === 'GeometryCollection') return g.geometries?.forEach(walk);
          const ln = (c: any) => c.map((p: number[]) => [+p[0], +p[1]] as [number, number]);
          if (g.type === 'LineString') parts.push(ln(g.coordinates));
          else if (g.type === 'MultiLineString' || g.type === 'Polygon') g.coordinates.forEach((c: any) => parts.push(ln(c)));
          else if (g.type === 'MultiPolygon') g.coordinates.forEach((p: any) => p.forEach((c: any) => parts.push(ln(c))));
        };
        walk(doc);
        const cn = doc?.crs?.properties?.name;
        push(parts, cn ? crsFromText(String(cn)) : null, f.name);
      } catch {
        /* not JSON */
      }
    } else if (/<(?:\w+:)?(?:kml|Placemark)\b/.test(t)) {
      const parts = [...t.matchAll(tagRe('coordinates'))].map((m) => kmlCoords(m[1])).filter((l) => l.length > 1);
      push(parts, { kind: 'geo', datum: 'wgs84' }, f.name);
    } else if (/<(?:\w+:)?gpx\b/i.test(t)) {
      for (const m of t.matchAll(/<(?:\w+:)?(?:trkseg|rte)\b[\s\S]*?<\/(?:\w+:)?(?:trkseg|rte)>/g)) {
        const pts = [...m[0].matchAll(/<(?:\w+:)?(?:trkpt|rtept)\b([^>]*?)(?:\/>|>)/g)].map((x) => [parseFloat(attr(x[1], 'lon') ?? ''), parseFloat(attr(x[1], 'lat') ?? '')] as [number, number]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
        if (pts.length > 1) push([pts], { kind: 'geo', datum: 'wgs84' }, f.name);
      }
    }
  }
  const name = files.map((f) => f.name).join(', ');
  return { geojson: { type: 'FeatureCollection', features: lines.map((coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } })) }, warnings, name };
}
