// Target list kept in THIS browser only (IndexedDB) — never sent to a server. Imported from the
// user's own file (CSV / Excel / KML / KMZ / GeoJSON / GPX / Shapefile zip) with the coordinate importer.
import { pointAoi } from './geo';

export interface Target {
  id: string;
  name: string;
  lon: number;
  lat: number;
  /** outline from the file (polygons); points get a square box of sizeKm */
  ring?: [number, number][];
  sizeKm: number;
}
export interface TargetSet {
  name: string;
  importedAt: string;
  targets: Target[];
}

export const DEFAULT_BOX_KM = 2;
export const BOX_SIZES = [1, 2, 3, 5, 10];

/** The area analysed for a target: its own outline, or a square box around the point. */
export function targetAoi(t: Pick<Target, 'lon' | 'lat' | 'ring' | 'sizeKm'>): GeoJSON.Polygon {
  if (t.ring && t.ring.length >= 4) return { type: 'Polygon', coordinates: [t.ring] };
  return pointAoi(t.lon, t.lat, t.sizeKm);
}

const DB = 'ov-targets';
const STORE = 't';
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

export async function loadTargets(): Promise<TargetSet | null> {
  try {
    return (await idb<TargetSet | undefined>('readonly', (s) => s.get('current'))) ?? null;
  } catch {
    return null;
  }
}

export async function saveTargets(set: TargetSet | null) {
  await idb('readwrite', (s) => (set ? s.put(set, 'current') : s.delete('current'))).catch(() => undefined);
}

/** Read the files; points and shapes become targets (shapes keep their outline). Replaces the earlier list. */
export async function importTargetFiles(list: File[]): Promise<{ set: TargetSet; warnings: string[] }> {
  const { importCoordFiles, filesFromInput } = await import('./coordImport');
  const r = await importCoordFiles(await filesFromInput(list));
  const targets: Target[] = r.places
    .filter((p) => p.kind === 'point' || p.kind === 'polygon')
    .map((p, i) => ({
      id: `t${i}_${p.lat.toFixed(5)}_${p.lon.toFixed(5)}`,
      name: p.name || `จุดที่ ${i + 1}`,
      lon: p.lon,
      lat: p.lat,
      ring: p.kind === 'polygon' ? p.ring : undefined,
      sizeKm: p.sizeKm && p.sizeKm > 0 ? p.sizeKm : DEFAULT_BOX_KM,
    }));
  if (!targets.length) throw new Error(r.warnings.map((w) => w.th).join(' · ') || 'ไม่พบพิกัดในไฟล์');
  const set: TargetSet = { name: list.map((f) => f.name).join(', '), importedAt: new Date().toISOString(), targets };
  await saveTargets(set);
  return { set, warnings: r.warnings.map((w) => w.th) };
}
