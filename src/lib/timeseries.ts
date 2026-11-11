// Change over a STACK of scenes (3 … 20), not a pair: for every pixel, when did vegetation go — and
// did it stay gone? Then which way and how fast each changed area grew.
//
// The break threshold adapts to the stack: max(0.12, 3.5 × its measured scene-to-scene noise).
// Per pixel, on NDVI with cloud / shadow / no data as NaN (each scene contributes only where it is clear):
//  - a "break" at scene k = NDVI there is ≥ `drop` below the pixel's own baseline (median of its
//    earlier clear values) AND stays down in the next clear scene(s) (≥ 70 % of the drop) — a single
//    low value that recovers is cloud edge, shadow, haze or noise and is ignored
//  - a break on the newest clear value cannot be confirmed yet → kept apart as "latest, unconfirmed"
// Then connected pieces (8-neighbour, gaps of one pixel bridged) of ≥ `minPixels` are kept; for each
// piece with breaks on ≥ 2 dates the growth direction is centroid(earliest date) → centroid(latest),
// the speed that distance over the days between them.
//
// Pure functions, no I/O — tested in tests/timeseries.test.ts.

export interface StackOptions {
  /** NDVI drop from the pixel's baseline that counts as a break (default 0.12; raised to 3.5 × the
   *  stack's own scene-to-scene noise when that is higher, so noisy / hazy stacks do not light up) */
  drop?: number;
  /** clear values needed before a break, as baseline (default 2) */
  minBaseline?: number;
  /** later clear values that must stay down to confirm (default 1) */
  confirm?: number;
  /** smallest piece kept, pixels (default 6) */
  minPixels?: number;
  /** only pixels with mask[p] = 1 are analysed (e.g. forest); default all */
  mask?: Uint8Array | null;
  /** metres per pixel, for lengths and speeds (default 10) */
  pixelM?: number;
}

export interface Growth {
  /** compass bearing of growth, degrees clockwise from north */
  bearingDeg: number;
  /** centroid shift from the first to the last break date, m */
  distM: number;
  /** that shift per 30 days, m */
  mPerMonth: number;
  /** pixel positions (col, row) of the two centroids, for drawing the arrow */
  from: [number, number];
  to: [number, number];
}

export interface StackPiece {
  n: number;
  pixels: number[];
  /** index of the earliest / latest scene with a break in this piece */
  first: number;
  last: number;
  /** pixel count per scene index (breaks first seen on that scene) */
  perScene: number[];
  /** centroid (col, row) */
  cx: number;
  cy: number;
  /** long axis length, m */
  lengthM: number;
  growth: Growth | null;
  /** all of its breaks are on the newest clear value of their pixels */
  unconfirmed: boolean;
}

/** Scene-to-scene noise of one clear NDVI value (robust σ), from consecutive clear values of a pixel sample. */
export function stackNoise(stack: Float32Array[], NP: number, mask?: Uint8Array | null): number {
  const d: number[] = [];
  const step = Math.max(1, Math.floor(NP / 20000));
  for (let p = 0; p < NP; p += step) {
    if (mask && !mask[p]) continue;
    let prev = NaN;
    for (const s of stack) {
      const v = s[p];
      if (Number.isNaN(v)) continue;
      if (!Number.isNaN(prev)) d.push(Math.abs(v - prev));
      prev = v;
    }
  }
  if (!d.length) return 0;
  // |a − b| of two values with noise σ each: median = 0.6745 · √2 · σ
  return median(d) / (0.6745 * Math.SQRT2);
}

export interface StackResult {
  /** break threshold actually used (NDVI) and the measured noise */
  drop: number;
  noise: number;
  /** scene index of the confirmed break per pixel, −1 = none */
  breakAt: Int16Array;
  /** scene index of a break seen only on the newest clear value, −1 = none */
  latestAt: Int16Array;
  pieces: StackPiece[];
  /** new pixels per scene index (confirmed + latest), over kept pieces */
  perScene: number[];
  /** pixels with at least minBaseline + 1 clear values (could be analysed) */
  analysable: number;
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** One pixel's series (values in scene order, NaN = not clear) → [break index or −1, confirmed?] */
export function pixelBreak(series: ArrayLike<number>, drop = 0.12, minBaseline = 2, confirm = 1): [number, boolean] {
  const t: number[] = [], v: number[] = [];
  for (let k = 0; k < series.length; k++) if (!Number.isNaN(series[k])) { t.push(k); v.push(series[k]); }
  for (let i = minBaseline; i < v.length; i++) {
    const base = median(v.slice(0, i));
    if (base - v[i] < drop) continue;
    const later = v.slice(i + 1, i + 1 + confirm);
    if (!later.length) return [t[i], false];
    if (later.length >= Math.min(confirm, v.length - i - 1) && later.every((x) => base - x >= 0.7 * drop)) return [t[i], true];
    // recovered: not a lasting change at i; keep looking (the baseline grows past it)
  }
  return [-1, false];
}

/**
 * @param stack NDVI per scene, scenes in time order, NaN = not clear
 * @param days scene dates as days (any origin), same order
 */
export function analyseStack(stack: Float32Array[], days: number[], W: number, H: number, opt: StackOptions = {}): StackResult {
  const noise = stackNoise(stack, W * H, opt.mask);
  const drop = Math.max(opt.drop ?? 0.12, 3.5 * noise), minB = opt.minBaseline ?? 2, conf = opt.confirm ?? 1, minPx = opt.minPixels ?? 6, pixelM = opt.pixelM ?? 10;
  const S = stack.length, NP = W * H;
  const breakAt = new Int16Array(NP).fill(-1), latestAt = new Int16Array(NP).fill(-1);
  const ser = new Float32Array(S);
  let analysable = 0;
  for (let p = 0; p < NP; p++) {
    if (opt.mask && !opt.mask[p]) continue;
    let n = 0;
    for (let k = 0; k < S; k++) { ser[k] = stack[k][p]; if (!Number.isNaN(ser[k])) n++; }
    if (n < minB + 1) continue;
    analysable++;
    const [k, ok] = pixelBreak(ser, drop, minB, conf);
    if (k < 0) continue;
    if (ok) breakAt[p] = k; else latestAt[p] = k;
  }
  // pieces over confirmed + latest breaks
  const on = (p: number) => breakAt[p] >= 0 || latestAt[p] >= 0;
  const seen = new Uint8Array(NP);
  const pieces: StackPiece[] = [];
  const perSceneAll = new Array(S).fill(0);
  const stackP: number[] = [];
  for (let p0 = 0; p0 < NP; p0++) {
    if (!on(p0) || seen[p0]) continue;
    const px: number[] = [];
    stackP.push(p0);
    seen[p0] = 1;
    while (stackP.length) {
      const p = stackP.pop()!;
      px.push(p);
      const y = (p / W) | 0, x = p - y * W;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const q = yy * W + xx;
          if (on(q) && !seen[q]) { seen[q] = 1; stackP.push(q); }
        }
    }
    if (px.length < minPx) {
      for (const p of px) { breakAt[p] = -1; latestAt[p] = -1; }
      continue;
    }
    const per = new Array(S).fill(0);
    const sx = new Array(S).fill(0), sy = new Array(S).fill(0);
    let cx = 0, cy = 0, nConf = 0;
    let mxx = 0, myy = 0, mxy = 0;
    for (const p of px) {
      const k = breakAt[p] >= 0 ? breakAt[p] : latestAt[p];
      if (breakAt[p] >= 0) nConf++;
      const y = (p / W) | 0, x = p - y * W;
      per[k]++; sx[k] += x; sy[k] += y;
      cx += x; cy += y; mxx += x * x; myy += y * y; mxy += x * y;
    }
    const n = px.length;
    cx /= n; cy /= n;
    const vxx = mxx / n - cx * cx, vyy = myy / n - cy * cy, vxy = mxy / n - cx * cy;
    const l1 = (vxx + vyy) / 2 + Math.sqrt(Math.max(0, ((vxx - vyy) / 2) ** 2 + vxy * vxy));
    const ks = per.map((c, k) => (c ? k : -1)).filter((k) => k >= 0);
    const first = ks[0], last = ks[ks.length - 1];
    let growth: Growth | null = null;
    // a direction needs a real amount of change on both ends (≥ 3 px each), and a shift ≥ 2 px
    if (last > first && per[first] >= 3 && per[last] >= 3) {
      const from: [number, number] = [sx[first] / per[first], sy[first] / per[first]];
      const to: [number, number] = [sx[last] / per[last], sy[last] / per[last]];
      const dx = to[0] - from[0], dy = to[1] - from[1];
      const d = Math.hypot(dx, dy);
      const span = days[last] - days[first];
      if (d >= 2 && span > 0) {
        growth = {
          bearingDeg: ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360, // rows grow southwards
          distM: d * pixelM,
          mPerMonth: (d * pixelM * 30) / span,
          from, to,
        };
      }
    }
    per.forEach((c, k) => (perSceneAll[k] += c));
    pieces.push({ n: 0, pixels: px, first, last, perScene: per, cx, cy, lengthM: Math.max(pixelM, Math.sqrt(12 * l1) * pixelM), growth, unconfirmed: nConf === 0 });
  }
  pieces.sort((a, b) => b.pixels.length - a.pixels.length);
  pieces.forEach((pc, i) => (pc.n = i + 1));
  return { breakAt, latestAt, pieces, perScene: perSceneAll, analysable, drop, noise };
}

/** Sequential colour per scene index (old → new: yellow → orange → red → purple), RGB. */
export function dateColour(k: number, S: number): [number, number, number] {
  const stops: [number, number, number][] = [[250, 204, 21], [249, 115, 22], [220, 38, 38], [147, 51, 234]];
  const t = S <= 1 ? 1 : k / (S - 1);
  const f = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), u = f - i;
  return [0, 1, 2].map((c) => Math.round(stops[i][c] + (stops[i + 1][c] - stops[i][c]) * u)) as [number, number, number];
}

const DIR_TH = ['เหนือ', 'ตะวันออกเฉียงเหนือ', 'ตะวันออก', 'ตะวันออกเฉียงใต้', 'ใต้', 'ตะวันตกเฉียงใต้', 'ตะวันตก', 'ตะวันตกเฉียงเหนือ'];
const DIR_EN = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const compass = (deg: number, th: boolean) => (th ? DIR_TH : DIR_EN)[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
