// Pixel-level comparison of two scenes over the AOI.
// Each scene's expression is rendered server-side from original bands as 8-bit grey tiles
// (value = lo + grey/255·(hi − lo), alpha 0 = no data), mosaicked here, compared pixel by pixel,
// and re-projected to a lat/lon-linear image for draping on the globe.
import { greyTileUrl } from './spectral';
import type { ImageryItem } from './stac';
import { rectAreaKm2 } from './area';


function lonLatToTile(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latR = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  return { x, y };
}
const tileYToLat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};
const tileXToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;

export interface Grid {
  z: number;
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  width: number;
  height: number;
  west: number;
  east: number;
  north: number;
  south: number;
}

/** Pick a zoom where the AOI spans at most ~maxPx pixels and ≤ maxTiles tiles. */
export function gridFor(aoi: GeoJSON.Polygon, maxPx = 1024, maxTiles = 36): Grid {
  const xs = aoi.coordinates[0].map((c) => c[0]);
  const ys = aoi.coordinates[0].map((c) => c[1]);
  const w = Math.min(...xs), e = Math.max(...xs), s = Math.min(...ys), n = Math.max(...ys);
  for (let z = 15; z >= 4; z--) {
    const a = lonLatToTile(w, n, z);
    const b = lonLatToTile(e, s, z);
    const x0 = Math.floor(a.x), y0 = Math.floor(a.y), x1 = Math.floor(b.x), y1 = Math.floor(b.y);
    const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
    if (nx * ny <= maxTiles && Math.max((b.x - a.x) * 256, (b.y - a.y) * 256) <= maxPx) {
      return { z, x0, y0, nx, ny, width: nx * 256, height: ny * 256, west: tileXToLon(x0, z), east: tileXToLon(x0 + nx, z), north: tileYToLat(y0, z), south: tileYToLat(y0 + ny, z) };
    }
  }
  throw new Error('AOI too large for pixel comparison');
}

let lastTileError = '';
async function loadImage(url: string, signal?: AbortSignal): Promise<ImageBitmap | null> {
  const r = await fetch(url, { signal });
  if (!r.ok) {
    // tiles outside the scene footprint come back as 404/500 "outside bounds": treat as no data
    lastTileError = `HTTP ${r.status}${r.status >= 400 ? ` ${(await r.text().catch(() => '')).slice(0, 120)}` : ''}`;
    return null;
  }
  return createImageBitmap(await r.blob());
}

export interface Raster {
  grid: Grid;
  values: Float32Array; // NaN = no data
}

export async function fetchRaster(
  item: ImageryItem,
  expression: string,
  range: [number, number],
  grid: Grid,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<Raster> {
  const cv = document.createElement('canvas');
  cv.width = grid.width;
  cv.height = grid.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  const total = grid.nx * grid.ny;
  let done = 0;
  let got = 0;
  lastTileError = '';
  const jobs: Promise<void>[] = [];
  for (let j = 0; j < grid.ny; j++)
    for (let i = 0; i < grid.nx; i++) {
      jobs.push(
        loadImage(greyTileUrl(item, expression, range, grid.z, grid.x0 + i, grid.y0 + j), signal).then((img) => {
          if (img) {
            ctx.drawImage(img, i * 256, j * 256);
            got++;
          }
          onProgress?.(++done, total);
        }),
      );
    }
  await Promise.all(jobs);
  if (!got) throw new Error(`No tiles could be read for ${item.id} (${lastTileError || 'AOI outside the scene?'})`);
  const px = ctx.getImageData(0, 0, grid.width, grid.height).data;
  const values = new Float32Array(grid.width * grid.height);
  const k = (range[1] - range[0]) / 255;
  for (let p = 0, q = 0; p < values.length; p++, q += 4) values[p] = px[q + 3] < 128 ? NaN : range[0] + px[q] * k;
  return { grid, values };
}

function pointInRing(lon: number, lat: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Pixel lat/lon for row/col of a web-mercator grid. */
function pixelLatLon(g: Grid, row: number, col: number) {
  const lon = tileXToLon(g.x0 + (col + 0.5) / 256, g.z);
  const lat = tileYToLat(g.y0 + (row + 0.5) / 256, g.z);
  return [lon, lat];
}

/** Ellipsoidal ground area (km²) of one web-mercator pixel row cell (exact for the cell's lat/lon edges). */
const pixelAreaKm2 = (g: Grid, row: number) => {
  const n = tileYToLat(g.y0 + row / 256, g.z), s = tileYToLat(g.y0 + (row + 1) / 256, g.z);
  return rectAreaKm2(0, s, 360 / (256 * 2 ** g.z), n);
};

export type ClassId = number;

export interface ClassDef {
  id: ClassId;
  label: string;
  rgba: [number, number, number, number];
  /** drawn as diagonal hatching (uncertain states: cloud, shadow, no data) */
  hatch?: boolean;
}

export interface Classified {
  grid: Grid;
  classes: Uint8Array; // 0 = outside AOI, 255 = no data, else class id
  areasKm2: Record<number, number>;
  validKm2: number;
  noDataKm2: number;
  aoiKm2: number;
  imageUrl: string; // lat/lon-linear PNG for draping
  pngUrl: string; // same image, for export
}

/**
 * Classify every AOI pixel with `fn(a, b)` (b undefined for single-scene) → class id.
 * Pixels where any input is no data become 255 (shown grey).
 */
export function classify(
  aoi: GeoJSON.Polygon,
  a: Raster,
  b: Raster | null,
  fn: (va: number, vb: number) => ClassId,
  defs: ClassDef[],
): Classified {
  const g = a.grid;
  const ring = aoi.coordinates[0];
  const classes = new Uint8Array(g.width * g.height);
  const areas: Record<number, number> = {};
  let valid = 0, nodata = 0, aoiA = 0;
  for (let row = 0; row < g.height; row++) {
    const [, lat] = pixelLatLon(g, row, 0);
    const pa = pixelAreaKm2(g, row);
    for (let col = 0; col < g.width; col++) {
      const [lon] = pixelLatLon(g, row, col);
      const p = row * g.width + col;
      if (!pointInRing(lon, lat, ring)) continue;
      aoiA += pa;
      const va = a.values[p];
      const vb = b ? b.values[p] : 0;
      if (Number.isNaN(va) || Number.isNaN(vb)) {
        classes[p] = 255;
        nodata += pa;
        continue;
      }
      const c = fn(va, vb);
      classes[p] = c;
      valid += pa;
      areas[c] = (areas[c] ?? 0) + pa;
    }
  }
  const colour = new Map(defs.map((d) => [d.id, d.rgba]));
  const hatch = new Set(defs.filter((d) => d.hatch).map((d) => d.id));
  // re-project rows to linear latitude so the image drapes correctly with a lat/lon rectangle
  const out = document.createElement('canvas');
  out.width = g.width;
  out.height = g.height;
  const octx = out.getContext('2d')!;
  const img = octx.createImageData(g.width, g.height);
  const mercY = (lat: number) => lonLatToTile(0, lat, g.z).y;
  for (let row = 0; row < g.height; row++) {
    const lat = g.north - ((row + 0.5) / g.height) * (g.north - g.south);
    const srcRow = Math.min(g.height - 1, Math.max(0, Math.floor((mercY(lat) - g.y0) * 256)));
    for (let col = 0; col < g.width; col++) {
      const c = classes[srcRow * g.width + col];
      if (c === 0) continue;
      const rgba = colour.get(c) ?? (c === 255 ? ([128, 128, 128, 110] as const) : undefined);
      if (!rgba) continue;
      if (hatch.has(c) && (row + col) % 8 >= 3) continue; // stripes: uncertain areas never look like a change colour
      const q = (row * g.width + col) * 4;
      img.data[q] = rgba[0];
      img.data[q + 1] = rgba[1];
      img.data[q + 2] = rgba[2];
      img.data[q + 3] = rgba[3];
    }
  }
  octx.putImageData(img, 0, 0);
  const url = out.toDataURL('image/png');
  return { grid: g, classes, areasKm2: areas, validKm2: valid, noDataKm2: nodata, aoiKm2: aoiA, imageUrl: url, pngUrl: url };
}

/** Collect the AOI-pixel values of a raster for a histogram. */
export function valuesInAoi(aoi: GeoJSON.Polygon, r: Raster): number[] {
  const g = r.grid;
  const out: number[] = [];
  for (let row = 0; row < g.height; row += 2)
    for (let col = 0; col < g.width; col += 2) {
      const [lon, lat] = pixelLatLon(g, row, col);
      const v = r.values[row * g.width + col];
      if (!Number.isNaN(v) && pointInRing(lon, lat, aoi.coordinates[0])) out.push(v);
    }
  return out;
}

/** Pixel centre lon/lat and ground area (km²) for a grid cell — used for hotspot extraction. */
export function cellLonLat(g: Grid, row: number, col: number): [number, number] {
  const [lon, lat] = pixelLatLon(g, row, col);
  return [lon, lat];
}
export const cellAreaKm2 = (g: Grid, row: number) => pixelAreaKm2(g, row);
