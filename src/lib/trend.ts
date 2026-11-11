// Multi-scene trend analysis in the browser: reads NDVI + the cloud mask of each scene over the AOI,
// runs the stack analysis (timeseries.ts) and returns what the map and the panel draw.
import { fetchRaster, gridFor, type Grid } from './change';
import { indexExpression, INDICES } from './spectral';
import { landCoverMask, stateExpr } from './monitor';
import { analyseStack, compass, dateColour, type Growth } from './timeseries';
import type { ImageryItem } from './stac';

export interface TrendScene { id: string; collection: string; date: string }
export interface TrendPiece {
  n: number;
  lat: number;
  lon: number;
  km2: number;
  lengthKm: number;
  /** first / last scene index with change */
  first: number;
  last: number;
  unconfirmed: boolean;
  growth: (Growth & { fromLL: [number, number]; toLL: [number, number]; dirTh: string; dirEn: string }) | null;
}
export interface TrendRun {
  scenes: TrendScene[];
  /** km² of new change first seen on each scene (kept pieces) */
  perSceneKm2: number[];
  totalKm2: number;
  analysedKm2: number;
  pieces: TrendPiece[];
  /** lat/lon-linear RGBA image of the change coloured by date, and its bounds */
  imageUrl: string;
  /** one image per scene index k: change seen up to scene k (for the time-lapse slider) */
  frameUrls: string[];
  bounds: { west: number; south: number; east: number; north: number };
  drop: number;
  noise: number;
  forestOnly: boolean;
}

const gridMetres = (g: Grid) => ((g.east - g.west) * 111320 * Math.cos((((g.south + g.north) / 2) * Math.PI) / 180)) / g.width;

function pointInRing(lon: number, lat: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const tileYToLat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};
const latToTileY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

/** NaN-aware mean over f×f blocks; a block counts when ≥ half of it is valid. */
function blockMean(v: Float32Array, W: number, H: number, f: number): Float32Array {
  if (f <= 1) return v;
  const w = Math.ceil(W / f), h = Math.ceil(H / f);
  const s = new Float32Array(w * h), n = new Uint16Array(w * h);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const a = v[y * W + x];
      if (Number.isNaN(a)) continue;
      const q = ((y / f) | 0) * w + ((x / f) | 0);
      s[q] += a;
      n[q]++;
    }
  return Float32Array.from(s, (t, q) => (n[q] >= (f * f) / 2 ? t / n[q] : NaN));
}

export async function runTrend(
  aoi: GeoJSON.Polygon,
  scenes: ImageryItem[],
  progress: (msg: string) => void,
  signal?: AbortSignal,
  opt: { forestOnly?: boolean } = {},
): Promise<TrendRun> {
  const list = [...scenes].filter((s) => stateExpr(s)).sort((a, b) => a.datetime.localeCompare(b.datetime));
  if (list.length < 3) throw new Error('ต้องมีภาพแสง (Sentinel-2/Landsat) อย่างน้อย 3 ภาพ');
  const grid = gridFor(aoi);
  const W = grid.width, H = grid.height;
  const f = Math.max(1, Math.round(10 / Math.max(1, gridMetres(grid))));
  const w2 = Math.ceil(W / f), h2 = Math.ceil(H / f);
  const pxM = gridMetres(grid) * f;
  const ndviDef = INDICES.find((i) => i.id === 'ndvi')!;
  // which coarse cells are inside the AOI
  const ring = aoi.coordinates[0];
  const inside = new Uint8Array(w2 * h2);
  for (let r = 0; r < h2; r++) {
    const lat = tileYToLat(grid.y0 + ((r + 0.5) * f) / 256, grid.z);
    for (let c = 0; c < w2; c++) {
      const lon = grid.west + (((c + 0.5) * f) / W) * (grid.east - grid.west);
      inside[r * w2 + c] = pointInRing(lon, lat, ring) ? 1 : 0;
    }
  }
  let mask: Uint8Array = inside;
  const forestOnly = opt.forestOnly !== false;
  if (forestOnly) {
    progress('อ่านแผนที่ป่า (ESA WorldCover)…');
    const lc = await landCoverMask(aoi, 'clearing', grid, signal).catch(() => null);
    if (lc) {
      const keep = blockMean(Float32Array.from(lc, (v) => (Number.isNaN(v) ? NaN : v > 1.5 ? 1 : 0)), W, H, f);
      mask = Uint8Array.from(inside, (v, q) => (v && keep[q] >= 0.5 ? 1 : 0));
    }
  }
  const stack: Float32Array[] = [];
  for (let k = 0; k < list.length; k++) {
    const it = list[k];
    const lbl = `ภาพ ${k + 1}/${list.length} (${it.datetime.slice(0, 10)})`;
    const nd = await fetchRaster(it, indexExpression(it, ndviDef), [-1, 1], grid, signal, (d, n) => progress(`อ่าน NDVI ${lbl} ${d}/${n}`));
    const st = await fetchRaster(it, stateExpr(it)!, [0, 255], grid, signal, (d, n) => progress(`อ่านหน้ากากเมฆ ${lbl} ${d}/${n}`));
    const clear = Float32Array.from(nd.values, (v, p) => (Math.round(st.values[p]) === 4 ? v : NaN));
    const coarse = blockMean(clear, W, H, f);
    for (let q = 0; q < coarse.length; q++) if (!mask[q]) coarse[q] = NaN;
    stack.push(coarse);
  }
  progress('วิเคราะห์อนุกรมเวลา (หาวันที่พืชพรรณหายและไม่กลับ)…');
  const days = list.map((s) => Date.parse(s.datetime) / 864e5);
  const res = analyseStack(stack, days, w2, h2, { pixelM: pxM });
  const S = list.length;
  const cellKm2 = (pxM * pxM) / 1e6;

  // ---- images: re-projected from the Mercator grid to lat/lon-linear rows for draping
  const north = grid.north, south = grid.south;
  const rowOf = (r: number) => {
    const lat = north - ((r + 0.5) / h2) * (north - south);
    return Math.min(h2 - 1, Math.max(0, Math.floor(((latToTileY(lat, grid.z) - grid.y0) * 256) / f)));
  };
  const rows = Array.from({ length: h2 }, (_, r) => rowOf(r));
  const draw = (upTo: number) => {
    const cv = document.createElement('canvas');
    cv.width = w2;
    cv.height = h2;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(w2, h2);
    for (let r = 0; r < h2; r++)
      for (let c = 0; c < w2; c++) {
        const q = rows[r] * w2 + c;
        const k = res.breakAt[q] >= 0 ? res.breakAt[q] : res.latestAt[q];
        if (k < 0 || k > upTo) continue;
        const [R, G, B] = dateColour(k, S);
        const o = (r * w2 + c) * 4;
        img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B;
        img.data[o + 3] = res.breakAt[q] >= 0 ? 235 : 130; // unconfirmed (newest scene only) lighter
      }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  };
  const frameUrls = list.map((_, k) => draw(k));
  const ll = (c: number, r: number): [number, number] => [grid.west + ((c + 0.5) / w2) * (grid.east - grid.west), tileYToLat(grid.y0 + ((r + 0.5) * f) / 256, grid.z)];
  const pieces: TrendPiece[] = res.pieces.map((pc) => {
    const [lon, lat] = ll(pc.cx, pc.cy);
    return {
      n: pc.n, lon, lat, km2: pc.pixels.length * cellKm2, lengthKm: pc.lengthM / 1000, first: pc.first, last: pc.last, unconfirmed: pc.unconfirmed,
      growth: pc.growth ? { ...pc.growth, fromLL: ll(...pc.growth.from), toLL: ll(...pc.growth.to), dirTh: compass(pc.growth.bearingDeg, true), dirEn: compass(pc.growth.bearingDeg, false) } : null,
    };
  });
  const perSceneKm2 = res.perScene.map((n) => n * cellKm2);
  return {
    scenes: list.map((s) => ({ id: s.id, collection: String(s.collection), date: s.datetime.slice(0, 10) })),
    perSceneKm2,
    totalKm2: perSceneKm2.reduce((a, b) => a + b, 0),
    analysedKm2: res.analysable * cellKm2,
    pieces,
    imageUrl: frameUrls[S - 1],
    frameUrls,
    bounds: { west: grid.west, south, east: grid.east, north },
    drop: res.drop,
    noise: res.noise,
    forestOnly,
  };
}
