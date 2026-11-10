// Reference points the user imports — boundary pillars (หลักเขต), hills (เนิน), passes (ช่อง) and
// other named spots — shown on the map and used to describe where a detection is
// ("1.2 km west of boundary pillar 7"), the way field reports do.
//
// Like the imported boundary (boundary.ts), the points stay in this browser (IndexedDB): they are
// never uploaded and never bundled with the site, because such lists are often restricted.
// Read with the same importer as the watch-area import (coordImport.ts): CSV/TSV/Excel, KML/KMZ,
// GeoJSON, GPX, Shapefile, WKT or pasted lines; WGS84, UTM and Indian 1975 UTM.

export type RefKind = 'marker' | 'hill' | 'pass' | 'other';
export interface RefPoint {
  name: string;
  lon: number;
  lat: number;
  kind: RefKind;
}
export interface RefSet {
  name: string;
  importedAt: string;
  points: RefPoint[];
}
export interface Near {
  name: string;
  km: number;
  /** direction FROM the reference point TO the place, degrees clockwise from north */
  bearingDeg: number;
}

export const REF_KINDS: { id: RefKind; th: string; en: string; color: string }[] = [
  { id: 'marker', th: 'หลักเขตแดน', en: 'Boundary pillar', color: '#ef4444' },
  { id: 'hill', th: 'เนิน / ยอดเขา', en: 'Hill / peak', color: '#f59e0b' },
  { id: 'pass', th: 'ช่องทาง', en: 'Pass / crossing', color: '#22d3ee' },
  { id: 'other', th: 'จุดอื่น', en: 'Other', color: '#e2e8f0' },
];

/** Kind from the point's name (Thai and English conventions of border maps). */
export function refKind(name: string): RefKind {
  const n = name.trim();
  if (/หลักเขต|^ลข\.?\s*\d|boundary\s*(pillar|post|marker)|^BP\s*\d|^pillar/i.test(n)) return 'marker';
  if (/^เนิน|^ยอด|^ภู|^เขา|^ดอย|^hill|^peak|^mt\.?\s|\bhill\b/i.test(n)) return 'hill';
  if (/^ช่อง|^จุดผ่าน|pass\b|crossing|checkpoint/i.test(n)) return 'pass';
  return 'other';
}

const KM_LAT = 110.574;
const kmLon = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);

/** Nearest reference point within maxKm (flat-earth distances are exact enough at these ranges). */
export function nearestRef(lon: number, lat: number, refs: RefPoint[], maxKm = 15): Near | null {
  let best: Near | null = null;
  for (const r of refs) {
    const dx = (lon - r.lon) * kmLon((lat + r.lat) / 2), dy = (lat - r.lat) * KM_LAT;
    const km = Math.hypot(dx, dy);
    if (km > maxKm || (best && km >= best.km)) continue;
    best = { name: r.name, km, bearingDeg: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 };
  }
  return best;
}

const DIR_TH = ['เหนือ', 'ตะวันออกเฉียงเหนือ', 'ตะวันออก', 'ตะวันออกเฉียงใต้', 'ใต้', 'ตะวันตกเฉียงใต้', 'ตะวันตก', 'ตะวันตกเฉียงเหนือ'];
const DIR_EN = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const dir8 = (deg: number) => Math.round((((deg % 360) + 360) % 360) / 45) % 8;

/** "1.2 กม. ทางทิศตะวันตกของหลักเขตหมายเลข 7" / "1.2 km west of boundary pillar 7". */
export function nearText(n: Near, th: boolean): string {
  if (n.km < 0.1) return th ? `ที่${n.name}` : `at ${n.name}`;
  const km = n.km < 10 ? n.km.toFixed(1) : Math.round(n.km).toString();
  const d = dir8(n.bearingDeg);
  return th ? `${km} กม. ทางทิศ${DIR_TH[d]}ของ${n.name}` : `${km} km ${DIR_EN[d]} of ${n.name}`;
}

// ---------------------------------------------------------------- storage (this browser only)

const DB = 'ov-refpoints';
const STORE = 'r';
function db(): Promise<IDBDatabase> {
  return new Promise((ok, bad) => {
    if (typeof indexedDB === 'undefined') return bad(new Error('no IndexedDB'));
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

let cache: RefSet | null | undefined;
const listeners = new Set<() => void>();
export const onRefChange = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};
const changed = () => listeners.forEach((f) => f());

export async function getRefSet(): Promise<RefSet | null> {
  if (cache !== undefined) return cache;
  try {
    cache = (await idb<RefSet | undefined>('readonly', (s) => s.get('current'))) ?? null;
  } catch {
    cache = null; // no IndexedDB (e.g. the server checker): no reference points
  }
  return cache;
}
export const getRefPoints = async () => (await getRefSet())?.points ?? [];

export async function clearRefPoints() {
  await idb('readwrite', (s) => s.delete('current')).catch(() => {});
  cache = null;
  changed();
}

/** Read files with the coordinate importer and keep their points (shapes count by their centre). Replaces any earlier set. */
export async function importRefFiles(list: File[]): Promise<{ set: RefSet; warnings: { th: string; en: string }[] }> {
  const { importCoordFiles, filesFromInput } = await import('./coordImport');
  const r = await importCoordFiles(await filesFromInput(list));
  const points: RefPoint[] = r.places
    .filter((p) => p.kind === 'point' || p.kind === 'polygon')
    .map((p) => ({ name: p.name, lon: p.lon, lat: p.lat, kind: refKind(p.name) }));
  if (!points.length) throw new Error(r.warnings.map((w) => w.th).join(' · ') || 'ไม่พบจุดในไฟล์');
  const set: RefSet = { name: list.map((f) => f.name).join(', '), importedAt: new Date().toISOString(), points };
  await idb('readwrite', (s) => s.put(set, 'current'));
  cache = set;
  changed();
  return { set, warnings: r.warnings };
}
