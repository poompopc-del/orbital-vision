// User-supplied boundary lines (e.g. an official survey dataset) — used in preference to Natural
// Earth whenever present. The file stays in this browser (IndexedDB); it is never uploaded or
// bundled with the site.
//
// Accepted: GeoJSON with LineString / MultiLineString features. Features may carry `nb`
// ('KHM' | 'LAO' | 'MMR' | 'MYS' | 'coast'); unlabelled lines are assigned to a neighbour here by
// probing a few km either side of the line against the Natural Earth country outlines.
import { loadCountries } from './countries';

export type Nb = 'KHM' | 'LAO' | 'MMR' | 'MYS';
export interface CustomBoundary {
  name: string;
  importedAt: string;
  /** lines per neighbour ('coast' / 'unknown' kept for display) */
  lines: Record<string, [number, number][][]>;
  /** km per label, measured on the imported lines */
  lengthKm: Record<string, number>;
}

const DB = 'ov-boundary';
const STORE = 'b';
function db(): Promise<IDBDatabase> {
  return new Promise((ok, bad) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
}
async function idb<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise((ok, bad) => {
    const tx = d.transaction(STORE, mode);
    const req = f(tx.objectStore(STORE));
    req.onsuccess = () => ok(req.result as T);
    req.onerror = () => bad(req.error);
  });
}

let cache: CustomBoundary | null | undefined;
const listeners = new Set<() => void>();
export const onBoundaryChange = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

export async function getBoundary(): Promise<CustomBoundary | null> {
  if (cache !== undefined) return cache;
  try {
    cache = (await idb<CustomBoundary | undefined>('readonly', (s) => s.get('current'))) ?? null;
  } catch {
    cache = null;
  }
  return cache;
}
export async function clearBoundary() {
  await idb('readwrite', (s) => s.delete('current')).catch(() => {});
  cache = null;
  listeners.forEach((f) => f());
}

const KM_LAT = 110.574;
const kmLon = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);
export const lineKm = (l: [number, number][]) => l.slice(1).reduce((t, p, i) => t + Math.hypot((p[0] - l[i][0]) * kmLon(p[1]), (p[1] - l[i][1]) * KM_LAT), 0);

function inRing(x: number, y: number, ring: GeoJSON.Position[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Assign each stretch of an unlabelled line to the neighbour found 2–5 km to either side. */
async function classify(lines: [number, number][][]): Promise<Record<string, [number, number][][]>> {
  const cs = await loadCountries();
  const polys = cs.filter((c) => ['KHM', 'LAO', 'MMR', 'MYS'].includes(c.id)).map((c) => ({
    id: c.id,
    rings: (c.geometry.type === 'Polygon' ? [c.geometry.coordinates] : c.geometry.coordinates).map((p) => p[0]),
  }));
  const who = (x: number, y: number) => polys.find((p) => p.rings.some((r) => inRing(x, y, r)))?.id ?? null;
  const out: Record<string, [number, number][][]> = {};
  for (const pts of lines) {
    const step = Math.max(1, Math.floor(pts.length / 300));
    const labs: string[] = new Array(pts.length);
    const idx: number[] = [];
    for (let i = 0; i < pts.length; i += step) idx.push(i);
    if (idx[idx.length - 1] !== pts.length - 1) idx.push(pts.length - 1);
    const raw = idx.map((i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], c = pts[i];
      const kx = kmLon(c[1]);
      const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * KM_LAT;
      const L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L, ny = dx / L;
      const f: string[] = [];
      for (const d of [2, 5]) for (const s of [1, -1]) { const w = who(c[0] + (s * nx * d) / kx, c[1] + (s * ny * d) / KM_LAT); if (w) f.push(w); }
      return f.length ? f.sort((x, y) => f.filter((v) => v === y).length - f.filter((v) => v === x).length)[0] : 'unknown';
    });
    const sm = raw.map((_, k) => {
      const w = raw.slice(Math.max(0, k - 4), k + 5).filter((x) => x !== 'unknown');
      return w.length ? w.sort((x, y) => w.filter((v) => v === y).length - w.filter((v) => v === x).length)[0] : 'unknown';
    });
    idx.forEach((i, k) => (labs[i] = sm[k]));
    let last = labs[0];
    for (let i = 0; i < pts.length; i++) labs[i] === undefined ? (labs[i] = last) : (last = labs[i]);
    let run: [number, number][] = [pts[0]], cur = labs[0];
    for (let i = 1; i < pts.length; i++) {
      run.push(pts[i]);
      if (labs[i] !== cur || i === pts.length - 1) {
        if (run.length > 1) (out[cur] ??= []).push(run);
        run = [pts[i]];
        cur = labs[i];
      }
    }
  }
  return out;
}

/** Import a GeoJSON boundary file (text). Returns what was stored. */
export async function importBoundary(name: string, text: string): Promise<CustomBoundary> {
  const j = JSON.parse(text);
  const feats: any[] = j.type === 'FeatureCollection' ? j.features : j.type === 'Feature' ? [j] : [{ type: 'Feature', properties: {}, geometry: j }];
  const labelled: Record<string, [number, number][][]> = {};
  const loose: [number, number][][] = [];
  for (const f of feats) {
    const g = f?.geometry;
    if (!g) continue;
    const parts: number[][][] = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : [];
    const ls = parts.filter((p) => p.length > 1).map((p) => p.map((c) => [c[0], c[1]] as [number, number]));
    const nb = String(f.properties?.nb ?? '').toUpperCase();
    if (['KHM', 'LAO', 'MMR', 'MYS', 'COAST', 'UNKNOWN'].includes(nb)) (labelled[nb === 'COAST' ? 'coast' : nb === 'UNKNOWN' ? 'unknown' : nb] ??= []).push(...ls);
    else loose.push(...ls);
  }
  const all = Object.values(labelled).flat().concat(loose);
  if (!all.length) throw new Error('ไม่พบเส้น (LineString/MultiLineString) ในไฟล์');
  const xs = all.flat().map((p) => p[0]), ys = all.flat().map((p) => p[1]);
  if (Math.min(...xs) < -180 || Math.max(...xs) > 180 || Math.min(...ys) < -90 || Math.max(...ys) > 90)
    throw new Error('พิกัดไม่ใช่องศา (WGS84 lon/lat) — แปลงไฟล์เป็น EPSG:4326 ก่อน');
  const lines = { ...labelled };
  if (loose.length) {
    const c = await classify(loose);
    for (const [k, v] of Object.entries(c)) (lines[k] ??= []).push(...v);
  }
  const lengthKm: Record<string, number> = {};
  for (const [k, v] of Object.entries(lines)) lengthKm[k] = v.reduce((t, l) => t + lineKm(l), 0);
  const b: CustomBoundary = { name, importedAt: new Date().toISOString(), lines, lengthKm };
  await idb('readwrite', (s) => s.put(b, 'current'));
  cache = b;
  listeners.forEach((f) => f());
  return b;
}
