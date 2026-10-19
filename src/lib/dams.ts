// Reservoir status from the Royal Irrigation Department public API (via /api/dams),
// located by matching dam names against OpenStreetMap. Nothing here is estimated or simulated.
import { thaiDamLocations, type OsmDam } from './overpass';

export interface DamStatus {
  id: string;
  name: string;
  group: string;
  owner: string;
  capacity: number | null; // million m³ (ล้าน ลบ.ม.)
  normalStorage: number | null; // million m³
  volume: number | null; // million m³ — current storage
  percent: number | null; // % as reported by RID
  inflow: number | null; // million m³/day as reported
  outflow: number | null; // million m³/day as reported
  lat: number | null;
  lon: number | null;
  locationSource: string | null;
  raw: any;
}

export interface DamsResult {
  dams: DamStatus[];
  reportDate: string | null;
  fetchedAt: string;
  source: string;
  locationsNote: string;
}

const num = (v: any): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/เขื่อน|อ่างเก็บน้ำ|อ่างฯ|ฯ|dam|reservoir|\(.*?\)/g, '')
    .replace(/[\s.\-_]/g, '');

function locate(name: string, osm: OsmDam[]): OsmDam | null {
  const k = norm(name);
  if (k.length < 3) return null;
  let best: OsmDam | null = null;
  for (const d of osm) {
    for (const cand of [d.nameTh, d.name, d.nameEn]) {
      if (!cand) continue;
      const c = norm(cand);
      if (c === k) return d;
      if (!best && c.length >= 3 && (c.includes(k) || k.includes(c))) best = d;
    }
  }
  return best;
}

/** Percentage of capacity. Uses RID's own figure when present; otherwise current ÷ maximum × 100. */
export function storagePct(d: DamStatus): number | null {
  if (d.percent != null) return d.percent;
  if (d.volume != null && d.capacity) return (d.volume / d.capacity) * 100;
  return null;
}

/** RID reports flows per day in million m³; 1 million m³/day ≈ 11.574 m³/s. */
export const mcmPerDayToM3s = (v: number) => (v * 1e6) / 86400;

export async function loadDams(): Promise<DamsResult> {
  const r = await fetch('/api/dams');
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) throw new Error('The /api/dams proxy is only available on the deployed site (Vercel).');
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);

  let osm: OsmDam[] = [];
  let locationsNote = '';
  try {
    const o = await thaiDamLocations();
    osm = o.dams;
    locationsNote = `OpenStreetMap name match · ${o.dams.length} named dams/reservoirs · ${o.fetchedAt.slice(0, 10)}`;
  } catch (e: any) {
    locationsNote = `OpenStreetMap unavailable (${e.message}) — dams listed without map pins`;
  }

  const groups: any[] = Array.isArray(j.data?.data) ? j.data.data : [];
  const dams: DamStatus[] = [];
  for (const g of groups) {
    const gName = g.region ?? g.name ?? g.title ?? g.group ?? '';
    for (const d of Array.isArray(g.dam) ? g.dam : []) {
      const name = String(d.name ?? '');
      const loc = locate(name, osm);
      dams.push({
        id: String(d.id ?? name),
        name,
        group: String(gName || ''),
        owner: String(d.owner ?? ''),
        capacity: num(d.capacity),
        normalStorage: num(d.storage),
        volume: num(d.volume),
        percent: num(d.percent_storage),
        inflow: num(d.inflow),
        outflow: num(d.outflow),
        lat: loc?.lat ?? null,
        lon: loc?.lon ?? null,
        locationSource: loc ? `OSM ${loc.osmId} (${loc.nameTh || loc.name})` : null,
        raw: d,
      });
    }
  }
  if (!dams.length) throw new Error('RID response contained no dam records');
  return { dams, reportDate: j.data?.date ?? null, fetchedAt: j.fetchedAt, source: j.source, locationsNote };
}
