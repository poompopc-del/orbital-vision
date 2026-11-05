// Spatial-context checks on a classified grid. The RAW classification is never modified: refinement
// returns new arrays so raw and refined results can be compared side by side.
//
// What it does
//  • isolated small water patches inside vegetation  → kept as water, confidence lowered, flagged
//  • vegetation-like pixels inside a large water body → flagged (floating vegetation / mixed pixels)
//  • single anomalous pixels (no neighbour shares the class) → flagged
//  • 3×3 majority smoothing ONLY for Low-confidence, non-water pixels with a clear neighbourhood
//    majority. Water is never removed and never created by smoothing (keeps small ponds, canals,
//    narrow rivers). Unknown / cloud / shadow pixels are never filled in.
import { Conf, LC } from './types';

export const FLAG = {
  isolatedWater: 1,
  vegInWater: 2,
  anomaly: 4,
  smoothed: 8,
} as const;

export interface ClassGrid {
  width: number;
  height: number;
  cls: Uint8Array; // LC
  level: Uint8Array; // Conf
}

const N8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
const isVeg = (c: number) => c === LC.Vegetation || c === LC.DenseVegetation || c === LC.Agriculture;
const isSurface = (c: number) => c >= LC.Water && c <= LC.Wetland;

/** 8-connected components of pixels whose class is in `target`. Returns labels (0 = not in target) and sizes. */
export function components(cls: Uint8Array, width: number, height: number, target: (c: number) => boolean) {
  const labels = new Int32Array(cls.length);
  const sizes: number[] = [0];
  const stack: number[] = [];
  let next = 1;
  for (let p0 = 0; p0 < cls.length; p0++) {
    if (labels[p0] || !target(cls[p0])) continue;
    let n = 0;
    labels[p0] = next;
    stack.push(p0);
    while (stack.length) {
      const p = stack.pop()!;
      n++;
      const x = p % width, y = (p - x) / width;
      for (const [dx, dy] of N8) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const q = yy * width + xx;
        if (!labels[q] && target(cls[q])) {
          labels[q] = next;
          stack.push(q);
        }
      }
    }
    sizes.push(n);
    next++;
  }
  return { labels, sizes };
}

export interface RefineOptions {
  /** water patches up to this many pixels are checked for isolation (they are never removed) */
  smallWaterPx: number;
  /** share of the patch's outer ring that must be vegetation to call it isolated */
  isolationShare: number;
  /** neighbours (of 8) that must agree before a Low-confidence pixel is smoothed */
  majority: number;
}

export const REFINE_DEFAULT: RefineOptions = { smallWaterPx: 3, isolationShare: 0.75, majority: 6 };

export interface Refined extends ClassGrid {
  flags: Uint8Array;
  counts: { isolatedWater: number; vegInWater: number; anomaly: number; smoothed: number };
}

export function refine(g: ClassGrid, opts: RefineOptions = REFINE_DEFAULT): Refined {
  const { width: W, height: H } = g;
  const cls = g.cls.slice();
  const level = g.level.slice();
  const flags = new Uint8Array(cls.length);
  const counts = { isolatedWater: 0, vegInWater: 0, anomaly: 0, smoothed: 0 };

  // 1 — isolated small water patches inside vegetation
  const { labels, sizes } = components(g.cls, W, H, (c) => c === LC.Water);
  const ring = new Map<number, { veg: number; total: number }>();
  for (let p = 0; p < cls.length; p++) {
    const l = labels[p];
    if (!l || sizes[l] > opts.smallWaterPx) continue;
    const x = p % W, y = (p - x) / W;
    const r = ring.get(l) ?? { veg: 0, total: 0 };
    for (const [dx, dy] of N8) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const q = yy * W + xx;
      if (labels[q] === l) continue;
      if (!isSurface(g.cls[q])) continue; // cloud / unknown neighbours say nothing
      r.total++;
      if (isVeg(g.cls[q])) r.veg++;
    }
    ring.set(l, r);
  }
  for (let p = 0; p < cls.length; p++) {
    const l = labels[p];
    const r = l ? ring.get(l) : undefined;
    if (r && r.total >= 3 && r.veg / r.total >= opts.isolationShare) {
      flags[p] |= FLAG.isolatedWater;
      level[p] = Math.max(Conf.Low, level[p] - 1);
      counts.isolatedWater++;
    }
  }

  // 2 — vegetation inside water, 3 — anomalies, 4 — majority smoothing (from the RAW grid, one pass)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      const c = g.cls[p];
      if (!isSurface(c)) continue;
      const tally = new Map<number, number>();
      let water = 0, same = 0, valid = 0;
      for (const [dx, dy] of N8) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const n = g.cls[yy * W + xx];
        if (!isSurface(n)) continue;
        valid++;
        if (n === LC.Water) water++;
        if (n === c) same++;
        tally.set(n, (tally.get(n) ?? 0) + 1);
      }
      if (isVeg(c) && water >= 6) {
        flags[p] |= FLAG.vegInWater;
        level[p] = Math.max(Conf.Low, level[p] - 1);
        counts.vegInWater++;
      }
      if (valid >= 5 && same === 0) {
        flags[p] |= FLAG.anomaly;
        counts.anomaly++;
      }
      if (c !== LC.Water && g.level[p] <= Conf.Low) {
        let best = 0, bestN = 0;
        tally.forEach((n, k) => {
          if (k !== c && k !== LC.Water && n > bestN) { best = k; bestN = n; }
        });
        if (bestN >= opts.majority) {
          cls[p] = best;
          level[p] = Conf.Low;
          flags[p] |= FLAG.smoothed;
          counts.smoothed++;
        }
      }
    }
  return { width: W, height: H, cls, level, flags, counts };
}

/** NaN-aware box mean in linear power (dB in / dB out) — reduces radar speckle before thresholding. */
export function despeckleDb(db: Float32Array, width: number, height: number, r = 2): Float32Array {
  const lin = new Float32Array(db.length);
  for (let p = 0; p < db.length; p++) lin[p] = Number.isNaN(db[p]) ? NaN : 10 ** (db[p] / 10);
  const out = new Float32Array(db.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (Number.isNaN(lin[p])) { out[p] = NaN; continue; }
      let s = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const v = lin[yy * width + xx];
          if (!Number.isNaN(v)) { s += v; n++; }
        }
      }
      out[p] = 10 * Math.log10(s / n);
    }
  return out;
}
