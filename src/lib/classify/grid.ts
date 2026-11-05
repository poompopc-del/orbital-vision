// Pure helpers on the web-mercator analysis grid used by change.ts (no DOM).
import type { Grid } from '../change';
import { rectAreaKm2 } from '../area';

const tileYToLat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};
const tileXToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const lonLatToTile = (lon: number, lat: number, z: number) => {
  const n = 2 ** z;
  const latR = (lat * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n };
};

export function pixelCenter(g: Grid, row: number, col: number): [number, number] {
  return [tileXToLon(g.x0 + (col + 0.5) / 256, g.z), tileYToLat(g.y0 + (row + 0.5) / 256, g.z)];
}

/** Pixel index for a lon/lat, or -1 when outside the grid. */
export function pixelAt(g: Grid, lon: number, lat: number): number {
  const t = lonLatToTile(lon, lat, g.z);
  const col = Math.floor((t.x - g.x0) * 256), row = Math.floor((t.y - g.y0) * 256);
  if (col < 0 || row < 0 || col >= g.width || row >= g.height) return -1;
  return row * g.width + col;
}

export function pointInRing(lon: number, lat: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(lon: number, lat: number, poly: GeoJSON.Polygon) {
  const [outer, ...holes] = poly.coordinates;
  return pointInRing(lon, lat, outer) && !holes.some((h) => pointInRing(lon, lat, h));
}

/** 1 for pixels whose centre lies in the polygon. */
export function polygonMask(g: Grid, poly: GeoJSON.Polygon): Uint8Array {
  const m = new Uint8Array(g.width * g.height);
  for (let row = 0; row < g.height; row++) {
    const lat = pixelCenter(g, row, 0)[1];
    for (let col = 0; col < g.width; col++) {
      const lon = pixelCenter(g, row, col)[0];
      if (pointInPolygon(lon, lat, poly)) m[row * g.width + col] = 1;
    }
  }
  return m;
}

/** Ground area (km²) of one pixel in each row (pixels in a row share a latitude band). */
export function rowAreasKm2(g: Grid): Float64Array {
  const a = new Float64Array(g.height);
  const dLon = 360 / (256 * 2 ** g.z);
  for (let row = 0; row < g.height; row++) a[row] = rectAreaKm2(0, tileYToLat(g.y0 + (row + 1) / 256, g.z), dLon, tileYToLat(g.y0 + row / 256, g.z));
  return a;
}

/** Approximate pixel size in metres at the grid centre. */
export const pixelSizeM = (g: Grid) => (40075016.7 * Math.cos((((g.north + g.south) / 2) * Math.PI) / 180)) / (256 * 2 ** g.z);
