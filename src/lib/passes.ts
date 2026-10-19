import { confidenceForAge, elementAgeDays, haversineKm, propagateSubPoint, solarElevationDeg, type SatRecord } from './orbit';
import { aoiRadiusKm, centroid } from './geo';

export interface PassEstimate {
  sat: SatRecord;
  start: Date;
  end: Date;
  tca: Date; // time of closest approach of ground track to AOI centroid
  minDistKm: number;
  estCoveragePct: number | null;
  direction: 'ascending' | 'descending';
  sunElevationDeg: number;
  basis: 'nominal-swath' | 'proximity-only';
  confidence: { label: string; tone: 'ok' | 'warn' | 'bad' };
  notes: string[];
}

const PROXIMITY_KM = 400;

export function findPasses(sat: SatRecord, aoi: GeoJSON.Polygon, start: Date, hours: number): PassEstimate[] {
  if (sat.periodMin > 300) return []; // GEO / high orbits: no discrete passes
  const [clon, clat] = centroid(aoi);
  const rA = aoiRadiusKm(aoi);
  const half = sat.mission?.swathKm ? sat.mission.swathKm / 2 : null;
  const reach = (half ?? PROXIMITY_KM) + rA;
  const coarse = 60;
  const groundSpeed = 7.5; // km/s, conservative upper bound for LEO sub-point speed
  const coarseReach = reach + (coarse / 2) * groundSpeed;
  const out: PassEstimate[] = [];
  const end = start.getTime() + hours * 3600e3;

  for (let t = start.getTime(); t <= end; t += coarse * 1000) {
    const p = propagateSubPoint(sat, new Date(t));
    if (!p) continue;
    if (haversineKm(p.lat, p.lon, clat, clon) > coarseReach) continue;
    // refine inside the coarse window
    let best = { d: Infinity, t: t, lat: p.lat };
    let inStart: number | null = null;
    let inEnd: number | null = null;
    let prevLat = p.lat;
    let dir: 'ascending' | 'descending' = 'ascending';
    for (let u = t - coarse * 1000; u <= t + coarse * 1000; u += 5000) {
      const q = propagateSubPoint(sat, new Date(u));
      if (!q) continue;
      const d = haversineKm(q.lat, q.lon, clat, clon);
      if (d <= reach) {
        if (inStart == null) inStart = u;
        inEnd = u;
      }
      if (d < best.d) {
        best = { d, t: u, lat: q.lat };
        dir = q.lat >= prevLat ? 'ascending' : 'descending';
      }
      prevLat = q.lat;
    }
    if (inStart == null || inEnd == null) continue;
    // skip duplicate detections of the same pass
    const last = out[out.length - 1];
    if (last && Math.abs(last.tca.getTime() - best.t) < 10 * 60e3) {
      if (best.d < last.minDistKm) {
        last.minDistKm = best.d;
        last.tca = new Date(best.t);
      }
      last.end = new Date(Math.max(last.end.getTime(), inEnd));
      continue;
    }
    const tca = new Date(best.t);
    const sun = solarElevationDeg(tca, clat, clon);
    let cov: number | null = null;
    if (half != null) {
      if (best.d + rA <= half) cov = 100;
      else cov = Math.max(0, Math.min(100, ((half + rA - best.d) / (2 * rA || 1)) * 100));
    }
    const optical = sat.mission && sat.mission.sensor !== 'sar';
    const notes: string[] = [];
    if (optical && sun < 0) notes.push('Night at AOI — optical imaging unlikely to be usable');
    if (optical && sun >= 0 && sun < 10) notes.push('Low sun elevation');
    if (!half) notes.push('No documented swath — ground-track proximity only');
    if (sat.mission?.tasking === 'commercial') notes.push('Agile pointing may widen or narrow real access; provider decides');
    if (sat.mission?.tasking === 'none') notes.push('Systematic mission — acquisition depends on the operator’s plan');
    out.push({
      sat,
      start: new Date(inStart),
      end: new Date(inEnd),
      tca,
      minDistKm: best.d,
      estCoveragePct: cov,
      direction: dir,
      sunElevationDeg: sun,
      basis: half ? 'nominal-swath' : 'proximity-only',
      confidence: confidenceForAge(elementAgeDays(sat, tca)),
      notes,
    });
    t = Math.max(t, inEnd); // jump past this pass
  }
  return out;
}

/** Runs findPasses for many satellites without freezing the UI. */
export async function findPassesBatched(
  sats: SatRecord[],
  aoi: GeoJSON.Polygon,
  start: Date,
  hours: number,
  onProgress?: (done: number, total: number) => void,
): Promise<PassEstimate[]> {
  const all: PassEstimate[] = [];
  for (let i = 0; i < sats.length; i++) {
    all.push(...findPasses(sats[i], aoi, start, hours));
    onProgress?.(i + 1, sats.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  return all.sort((a, b) => a.tca.getTime() - b.tca.getTime());
}
