// Area on the WGS84 ellipsoid and Thai area units.
//
// Areas are computed on the ellipsoid (via the authalic latitude), never from raw degree
// differences. Display units in surveillance mode are square kilometres and rai only:
//   1 km² = 625 rai   ·   1 rai = 1,600 m²
// Values are kept unrounded internally; rounding happens only when formatting.

export const KM2_TO_RAI = 625;
export const RAI_M2 = 1600;

const A = 6378137; // WGS84 semi-major axis (m)
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const E = Math.sqrt(E2);

/** Authalic function q(φ) (Snyder 1987, eq. 3-12). */
function q(phi: number) {
  const s = Math.sin(phi);
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
}
const QP = q(Math.PI / 2);
/** Radius of the sphere with the same surface area as the ellipsoid (m). */
export const R_AUTHALIC = A * Math.sqrt(QP / 2);
const rad = (d: number) => (d * Math.PI) / 180;
/** Authalic latitude β (radians) for geodetic latitude φ (degrees). */
const beta = (latDeg: number) => Math.asin(Math.max(-1, Math.min(1, q(rad(latDeg)) / QP)));

/** Exact ellipsoidal area (km²) of a latitude/longitude rectangle. */
export function rectAreaKm2(west: number, south: number, east: number, north: number): number {
  return ((A * A) / 2) * Math.abs(q(rad(north)) - q(rad(south))) * Math.abs(rad(east - west)) / 1e6;
}

/** Ellipsoidal area (km²) of a polygon ring list (outer ring first, holes after). */
export function polygonAreaKm2(coords: number[][][]): number {
  const ringArea = (ring: number[][]) => {
    // spherical-excess formula on the authalic sphere, with latitudes mapped to authalic latitude
    let s = 0;
    const n = ring.length;
    if (n < 3) return 0;
    for (let i = 0; i < n; i++) {
      const p1 = ring[i], p2 = ring[(i + 1) % n];
      s += rad(p2[0] - p1[0]) * (2 + Math.sin(beta(p1[1])) + Math.sin(beta(p2[1])));
    }
    return Math.abs((s * R_AUTHALIC * R_AUTHALIC) / 2) / 1e6;
  };
  if (!coords.length) return 0;
  return Math.max(0, ringArea(coords[0]) - coords.slice(1).reduce((t, r) => t + ringArea(r), 0));
}

export const geometryAreaKm2 = (g: GeoJSON.Polygon | GeoJSON.MultiPolygon) =>
  g.type === 'Polygon' ? polygonAreaKm2(g.coordinates) : g.coordinates.reduce((t, p) => t + polygonAreaKm2(p), 0);

// ---------------------------------------------------------------- units

export type AreaUnit = 'km2' | 'rai';
export const km2ToRai = (km2: number) => km2 * KM2_TO_RAI;
export const raiToKm2 = (rai: number) => rai / KM2_TO_RAI;
export const m2ToRai = (m2: number) => m2 / RAI_M2;

const n = (v: number, d: number) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
/** Decimals that keep small areas readable without false precision. */
const kmDigits = (v: number) => (v === 0 ? 2 : Math.abs(v) < 0.01 ? 4 : Math.abs(v) < 1 ? 3 : 2);
const raiDigits = (v: number) => (Math.abs(v) < 10 ? 2 : Math.abs(v) < 10000 ? 2 : 0);

export const fmtKm2 = (km2: number, th = true) => `${n(km2, kmDigits(km2))} ${th ? 'ตร.กม.' : 'km²'}`;
export const fmtRai = (km2: number, th = true) => `${n(km2ToRai(km2), raiDigits(km2ToRai(km2)))} ${th ? 'ไร่' : 'rai'}`;

/** "12.45 ตร.กม. (7,781.25 ไร่)" or, with rai as the primary unit, "7,781.25 ไร่ (12.45 ตร.กม.)". */
export function fmtArea(km2: number, primary: AreaUnit = 'km2', th = true): string {
  return primary === 'km2' ? `${fmtKm2(km2, th)} (${fmtRai(km2, th)})` : `${fmtRai(km2, th)} (${fmtKm2(km2, th)})`;
}

const UNIT_KEY = 'ov.areaUnit.v1';
export function loadAreaUnit(): AreaUnit {
  try {
    return localStorage.getItem(UNIT_KEY) === 'rai' ? 'rai' : 'km2';
  } catch {
    return 'km2';
  }
}
export function saveAreaUnit(u: AreaUnit) {
  try {
    localStorage.setItem(UNIT_KEY, u);
  } catch {
    /* ignore */
  }
}
