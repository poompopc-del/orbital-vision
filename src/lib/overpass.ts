// OpenStreetMap data via the public Overpass API (© OpenStreetMap contributors, ODbL).
// Used for dam locations (the RID API has no coordinates) and mapped waterways for comparison with DEM results.

// Public Overpass servers, tried in order. The main one (overpass-api.de) is often overloaded or
// unreachable from some networks; the first server that answers is remembered for this page load.
const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
let preferred = 0;

async function tryServer(url: string, query: string, timeoutMs: number, signal?: AbortSignal): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const stop = () => ctrl.abort();
  signal?.addEventListener('abort', stop);
  try {
    const r = await fetch(url, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Overpass HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

/** Run an Overpass query, falling back to the next public server when one fails or is too slow. */
export async function overpass(query: string, timeoutMs = 60000, signal?: AbortSignal): Promise<any> {
  // each server gets a share of the time budget (at least 15 s), the remembered good one first
  const order = [preferred, ...SERVERS.map((_, i) => i).filter((i) => i !== preferred)];
  const each = Math.max(15000, Math.floor(timeoutMs / 2));
  let last: unknown = null;
  for (const i of order) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const j = await tryServer(SERVERS[i], query, each, signal);
      preferred = i;
      return j;
    } catch (e) {
      if (signal?.aborted) throw e;
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error('Overpass servers unavailable');
}

export interface OsmDam {
  osmId: string;
  name: string;
  nameTh: string;
  nameEn: string;
  lat: number;
  lon: number;
}

const DAM_KEY = 'ov.osm.dams.th.v1';
const DAM_MAX_AGE = 30 * 86400e3;

/** Named dams and reservoirs mapped in OpenStreetMap inside Thailand (cached 30 days). */
export async function thaiDamLocations(): Promise<{ dams: OsmDam[]; fetchedAt: string; cached: boolean }> {
  try {
    const c = JSON.parse(localStorage.getItem(DAM_KEY) || 'null');
    if (c && Date.now() - new Date(c.fetchedAt).getTime() < DAM_MAX_AGE) return { ...c, cached: true };
  } catch {
    /* ignore */
  }
  const q = `[out:json][timeout:60];area["ISO3166-1"="TH"][admin_level=2]->.th;
(nwr["waterway"="dam"]["name"](area.th);nwr["water"="reservoir"]["name"](area.th););out center tags;`;
  const j = await overpass(q, 90000);
  const dams: OsmDam[] = [];
  for (const e of j.elements || []) {
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat == null || lon == null) continue;
    const tg = e.tags || {};
    dams.push({ osmId: `${e.type}/${e.id}`, name: tg.name || '', nameTh: tg['name:th'] || '', nameEn: tg['name:en'] || '', lat, lon });
  }
  const out = { dams, fetchedAt: new Date().toISOString() };
  try {
    localStorage.setItem(DAM_KEY, JSON.stringify(out));
  } catch {
    /* ignore */
  }
  return { ...out, cached: false };
}

export interface OsmLine {
  id: string;
  kind: string;
  name: string;
  coords: [number, number][];
}

/** Mapped rivers / streams / canals inside a bbox (west, south, east, north). */
export async function waterwaysInBbox(w: number, s: number, e: number, n: number): Promise<OsmLine[]> {
  const q = `[out:json][timeout:40];way["waterway"~"^(river|stream|canal|drain)$"](${s},${w},${n},${e});out geom tags;`;
  const j = await overpass(q, 50000);
  return (j.elements || [])
    .filter((el: any) => Array.isArray(el.geometry) && el.geometry.length > 1)
    .map((el: any) => ({
      id: String(el.id),
      kind: el.tags?.waterway || '',
      name: el.tags?.name || '',
      coords: el.geometry.map((g: any) => [g.lon, g.lat] as [number, number]),
    }));
}
