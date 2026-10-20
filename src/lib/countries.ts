// Country outlines for highlighting on the map: Natural Earth 1:50m admin-0 (public domain),
// loaded on demand from the jsDelivr CDN and cached in memory for the session.
export interface Country {
  id: string; // ISO A3 (or Natural Earth ADM0_A3 when ISO is missing)
  name: string;
  nameTh: string;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

const SOURCES = [
  'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_50m_admin_0_countries.geojson',
  'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_admin_0_countries.geojson',
  'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_admin_0_countries.geojson',
];

let cache: Promise<Country[]> | null = null;

export function loadCountries(): Promise<Country[]> {
  if (!cache) {
    cache = (async () => {
      let lastErr: unknown = null;
      for (const url of SOURCES) {
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const j = await r.json();
          const out: Country[] = [];
          for (const f of j.features ?? []) {
            const p = f.properties ?? {};
            const g = f.geometry;
            if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
            const iso = p.ISO_A3 && p.ISO_A3 !== '-99' ? p.ISO_A3 : p.ADM0_A3;
            out.push({ id: String(iso), name: String(p.NAME ?? p.ADMIN ?? iso), nameTh: String(p.NAME_TH ?? ''), geometry: g });
          }
          if (out.length) return out.sort((a, b) => a.name.localeCompare(b.name));
        } catch (e) {
          lastErr = e;
        }
      }
      cache = null;
      throw new Error(`Country outlines unavailable (${(lastErr as Error)?.message ?? 'network'})`);
    })();
  }
  return cache;
}

export const ASEAN = ['THA', 'MMR', 'LAO', 'KHM', 'VNM', 'MYS', 'SGP', 'IDN', 'PHL', 'BRN', 'TLS'];
