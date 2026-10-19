// Ground-observer passes: when a satellite is above the observer's horizon.
// Uses SGP4 positions from public elements — an estimate, not a confirmed schedule.
import * as sat from 'satellite.js';
import { confidenceForAge, elementAgeDays, solarElevationDeg, type SatRecord } from './orbit';

const RAD = Math.PI / 180;

export interface Observer {
  name: string;
  lat: number;
  lon: number;
  heightKm: number;
}

export interface Look {
  az: number;
  el: number;
  rangeKm: number;
}

export function lookAngles(rec: SatRecord, date: Date, obs: Observer): Look | null {
  const pv = sat.propagate(rec.satrec, date);
  const pos = pv && (pv as any).position;
  if (!pos || typeof pos === 'boolean') return null;
  const ecf = sat.eciToEcf(pos as sat.EciVec3<number>, sat.gstime(date));
  const la = sat.ecfToLookAngles({ longitude: obs.lon * RAD, latitude: obs.lat * RAD, height: obs.heightKm } as any, ecf);
  return { az: ((la.azimuth / RAD) + 360) % 360, el: la.elevation / RAD, rangeKm: la.rangeSat };
}

export interface SkySample {
  t: Date;
  az: number;
  el: number;
}

export interface VisiblePass {
  sat: SatRecord;
  aos: Date;
  tca: Date;
  los: Date;
  maxEl: number;
  aosAz: number;
  losAz: number;
  durationS: number;
  samples: SkySample[];
  sunAtObserver: number;
  inProgressAtStart: boolean;
  confidence: { label: string; tone: 'ok' | 'warn' | 'bad' };
}

const elAt = (rec: SatRecord, t: number, obs: Observer) => lookAngles(rec, new Date(t), obs)?.el ?? -90;

/** Binary-search the moment elevation crosses `minEl` between t0 (below) and t1 (above), or vice versa. */
function crossing(rec: SatRecord, obs: Observer, t0: number, t1: number, minEl: number): number {
  let a = t0, b = t1;
  const aAbove = elAt(rec, a, obs) >= minEl;
  for (let i = 0; i < 14; i++) {
    const m = (a + b) / 2;
    if ((elAt(rec, m, obs) >= minEl) === aAbove) a = m;
    else b = m;
  }
  return (a + b) / 2;
}

export function findVisiblePasses(rec: SatRecord, obs: Observer, start: Date, hours: number, minEl = 10): VisiblePass[] {
  if (rec.periodMin > 300) return []; // GEO / high orbits: no discrete passes
  const step = 20_000;
  const end = start.getTime() + hours * 3600e3;
  const out: VisiblePass[] = [];
  let prevT = start.getTime();
  let prevAbove = elAt(rec, prevT, obs) >= minEl;
  let cur: { aos: number; inProgress: boolean } | null = prevAbove ? { aos: prevT, inProgress: true } : null;

  for (let t = prevT + step; t <= end + step; t += step) {
    const above = elAt(rec, t, obs) >= minEl;
    if (above && !prevAbove) cur = { aos: crossing(rec, obs, prevT, t, minEl), inProgress: false };
    if (!above && prevAbove && cur) {
      const los = crossing(rec, obs, prevT, t, minEl);
      const samples: SkySample[] = [];
      let best = { t: cur.aos, el: -90 };
      const n = Math.max(8, Math.min(80, Math.round((los - cur.aos) / 10_000)));
      for (let i = 0; i <= n; i++) {
        const ti = cur.aos + ((los - cur.aos) * i) / n;
        const l = lookAngles(rec, new Date(ti), obs);
        if (!l) continue;
        samples.push({ t: new Date(ti), az: l.az, el: l.el });
        if (l.el > best.el) best = { t: ti, el: l.el };
      }
      if (samples.length >= 2) {
        const tca = new Date(best.t);
        out.push({
          sat: rec,
          aos: new Date(cur.aos),
          tca,
          los: new Date(los),
          maxEl: best.el,
          aosAz: samples[0].az,
          losAz: samples[samples.length - 1].az,
          durationS: (los - cur.aos) / 1000,
          samples,
          sunAtObserver: solarElevationDeg(tca, obs.lat, obs.lon),
          inProgressAtStart: cur.inProgress,
          confidence: confidenceForAge(elementAgeDays(rec, tca)),
        });
      }
      cur = null;
    }
    prevT = t;
    prevAbove = above;
  }
  return out;
}

export async function findVisiblePassesBatched(
  sats: SatRecord[],
  obs: Observer,
  start: Date,
  hours: number,
  minEl: number,
  onProgress?: (done: number, total: number) => void,
): Promise<VisiblePass[]> {
  const all: VisiblePass[] = [];
  for (let i = 0; i < sats.length; i++) {
    all.push(...findVisiblePasses(sats[i], obs, start, hours, minEl));
    onProgress?.(i + 1, sats.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  return all.sort((a, b) => a.aos.getTime() - b.aos.getTime());
}

export const compass = (az: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];
