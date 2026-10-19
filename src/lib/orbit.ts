import * as sat from 'satellite.js';
import { missionForName, type Mission } from '../data/missions';
import { providerById, type Provider } from '../data/providers';

const MU = 398600.4418; // km^3/s^2
const RE = 6378.137; // km

export interface SatRecord {
  noradId: string;
  name: string;
  intlDesignator: string;
  tle1: string;
  tle2: string;
  epoch: Date;
  satrec: sat.SatRec;
  inclinationDeg: number;
  periodMin: number;
  perigeeKm: number;
  apogeeKm: number;
  eccentricity: number;
  orbitType: string;
  mission?: Mission;
  provider?: Provider;
  custom?: boolean;
}

export interface SubPoint {
  lat: number; // deg
  lon: number; // deg
  heightKm: number;
}

function parseIntlDesignator(l1: string): string {
  const raw = l1.substring(9, 17).trim();
  if (!raw) return '';
  const yy = parseInt(raw.substring(0, 2), 10);
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return `${year}-${raw.substring(2)}`;
}

function epochFromSatrec(s: sat.SatRec): Date {
  // jdsatepoch is the Julian date of the element set epoch
  const jd = (s as any).jdsatepoch + ((s as any).jdsatepochF ?? 0);
  return new Date((jd - 2440587.5) * 86400000);
}

function classifyOrbit(incl: number, periodMin: number, ecc: number, perigee: number): string {
  if (Math.abs(periodMin - 1436.1) < 30 && ecc < 0.05) return incl < 5 ? 'GEO' : 'GSO (inclined)';
  if (ecc > 0.25) return 'HEO';
  if (perigee < 2000) {
    if (incl > 95 && incl < 102) return 'LEO · Sun-synchronous (inferred)';
    return 'LEO';
  }
  return 'MEO';
}

export function parseTleText(text: string): SatRecord[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const out: SatRecord[] = [];
  for (let i = 0; i + 2 < lines.length + 1; ) {
    const name = lines[i];
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!l1 || !l2 || !l1.startsWith('1 ') || !l2.startsWith('2 ')) {
      i += 1;
      continue;
    }
    i += 3;
    try {
      const satrec = sat.twoline2satrec(l1, l2);
      if ((satrec as any).error) continue;
      const nRadMin = satrec.no; // rad/min
      const periodMin = (2 * Math.PI) / nRadMin;
      const nRadS = nRadMin / 60;
      const a = Math.cbrt(MU / (nRadS * nRadS));
      const ecc = satrec.ecco;
      const perigee = a * (1 - ecc) - RE;
      const apogee = a * (1 + ecc) - RE;
      const incl = (satrec.inclo * 180) / Math.PI;
      const cleanName = name.replace(/^0 /, '').trim();
      const mission = missionForName(cleanName);
      out.push({
        noradId: l1.substring(2, 7).trim(),
        name: cleanName,
        intlDesignator: parseIntlDesignator(l1),
        tle1: l1,
        tle2: l2,
        epoch: epochFromSatrec(satrec),
        satrec,
        inclinationDeg: incl,
        periodMin,
        perigeeKm: perigee,
        apogeeKm: apogee,
        eccentricity: ecc,
        orbitType: classifyOrbit(incl, periodMin, ecc, perigee),
        mission,
        provider: mission ? providerById(mission.providerId) : undefined,
      });
    } catch {
      /* skip malformed element set */
    }
  }
  return out;
}

export function propagateSubPoint(rec: SatRecord, date: Date): SubPoint | null {
  const pv = sat.propagate(rec.satrec, date);
  const pos = pv && (pv as any).position;
  if (!pos || typeof pos === 'boolean') return null;
  const gmst = sat.gstime(date);
  const geo = sat.eciToGeodetic(pos as sat.EciVec3<number>, gmst);
  return {
    lat: (geo.latitude * 180) / Math.PI,
    lon: (geo.longitude * 180) / Math.PI,
    heightKm: geo.height,
  };
}

export function groundTrack(rec: SatRecord, start: Date, minutes: number, stepSec = 30): (SubPoint & { t: Date })[] {
  const pts: (SubPoint & { t: Date })[] = [];
  const n = Math.ceil((minutes * 60) / stepSec);
  for (let i = 0; i <= n; i++) {
    const t = new Date(start.getTime() + i * stepSec * 1000);
    const p = propagateSubPoint(rec, t);
    if (p) pts.push({ ...p, t });
  }
  return pts;
}

/** Age of the element set relative to a given time, in days. */
export function elementAgeDays(rec: SatRecord, at: Date): number {
  return (at.getTime() - rec.epoch.getTime()) / 86400000;
}

export function confidenceForAge(ageDays: number): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  const a = Math.abs(ageDays);
  if (a <= 3) return { label: 'Fresh elements (≤3 d)', tone: 'ok' };
  if (a <= 14) return { label: `Elements ${a.toFixed(0)} d from epoch — reduced accuracy`, tone: 'warn' };
  return { label: `Elements ${a.toFixed(0)} d from epoch — low accuracy`, tone: 'bad' };
}

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Approximate solar elevation (deg) — NOAA simplified algorithm, adequate for day/night flags. */
export function solarElevationDeg(date: Date, lat: number, lon: number): number {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  const ha = (gmst + lon) * rad - ra;
  const el = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha));
  return el / rad;
}
