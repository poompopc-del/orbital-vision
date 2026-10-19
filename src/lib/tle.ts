import { parseTleText, type SatRecord } from './orbit';
import { bumpQuota } from './quotas';
import { logAudit } from './repo';

const CACHE_KEY = 'ov.tle.cache.v1';
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // CelesTrak asks for ≤ 1 download per ~2 h

const DIRECT_QUERIES = [
  'GROUP=resource', 'GROUP=planet', 'GROUP=weather',
  'NAME=SENTINEL', 'NAME=LANDSAT', 'NAME=WORLDVIEW', 'NAME=GEOEYE', 'NAME=PLEIADES', 'NAME=SPOT',
  'NAME=BLACKSKY', 'NAME=NUSAT', 'NAME=ICEYE', 'NAME=CAPELLA', 'NAME=UMBRA', 'NAME=THEOS',
];

export interface TleLoadResult {
  sats: SatRecord[];
  source: string;
  fetchedAt: Date;
  fromCache: boolean;
  warnings: string[];
}

function readCache(): { tle: string; source: string; fetchedAt: string } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(tle: string, source: string, fetchedAt: string) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ tle, source, fetchedAt }));
  } catch {
    /* storage full or blocked — fine */
  }
}

async function fetchViaApi(): Promise<{ tle: string; source: string; fetchedAt: string; warnings: string[] }> {
  const r = await fetch('/api/tle');
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || !ct.includes('json')) throw new Error(`api/tle unavailable (${r.status})`);
  const j = await r.json();
  return { tle: j.tle, source: `${j.source} via /api/tle`, fetchedAt: j.fetchedAt, warnings: j.partialErrors || [] };
}

async function fetchDirect(): Promise<{ tle: string; source: string; fetchedAt: string; warnings: string[] }> {
  const warnings: string[] = [];
  const chunks = await Promise.all(
    DIRECT_QUERIES.map(async (q) => {
      try {
        const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?${q}&FORMAT=3le`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const t = await r.text();
        return /No GP data found/i.test(t) ? '' : t;
      } catch (e: any) {
        warnings.push(`${q}: ${e.message}`);
        return '';
      }
    }),
  );
  const tle = chunks.join('\n');
  if (!tle.trim()) throw new Error('CelesTrak unreachable from this browser');
  return { tle, source: 'CelesTrak GP (3LE), direct', fetchedAt: new Date().toISOString(), warnings };
}

export async function loadOrbitalData(force = false): Promise<TleLoadResult> {
  const cached = readCache();
  if (!force && cached && Date.now() - new Date(cached.fetchedAt).getTime() < MAX_AGE_MS) {
    return { sats: dedupe(parseTleText(cached.tle)), source: cached.source, fetchedAt: new Date(cached.fetchedAt), fromCache: true, warnings: [] };
  }
  let got;
  try {
    got = await fetchViaApi();
  } catch {
    got = await fetchDirect();
  }
  bumpQuota('tle');
  writeCache(got.tle, got.source, got.fetchedAt);
  void logAudit('orbital_data.refresh', { source: got.source });
  return { sats: dedupe(parseTleText(got.tle)), source: got.source, fetchedAt: new Date(got.fetchedAt), fromCache: false, warnings: got.warnings };
}

function dedupe(list: SatRecord[]): SatRecord[] {
  const m = new Map<string, SatRecord>();
  for (const s of list) if (!m.has(s.noradId)) m.set(s.noradId, s);
  // keep only satellites tied to a known Earth-observation / weather mission
  return [...m.values()].filter((s) => s.mission).sort((a, b) => a.name.localeCompare(b.name));
}

export function cachedOrbitalData(): TleLoadResult | null {
  const c = readCache();
  if (!c) return null;
  return { sats: dedupe(parseTleText(c.tle)), source: c.source, fetchedAt: new Date(c.fetchedAt), fromCache: true, warnings: [] };
}
