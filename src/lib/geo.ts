import * as turf from '@turf/turf';
import { bumpQuota } from './quotas';

export type Aoi = { name: string; geometry: GeoJSON.Polygon; source: 'drawn' | 'search' | 'coordinates' | 'import' };

export function bboxPolygon(w: number, s: number, e: number, n: number): GeoJSON.Polygon {
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

/** Square AOI of `km` side around a point (used for point-of-interest selections). */
export function pointAoi(lon: number, lat: number, km = 10): GeoJSON.Polygon {
  const dLat = km / 2 / 110.574;
  const dLon = km / 2 / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return bboxPolygon(lon - dLon, lat - dLat, lon + dLon, lat + dLat);
}

export function areaKm2(g: GeoJSON.Polygon): number {
  return turf.area(turf.polygon(g.coordinates)) / 1e6;
}

export function centroid(g: GeoJSON.Polygon): [number, number] {
  const c = turf.centroid(turf.polygon(g.coordinates));
  return c.geometry.coordinates as [number, number];
}

/** Radius (km) of the circle around the centroid that encloses the AOI. */
export function aoiRadiusKm(g: GeoJSON.Polygon): number {
  const [cx, cy] = centroid(g);
  let r = 0;
  for (const [x, y] of g.coordinates[0]) r = Math.max(r, turf.distance([cx, cy], [x, y], { units: 'kilometers' }));
  return r;
}

export function aoiCoveragePct(aoi: GeoJSON.Polygon, footprint: GeoJSON.Polygon | GeoJSON.MultiPolygon | null): number | null {
  if (!footprint) return null;
  try {
    const a = turf.polygon(aoi.coordinates);
    const f = footprint.type === 'Polygon' ? turf.polygon(footprint.coordinates) : turf.multiPolygon(footprint.coordinates);
    const inter = turf.intersect(turf.featureCollection([a, f as any]));
    if (!inter) return 0;
    return Math.min(100, (turf.area(inter) / turf.area(a)) * 100);
  } catch {
    return null;
  }
}

export function lineLengthKm(coords: [number, number][]): number {
  if (coords.length < 2) return 0;
  return turf.length(turf.lineString(coords), { units: 'kilometers' });
}

export function polygonAreaKm2(coords: [number, number][]): number {
  if (coords.length < 3) return 0;
  return turf.area(turf.polygon([[...coords, coords[0]]])) / 1e6;
}

export function parseCoordinates(q: string): [number, number] | null {
  // "13.75, 100.5" (lat, lon) or "13.75 100.5"
  const m = q.trim().match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

export interface GeocodeHit {
  label: string;
  lon: number;
  lat: number;
  bbox?: [number, number, number, number]; // w s e n
}

let lastGeocode = 0;
export async function geocode(q: string): Promise<GeocodeHit[]> {
  const coords = parseCoordinates(q);
  if (coords) return [{ label: `${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}`, lon: coords[0], lat: coords[1] }];
  const wait = 1100 - (Date.now() - lastGeocode); // Nominatim policy: ≤ 1 request / second
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocode = Date.now();
  bumpQuota('geocode');
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`, {
    headers: { 'Accept-Language': 'en' },
  });
  if (!r.ok) throw new Error(`Geocoder error (HTTP ${r.status})`);
  const j = await r.json();
  return j.map((x: any) => ({
    label: x.display_name,
    lon: parseFloat(x.lon),
    lat: parseFloat(x.lat),
    bbox: x.boundingbox
      ? [parseFloat(x.boundingbox[2]), parseFloat(x.boundingbox[0]), parseFloat(x.boundingbox[3]), parseFloat(x.boundingbox[1])]
      : undefined,
  }));
}

/** Extract the first polygon (or point → square) from a GeoJSON document. */
export function polygonFromGeoJson(doc: any): GeoJSON.Polygon | null {
  const feats: any[] = doc.type === 'FeatureCollection' ? doc.features : doc.type === 'Feature' ? [doc] : [{ geometry: doc }];
  for (const f of feats) {
    const g = f?.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') return { type: 'Polygon', coordinates: [g.coordinates[0].map((c: number[]) => [c[0], c[1]])] };
    if (g.type === 'MultiPolygon') return { type: 'Polygon', coordinates: [g.coordinates[0][0].map((c: number[]) => [c[0], c[1]])] };
    if (g.type === 'Point') return pointAoi(g.coordinates[0], g.coordinates[1]);
  }
  return null;
}

/** Minimal KML parser: first <Polygon> outer boundary, or first <Point>. */
export function polygonFromKml(text: string): GeoJSON.Polygon | null {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  const parse = (s: string) =>
    s.trim().split(/\s+/).map((t) => t.split(',').map(Number)).filter((c) => c.length >= 2 && !isNaN(c[0]) && !isNaN(c[1])).map((c) => [c[0], c[1]]);
  const poly = xml.getElementsByTagName('Polygon')[0];
  if (poly) {
    const outer = poly.getElementsByTagName('outerBoundaryIs')[0] || poly;
    const coords = outer.getElementsByTagName('coordinates')[0]?.textContent;
    if (coords) {
      const ring = parse(coords);
      if (ring.length >= 3) {
        const first = ring[0], last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
        return { type: 'Polygon', coordinates: [ring] };
      }
    }
  }
  const pt = xml.getElementsByTagName('Point')[0]?.getElementsByTagName('coordinates')[0]?.textContent;
  if (pt) {
    const c = parse(pt)[0];
    if (c) return pointAoi(c[0], c[1]);
  }
  return null;
}

export async function aoiFromFile(file: File): Promise<GeoJSON.Polygon> {
  const text = await file.text();
  const name = file.name.toLowerCase();
  let poly: GeoJSON.Polygon | null = null;
  if (name.endsWith('.kml')) poly = polygonFromKml(text);
  else if (name.endsWith('.kmz')) throw new Error('KMZ (zipped KML) is not supported yet — unzip and import the .kml file');
  else poly = polygonFromGeoJson(JSON.parse(text));
  if (!poly) throw new Error('No polygon or point found in the file');
  return poly;
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
