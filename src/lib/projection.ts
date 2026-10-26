// Coordinate reference systems met in imported files: WGS84 lat/lon, UTM (WGS84 or Indian 1975 —
// the datum of older Thai RTSD / DOL map sheets), and Web Mercator. Everything is converted to
// WGS84 lon/lat degrees. Pure functions, no dependencies (unit-tested in tests/coordImport.test.ts).

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface Ellipsoid { a: number; f: number }
export const WGS84: Ellipsoid = { a: 6378137, f: 1 / 298.257223563 };
/** Everest 1830 (1937 adjustment) — ellipsoid of Indian 1975. */
export const EVEREST_1830: Ellipsoid = { a: 6377276.345, f: 1 / 300.8017 };
/** Indian 1975 → WGS84, Thailand (EPSG:1153 parameters). Accuracy about ±3 m. */
const INDIAN1975_SHIFT: [number, number, number] = [210, 814, 289];

export type Datum = 'wgs84' | 'indian1975';
export type Crs =
  | { kind: 'geo'; datum: Datum }
  | { kind: 'utm'; zone: number; north: boolean; datum: Datum }
  | { kind: 'merc' };

/** Krüger series (Karney 2011, 3rd order in n — sub-millimetre inside a zone). */
function tmCoefs(e: Ellipsoid) {
  const n = e.f / (2 - e.f);
  const A = (e.a / (1 + n)) * (1 + (n * n) / 4 + n ** 4 / 64);
  const alpha = [n / 2 - (2 / 3) * n * n + (5 / 16) * n ** 3, (13 / 48) * n * n - (3 / 5) * n ** 3, (61 / 240) * n ** 3];
  const beta = [n / 2 - (2 / 3) * n * n + (37 / 96) * n ** 3, (1 / 48) * n * n + (1 / 15) * n ** 3, (17 / 480) * n ** 3];
  const delta = [2 * n - (2 / 3) * n * n - 2 * n ** 3, (7 / 3) * n * n - (8 / 5) * n ** 3, (56 / 15) * n ** 3];
  return { n, A, alpha, beta, delta };
}

const K0 = 0.9996;

export function utmToLonLat(easting: number, northing: number, zone: number, north: boolean, ell: Ellipsoid = WGS84): [number, number] {
  const { A, beta, delta } = tmCoefs(ell);
  const xi = (northing - (north ? 0 : 10_000_000)) / (K0 * A);
  const eta = (easting - 500_000) / (K0 * A);
  let xi1 = xi, eta1 = eta;
  for (let j = 1; j <= 3; j++) {
    xi1 -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let phi = chi;
  for (let j = 1; j <= 3; j++) phi += delta[j - 1] * Math.sin(2 * j * chi);
  const lam0 = (zone * 6 - 183) * D2R;
  const lam = lam0 + Math.atan2(Math.sinh(eta1), Math.cos(xi1));
  return [normLon(lam * R2D), phi * R2D];
}

export function lonLatToUtm(lon: number, lat: number, zone = utmZoneOf(lon), ell: Ellipsoid = WGS84): { e: number; n: number; zone: number; north: boolean } {
  const { n, A, alpha } = tmCoefs(ell);
  const phi = lat * D2R;
  const lam = (lon - (zone * 6 - 183)) * D2R;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - ((2 * Math.sqrt(n)) / (1 + n)) * Math.atanh(((2 * Math.sqrt(n)) / (1 + n)) * Math.sin(phi)));
  const xi1 = Math.atan2(t, Math.cos(lam));
  const eta1 = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let xi = xi1, eta = eta1;
  for (let j = 1; j <= 3; j++) {
    xi += alpha[j - 1] * Math.sin(2 * j * xi1) * Math.cosh(2 * j * eta1);
    eta += alpha[j - 1] * Math.cos(2 * j * xi1) * Math.sinh(2 * j * eta1);
  }
  const north = lat >= 0;
  return { e: 500_000 + K0 * A * eta, n: (north ? 0 : 10_000_000) + K0 * A * xi, zone, north };
}

export const utmZoneOf = (lon: number) => Math.min(60, Math.max(1, Math.floor((normLon(lon) + 180) / 6) + 1));

const R_MERC = 6378137;
export function mercToLonLat(x: number, y: number): [number, number] {
  return [normLon((x / R_MERC) * R2D), (2 * Math.atan(Math.exp(y / R_MERC)) - Math.PI / 2) * R2D];
}

function normLon(l: number) {
  while (l > 180) l -= 360;
  while (l < -180) l += 360;
  return l;
}

function toEcef(lon: number, lat: number, e: Ellipsoid): [number, number, number] {
  const e2 = e.f * (2 - e.f);
  const p = lat * D2R, l = lon * D2R;
  const N = e.a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  return [N * Math.cos(p) * Math.cos(l), N * Math.cos(p) * Math.sin(l), N * (1 - e2) * Math.sin(p)];
}
function fromEcef(x: number, y: number, z: number, e: Ellipsoid): [number, number] {
  const e2 = e.f * (2 - e.f);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 6; i++) {
    const N = e.a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + e2 * N * Math.sin(lat), p);
  }
  return [Math.atan2(y, x) * R2D, lat * R2D];
}

/** Indian 1975 geographic → WGS84 (3-parameter geocentric shift, ellipsoid height taken as 0). */
export function indian1975ToWgs84(lon: number, lat: number): [number, number] {
  const [x, y, z] = toEcef(lon, lat, EVEREST_1830);
  return fromEcef(x + INDIAN1975_SHIFT[0], y + INDIAN1975_SHIFT[1], z + INDIAN1975_SHIFT[2], WGS84);
}

/** Convert one coordinate pair in `crs` to WGS84 [lon, lat]. */
export function toWgs84(x: number, y: number, crs: Crs): [number, number] {
  if (crs.kind === 'merc') return mercToLonLat(x, y);
  if (crs.kind === 'geo') return crs.datum === 'indian1975' ? indian1975ToWgs84(x, y) : [x, y];
  if (crs.datum === 'indian1975') {
    const [lo, la] = utmToLonLat(x, y, crs.zone, crs.north, EVEREST_1830);
    return indian1975ToWgs84(lo, la);
  }
  return utmToLonLat(x, y, crs.zone, crs.north);
}

/**
 * Read a CRS from an EPSG code / URN / OGC name / .prj WKT. Returns null when it is not recognised
 * (the caller then guesses from the value ranges and says so).
 */
export function crsFromText(s: string | undefined | null): Crs | null {
  if (!s) return null;
  const t = String(s);
  // WKT nests the base GEOGCS authority before the PROJCS one, so the last EPSG code is the CRS itself
  const codes = [...t.matchAll(/EPSG\D{0,4}(\d{4,6})/gi)].map((m) => m[1]);
  const code = codes[codes.length - 1] ?? (/^\s*\d{4,6}\s*$/.test(t) ? t.trim() : undefined);
  if (code) {
    const c = +code;
    if (c === 4326 || c === 4979 || c === 4258 || c === 4269) return { kind: 'geo', datum: 'wgs84' };
    if (c === 4240) return { kind: 'geo', datum: 'indian1975' };
    if (c === 3857 || c === 900913 || c === 102100 || c === 102113 || c === 3785) return { kind: 'merc' };
    if (c >= 32601 && c <= 32660) return { kind: 'utm', zone: c - 32600, north: true, datum: 'wgs84' };
    if (c >= 32701 && c <= 32760) return { kind: 'utm', zone: c - 32700, north: false, datum: 'wgs84' };
    if (c === 24047 || c === 24048) return { kind: 'utm', zone: c - 24000, north: true, datum: 'indian1975' };
  }
  if (/CRS84/i.test(t)) return { kind: 'geo', datum: 'wgs84' };
  if (/mercator/i.test(t) && /(pseudo|web|auxiliary|popular)/i.test(t)) return { kind: 'merc' };
  const indian = /indian[_\s]*1975|everest/i.test(t);
  const utm = t.match(/UTM[_\s]*zone[_\s]*(\d{1,2})\s*([NS])?/i);
  if (utm) return { kind: 'utm', zone: +utm[1], north: (utm[2] ?? 'N').toUpperCase() === 'N', datum: indian ? 'indian1975' : 'wgs84' };
  if (/^\s*PROJCS|PROJCRS/i.test(t)) return null; // some other projection — unknown
  if (/^\s*GEOGCS|GEOGCRS/i.test(t)) return { kind: 'geo', datum: indian ? 'indian1975' : 'wgs84' };
  return null;
}

export const crsLabel = (c: Crs) =>
  c.kind === 'merc' ? 'Web Mercator (EPSG:3857)' : c.kind === 'geo' ? (c.datum === 'indian1975' ? 'Indian 1975 lat/lon' : 'WGS84 lat/lon') : `UTM ${c.zone}${c.north ? 'N' : 'S'}${c.datum === 'indian1975' ? ' (Indian 1975)' : ' (WGS84)'}`;
