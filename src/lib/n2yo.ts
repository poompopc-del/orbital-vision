// N2YO (https://www.n2yo.com/api/) — primary source for single-satellite element sets and
// observer pass predictions. All calls go through /api/n2yo so the API key stays on the server.
// When the proxy is missing (local dev) or the key is not set, callers fall back to
// CelesTrak elements + local SGP4.
import { lookAngles, type Observer, type SkySample, type VisiblePass } from './lookangles';
import { confidenceForAge, elementAgeDays, solarElevationDeg, type SatRecord } from './orbit';
import { bumpQuota } from './quotas';

let status: Promise<boolean> | null = null;

/** True when /api/n2yo exists and the server has an API key. Checked once per page load. */
export function n2yoAvailable(): Promise<boolean> {
  if (!status) {
    status = fetch('/api/n2yo?op=status')
      .then(async (r) => {
        const ct = r.headers.get('content-type') || '';
        if (!r.ok || !ct.includes('json')) return false;
        return !!(await r.json()).configured;
      })
      .catch(() => false);
  }
  return status;
}

async function call(params: Record<string, string | number>): Promise<any> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  bumpQuota('n2yo');
  const r = await fetch(`/api/n2yo?${qs}`);
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) throw new Error(`api/n2yo unavailable (${r.status})`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `N2YO HTTP ${r.status}`);
  return j;
}

/** Three-line element set ("name / line 1 / line 2") for one NORAD id, or null if N2YO has none. */
export async function n2yoTle(id: string): Promise<string | null> {
  const j = await call({ op: 'tle', id });
  const lines = String(j.tle || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2 || !lines[0].startsWith('1 ') || !lines[1].startsWith('2 ')) return null;
  return `${j.info?.satname || id}\n${lines[0]}\n${lines[1]}`;
}

interface RadioPass {
  startAz: number;
  startUTC: number;
  maxAz: number;
  maxEl: number;
  maxUTC: number;
  endAz: number;
  endUTC: number;
}

/** Every pass above `minEl` (not only naked-eye visible ones), from now for `days` (1–10). */
export async function n2yoRadioPasses(id: string, obs: Observer, days: number, minEl: number): Promise<RadioPass[]> {
  const j = await call({
    op: 'radiopasses',
    id,
    lat: obs.lat.toFixed(3),
    lng: obs.lon.toFixed(3),
    alt: Math.round(obs.heightKm * 1000),
    days: Math.max(1, Math.min(10, Math.ceil(days))),
    minEl: Math.round(minEl),
  });
  return Array.isArray(j.passes) ? j.passes : [];
}

/** N2YO pass → the app's pass shape. Times and max elevation come from N2YO; the sky track
 *  drawn on the polar plot is filled in locally from the satellite's elements. */
function toVisiblePass(rec: SatRecord, p: RadioPass, obs: Observer, windowStart: number): VisiblePass {
  const aos = p.startUTC * 1000;
  const los = p.endUTC * 1000;
  const tca = new Date(p.maxUTC * 1000);
  const samples: SkySample[] = [];
  const n = Math.max(8, Math.min(80, Math.round((los - aos) / 10_000)));
  for (let i = 0; i <= n; i++) {
    const ti = aos + ((los - aos) * i) / n;
    const l = lookAngles(rec, new Date(ti), obs);
    if (l) samples.push({ t: new Date(ti), az: l.az, el: l.el });
  }
  return {
    sat: rec,
    aos: new Date(aos),
    tca,
    los: new Date(los),
    maxEl: p.maxEl,
    aosAz: p.startAz,
    losAz: p.endAz,
    durationS: (los - aos) / 1000,
    samples,
    sunAtObserver: solarElevationDeg(tca, obs.lat, obs.lon),
    inProgressAtStart: aos < windowStart,
    confidence: confidenceForAge(elementAgeDays(rec, tca)),
  };
}

/** The window N2YO can answer: it always predicts from "now" up to 10 days ahead. */
export function n2yoCovers(from: Date, to: Date): boolean {
  const now = Date.now();
  return from.getTime() >= now - 15 * 60e3 && to.getTime() <= now + 10 * 86400e3;
}

/**
 * Passes for many satellites from N2YO. A satellite N2YO does not know (or a failed call)
 * is computed locally with `fallback`, so one bad id never empties the list.
 * Returns the passes and how many satellites came from each source.
 */
export async function n2yoPassesBatched(
  sats: SatRecord[],
  obs: Observer,
  from: Date,
  to: Date,
  minEl: number,
  fallback: (rec: SatRecord) => VisiblePass[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ passes: VisiblePass[]; viaN2yo: number; viaLocal: number }> {
  const days = (to.getTime() - Date.now()) / 86400e3;
  const out: VisiblePass[] = [];
  let viaN2yo = 0;
  let viaLocal = 0;
  let done = 0;
  const queue = [...sats];
  const worker = async () => {
    while (queue.length) {
      const rec = queue.shift()!;
      if (rec.periodMin > 300) {
        // GEO / high orbits have no discrete passes
      } else {
        try {
          const ps = await n2yoRadioPasses(rec.noradId, obs, days, minEl);
          for (const p of ps) {
            if (p.endUTC * 1000 < from.getTime() || p.startUTC * 1000 > to.getTime()) continue;
            out.push(toVisiblePass(rec, p, obs, from.getTime()));
          }
          viaN2yo++;
        } catch {
          out.push(...fallback(rec));
          viaLocal++;
        }
      }
      onProgress?.(++done, sats.length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { passes: out.sort((a, b) => a.aos.getTime() - b.aos.getTime()), viaN2yo, viaLocal };
}
