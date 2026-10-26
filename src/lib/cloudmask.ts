// Per-pixel cloud / shadow mask used before any change classification.
//
// The scene's own mask (Sentinel-2 SCL / Landsat QA_PIXEL) misses three things that otherwise show
// up as "change":
//   1. cloud edges — the transparent rim around a flagged cloud. Fixed with a buffer (dilation).
//   2. thin cloud / haze next to clouds that SCL leaves as "unclassified" (7) or as land.
//      Fixed by treating SCL 7 and hazy pixels (HOT > 0) near a cloud as cloud.
//      HOT = Blue − 0.5·Red − 0.08 (Haze Optimized Transform, Zhang et al. 2002).
//   3. cloud shadows SCL labels "dark area" (2) instead of shadow. Treated as shadow near a cloud.
// The extra tests only apply near flagged cloud, so bright roofs or sand far from clouds are not
// mistaken for cloud.
import { fetchRaster, type Grid, type Raster } from './change';
import { loadQc } from './qc';
import { refl, sensorOf } from './spectral';
import type { ImageryItem } from './stac';

/** pixel state codes */
export const ST_NODATA = 0, ST_DARK = 2, ST_SHADOW = 3, ST_CLEAR = 4, ST_SUSPECT = 7, ST_CLOUD = 8;

const lsBit = (k: number) => `(((qa_pixel/${2 ** k})%2)>=1)`;

/** Server-side expression giving one state code per pixel (rendered with rescale 0–255). Radar → null. */
export function stateExpr(it: ImageryItem): string | null {
  const k = sensorOf(it);
  if (k === 's2')
    return 'where((SCL==0)|(SCL==1),0,where(SCL==3,3,where((SCL==8)|(SCL==9)|(SCL==10),8,where(SCL==7,7,where(SCL==2,2,4)))))';
  // QA_PIXEL bits: 0 fill · 1 dilated cloud · 2 cirrus · 3 cloud · 4 cloud shadow
  if (k === 'landsat') return `where(${lsBit(0)},0,where(${lsBit(1)}|${lsBit(2)}|${lsBit(3)},8,where(${lsBit(4)},3,4)))`;
  return null;
}

/** Haze Optimized Transform expression and the range to read it with, or null when not optical. */
export function hotExpr(it: ImageryItem): { expr: string; range: [number, number] } | null {
  const b = refl(it, 'blue'), r = refl(it, 'red');
  if (!b || !r) return null;
  return { expr: `(${b}-0.5*${r}-0.08)`, range: [-0.3, 0.5] };
}

export interface MaskOpts {
  /** buffer around cloud and shadow, px */
  bufferPx: number;
  /** distance from cloud within which "unclassified" / hazy pixels count as cloud, px */
  nearPx: number;
  /** distance from cloud within which SCL "dark area" pixels count as cloud shadow, px */
  shadowNearPx: number;
  /** apply the thin-cloud / edge / dark-area tests */
  thinCloud: boolean;
  /** HOT above this = haze */
  hotThr: number;
}

/** Metres → pixels on a web-mercator grid at the grid's centre latitude. */
export function pxForMeters(g: Pick<Grid, 'z' | 'north' | 'south'>, m: number): number {
  const lat = ((g.north + g.south) / 2) * (Math.PI / 180);
  const mpp = (156543.034 * Math.cos(lat)) / 2 ** g.z;
  return m <= 0 ? 0 : Math.max(1, Math.round(m / mpp));
}

export function maskOptsFor(g: Pick<Grid, 'z' | 'north' | 'south'>, o: { cloudBufferM: number; thinCloud: boolean }): MaskOpts {
  return {
    bufferPx: pxForMeters(g, o.cloudBufferM),
    nearPx: pxForMeters(g, 500),
    // shadows fall ~0.5–2.5 km from their cloud at Thai latitudes (cloud 1–3 km high, sun 50–65°)
    shadowNearPx: pxForMeters(g, 2000),
    thinCloud: o.thinCloud,
    hotThr: 0,
  };
}

/** Distance (px, chamfer 1/√2) from every pixel to the nearest pixel where `src` is true. */
export function distanceTo(src: (p: number) => boolean, W: number, H: number): Float32Array {
  const d = new Float32Array(W * H);
  const D = Math.SQRT2;
  for (let p = 0; p < d.length; p++) d[p] = src(p) ? 0 : Infinity;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      let v = d[p];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[p - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[p - W] + 1);
        if (x > 0) v = Math.min(v, d[p - W - 1] + D);
        if (x < W - 1) v = Math.min(v, d[p - W + 1] + D);
      }
      d[p] = v;
    }
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const p = y * W + x;
      let v = d[p];
      if (v === 0) continue;
      if (x < W - 1) v = Math.min(v, d[p + 1] + 1);
      if (y < H - 1) {
        v = Math.min(v, d[p + W] + 1);
        if (x < W - 1) v = Math.min(v, d[p + W + 1] + D);
        if (x > 0) v = Math.min(v, d[p + W - 1] + D);
      }
      d[p] = v;
    }
  return d;
}

/**
 * Final per-pixel state: ST_NODATA / ST_SHADOW / ST_CLEAR / ST_CLOUD.
 * `state` holds raw codes from stateExpr (NaN = no data); `hot` the HOT values (or null).
 */
export function buildMask(state: Float32Array, hot: Float32Array | null, W: number, H: number, o: MaskOpts): Uint8Array {
  const n = W * H;
  const raw = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const v = state[p];
    raw[p] = Number.isNaN(v) ? ST_NODATA : Math.round(v);
  }
  // 1. cloud core = flagged cloud + (thin cloud / edges near flagged cloud)
  let core = (p: number) => raw[p] === ST_CLOUD;
  if (o.thinCloud && o.nearPx > 0) {
    const d0 = distanceTo(core, W, H);
    const isCore = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      if (raw[p] === ST_CLOUD) isCore[p] = 1;
      else if (d0[p] <= o.nearPx && raw[p] !== ST_NODATA && (raw[p] === ST_SUSPECT || (hot != null && hot[p] > o.hotThr))) isCore[p] = 1;
    }
    core = (p: number) => isCore[p] === 1;
  }
  const dc = distanceTo(core, W, H);
  // 2. shadow core = flagged shadow + dark-area pixels within reach of a cloud
  const shadowCore = (p: number) => raw[p] === ST_SHADOW || (o.thinCloud && raw[p] === ST_DARK && dc[p] <= o.shadowNearPx);
  const ds = distanceTo(shadowCore, W, H);
  const out = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    if (raw[p] === ST_NODATA) out[p] = ST_NODATA;
    else if (dc[p] <= o.bufferPx) out[p] = ST_CLOUD;
    else if (ds[p] <= o.bufferPx) out[p] = ST_SHADOW;
    else out[p] = ST_CLEAR;
  }
  return out;
}

/** Per-pixel state for one optical scene on `grid` (null for radar). */
export async function sceneMask(it: ImageryItem, grid: Grid, opts: { cloudBufferM: number; thinCloud: boolean } = loadQc(), signal?: AbortSignal): Promise<Uint8Array | null> {
  const se = stateExpr(it);
  if (!se) return null;
  const state = await fetchRaster(it, se, [0, 255], grid, signal);
  const he = opts.thinCloud ? hotExpr(it) : null;
  const hot = he ? await fetchRaster(it, he.expr, he.range, grid, signal).catch(() => null) : null;
  return buildMask(state.values, hot?.values ?? null, grid.width, grid.height, maskOptsFor(grid, opts));
}

/** Set every pixel that is not clear (cloud, cloud edge, thin cloud, shadow, no data) to NaN, in place. */
export async function maskCloudsInPlace(it: ImageryItem, r: Raster, signal?: AbortSignal): Promise<Raster> {
  const m = await sceneMask(it, r.grid, loadQc(), signal);
  if (m) for (let p = 0; p < r.values.length; p++) if (m[p] !== ST_CLEAR) r.values[p] = NaN;
  return r;
}
