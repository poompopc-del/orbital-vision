// Satellites the user adds by NORAD catalogue number. Element sets are fetched from CelesTrak
// (via /api/tle?catnr= on Vercel, or directly in local dev) and kept in this browser.
import { parseTleText, type SatRecord } from './orbit';
import { CUSTOM_MISSION } from '../data/missions';
import { bumpQuota } from './quotas';
import { logAudit } from './repo';

const KEY = 'ov.custom.sats.v1';
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

interface Entry {
  id: string;
  tle: string;
  fetchedAt: string;
}

function read(): Entry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}
function write(e: Entry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(e));
  } catch {
    /* ignore */
  }
}

export class NotFoundError extends Error {}

async function fetchTle(id: string): Promise<string> {
  bumpQuota('tle');
  try {
    const r = await fetch(`/api/tle?catnr=${id}`);
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('json')) {
      const j = await r.json();
      if (r.status === 404) throw new NotFoundError(id);
      if (r.ok && j.tle) return j.tle;
    }
  } catch (e) {
    if (e instanceof NotFoundError) throw e;
  }
  const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${id}&FORMAT=3le`);
  if (!r.ok) throw new Error(`CelesTrak HTTP ${r.status}`);
  const text = await r.text();
  if (!text.trim() || /No GP data found/i.test(text)) throw new NotFoundError(id);
  return text;
}

function toRecord(e: Entry): SatRecord | null {
  const rec = parseTleText(e.tle)[0];
  if (!rec) return null;
  if (!rec.mission) rec.mission = CUSTOM_MISSION;
  rec.custom = true;
  return rec;
}

export function customRecords(): SatRecord[] {
  return read().map(toRecord).filter(Boolean) as SatRecord[];
}

export function customIds(): string[] {
  return read().map((e) => e.id);
}

export function normaliseNorad(input: string): string | null {
  const s = input.trim();
  return /^\d{1,9}$/.test(s) ? String(parseInt(s, 10)) : null;
}

export async function addCustom(id: string): Promise<SatRecord> {
  const tle = await fetchTle(id);
  const entry: Entry = { id, tle, fetchedAt: new Date().toISOString() };
  const rec = toRecord(entry);
  if (!rec) throw new NotFoundError(id);
  write([...read().filter((e) => e.id !== id), entry]);
  void logAudit('custom_sat.add', { norad: id, name: rec.name });
  return rec;
}

export function removeCustom(id: string) {
  write(read().filter((e) => e.id !== id));
  void logAudit('custom_sat.remove', { norad: id });
}

/** Re-fetch element sets older than ~2 h. Failures keep the old elements. */
export async function refreshStaleCustom(): Promise<void> {
  const list = read();
  let changed = false;
  for (const e of list) {
    if (Date.now() - new Date(e.fetchedAt).getTime() < MAX_AGE_MS) continue;
    try {
      e.tle = await fetchTle(e.id);
      e.fetchedAt = new Date().toISOString();
      changed = true;
    } catch {
      /* keep previous elements */
    }
  }
  if (changed) write(list);
}

export function mergeCustom(base: SatRecord[]): SatRecord[] {
  const ids = new Set(base.map((s) => s.noradId));
  return [...base, ...customRecords().filter((c) => !ids.has(c.noradId))];
}
