// Local usage counters (per browser) so the Administration page can show call volumes
// against public services that have fair-use policies.
export type QuotaKey = 'tle' | 'stac' | 'geocode';

const KEY = 'ov.quotas.v1';
export const QUOTA_LIMITS: Record<QuotaKey, { label: string; perDay: number; policy: string }> = {
  tle: { label: 'CelesTrak orbital data downloads', perDay: 12, policy: 'CelesTrak: avoid re-downloading the same data more than every ~2 h' },
  stac: { label: 'Earth Search STAC queries', perDay: 500, policy: 'Public endpoint — keep usage reasonable' },
  geocode: { label: 'Nominatim geocoding requests', perDay: 200, policy: 'OSM Nominatim: max 1 request/second, no bulk use' },
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function readQuotas(): Record<QuotaKey, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (raw.day !== today()) return { tle: 0, stac: 0, geocode: 0 };
    return { tle: raw.tle || 0, stac: raw.stac || 0, geocode: raw.geocode || 0 };
  } catch {
    return { tle: 0, stac: 0, geocode: 0 };
  }
}

export function bumpQuota(k: QuotaKey) {
  try {
    const q = readQuotas();
    q[k] += 1;
    localStorage.setItem(KEY, JSON.stringify({ day: today(), ...q }));
  } catch {
    /* ignore */
  }
}
