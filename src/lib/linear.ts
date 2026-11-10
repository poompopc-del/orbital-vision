// Narrow linear change: new tracks, roads and cut lines through forest that are narrower than a
// Sentinel-2 pixel (10 m). A 4–6 m dirt track only partly fills the pixels it crosses, so their NDVI
// drops by ~0.05–0.15 — below the per-pixel thresholds of the other methods (≥ 0.20) and within
// the scene's own noise. Here the drop is averaged ALONG short line segments at many orientations:
// a real line adds up, random noise averages out, and a broad change (haze, phenology, a clearing)
// cancels against its own flanks.
//
// Steps (all on d = NDVI(before) − NDVI(after), positive = vegetation lost):
//  1. local residual r = d − 130 m box mean, used to estimate noise and to pick pixels that
//     themselves stand out
//  2. for each pixel and each of 12 orientations: mean of d on a 150 m segment through the pixel,
//     minus the mean on parallel segments 30 m to EACH side; the smaller of the two differences
//     counts, so a step edge (one side high) scores ~0 and only a ridge (both sides lower) scores
//  3. seeds = response ≥ median + 4.5·MAD of the scene's own responses (floor 0.04); grown along
//     the line into response ≥ median + 2.5·MAD (hysteresis keeps faint stretches attached)
//  4. keep connected pieces that are long (≥ 150 m) and thin
//
// Measured on synthetic 10 m scenes (tests/linear.test.ts): with per-image noise σ 0.03, a track
// that lowers NDVI by 0.10 is ~93 % recovered, 0.15 → 100 %; false pieces ≈ 1 per 100+ km² of
// unchanged forest. At σ 0.05 a 0.10 drop is mostly lost — noisy pairs miss faint tracks rather
// than invent them.
//
// Pure functions, no I/O.

export interface LinearOptions {
  /** metres per pixel of the grid (default 10) */
  pixelM?: number;
  /** segment length, m (default 90 m ≈ 9 px of Sentinel-2) */
  segmentM?: number;
  /** distance of the flank segments from the centre line, m (default 30) */
  flankM?: number;
  /** background box half-width, m (default 60) */
  backgroundM?: number;
  /** threshold in robust standard deviations of the response (default 5) */
  k?: number;
  /** absolute floor on the response, NDVI units (default 0.04) */
  minResponse?: number;
  /** shortest piece kept, m (default 150) */
  minLengthM?: number;
}

export interface LinearPiece {
  /** pixel indices of the piece */
  pixels: number[];
  /** length along its long axis, m */
  lengthM: number;
  /** mean NDVI drop on the piece (before − after) */
  meanDrop: number;
}

export interface LinearResult {
  /** 1 = pixel of a detected linear feature */
  mask: Uint8Array;
  pieces: LinearPiece[];
  /** threshold used on the response, NDVI units */
  threshold: number;
  /** robust noise of the residual, NDVI units */
  noise: number;
}

const ANGLES = 12;

/** Integer pixel offsets of a segment of n samples at angle a, shifted sideways by s pixels. */
function segment(a: number, n: number, s: number): Int16Array {
  const ux = Math.cos(a), uy = Math.sin(a);
  const px = -uy, py = ux; // perpendicular
  const out = new Int16Array(n * 2);
  const h = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const t = i - h;
    out[2 * i] = Math.round(t * ux + s * px);
    out[2 * i + 1] = Math.round(t * uy + s * py);
  }
  return out;
}

/** NaN-aware box mean of half-width r. */
export function boxMean(v: Float32Array, W: number, H: number, r: number): Float32Array {
  const S = new Float64Array((W + 1) * (H + 1));
  const C = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rs = 0, rc = 0;
    for (let x = 0; x < W; x++) {
      const a = v[y * W + x];
      if (!Number.isNaN(a)) { rs += a; rc++; }
      const k = (y + 1) * (W + 1) + x + 1;
      S[k] = S[k - (W + 1)] + rs;
      C[k] = C[k - (W + 1)] + rc;
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const a = y1 * (W + 1) + x1, b = y0 * (W + 1) + x1, c = y1 * (W + 1) + x0, d = y0 * (W + 1) + x0;
      const n = C[a] - C[b] - C[c] + C[d];
      out[y * W + x] = n > 0 ? (S[a] - S[b] - S[c] + S[d]) / n : NaN;
    }
  }
  return out;
}

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

/**
 * Find narrow linear vegetation loss.
 * @param before NDVI of the earlier image (NaN = no data / masked)
 * @param after NDVI of the later image (NaN = no data / masked)
 */
export function detectLinear(before: Float32Array, after: Float32Array, W: number, H: number, opt: LinearOptions = {}): LinearResult {
  const pixelM = opt.pixelM ?? 10;
  const nSeg = Math.max(5, Math.round((opt.segmentM ?? 150) / pixelM) | 1);
  const flank = Math.max(2, Math.round((opt.flankM ?? 30) / pixelM));
  const bgR = Math.max(3, Math.round((opt.backgroundM ?? 60) / pixelM));
  const k = opt.k ?? 4.5;
  const floor = opt.minResponse ?? 0.04;
  const minLenPx = (opt.minLengthM ?? 150) / pixelM;
  const NP = W * H;

  // 1. change and residual
  const d = new Float32Array(NP);
  for (let p = 0; p < NP; p++) {
    const a = before[p], b = after[p];
    d[p] = Number.isNaN(a) || Number.isNaN(b) ? NaN : a - b;
  }
  const bg = boxMean(d, W, H, bgR);
  const r = new Float32Array(NP);
  const sample: number[] = [];
  const stride = Math.max(1, Math.floor(NP / 40000));
  for (let p = 0; p < NP; p++) {
    r[p] = Number.isNaN(d[p]) || Number.isNaN(bg[p]) ? NaN : d[p] - bg[p];
    if (p % stride === 0 && !Number.isNaN(r[p])) sample.push(r[p]);
  }
  const mr = median(sample);
  const noise = 1.4826 * median(sample.map((x) => Math.abs(x - mr))) || 1e-3;

  // 2. oriented ridge response
  // each flank is two parallel lines (flank, flank + 1 px out) so its mean is less noisy than the centre's
  const cat = (x: Int16Array, y: Int16Array) => { const o = new Int16Array(x.length + y.length); o.set(x); o.set(y, x.length); return o; };
  const segs: { c: Int16Array; l: Int16Array; rt: Int16Array }[] = [];
  for (let i = 0; i < ANGLES; i++) {
    const a = (i * Math.PI) / ANGLES;
    segs.push({ c: segment(a, nSeg, 0), l: cat(segment(a, nSeg, -flank), segment(a, nSeg, -flank - 1)), rt: cat(segment(a, nSeg, flank), segment(a, nSeg, flank + 1)) });
  }
  // the ridge test runs on the raw change d: centre − flank already removes the background, and a
  // high-passed residual would turn a step edge into a false ridge
  const meanAt = (x: number, y: number, off: Int16Array): number => {
    let s = 0, n = 0;
    for (let i = 0; i < off.length; i += 2) {
      const xx = x + off[i], yy = y + off[i + 1];
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const v = d[yy * W + xx];
      if (!Number.isNaN(v)) { s += v; n++; }
    }
    return n >= Math.ceil(off.length * 0.35) ? s / n : NaN; // ≥ 70 % of the samples visible
  };
  const respAt = (p: number): number => {
    const y = (p / W) | 0, x = p - y * W;
    let best = -Infinity;
    for (const g of segs) {
      const c = meanAt(x, y, g.c);
      if (Number.isNaN(c)) continue;
      const l = meanAt(x, y, g.l), rt = meanAt(x, y, g.rt);
      if (Number.isNaN(l) || Number.isNaN(rt)) continue;
      const v = Math.min(c - l, c - rt);
      if (v > best) best = v;
    }
    return best === -Infinity ? NaN : best;
  };

  // threshold from the scene's own response, measured on an even sample of all pixels
  const rs: number[] = [];
  const st2 = Math.max(1, Math.floor(NP / 6000));
  for (let p = 0; p < NP; p += st2) {
    if (Number.isNaN(r[p])) continue;
    const v = respAt(p);
    if (!Number.isNaN(v)) rs.push(v);
  }
  const m = median(rs);
  const mad = 1.4826 * median(rs.map((x) => Math.abs(x - m))) || 1e-3;
  const threshold = Math.max(floor, m + k * mad);
  const low = Math.max(0.75 * floor, m + 2.5 * mad);

  // seeds: strong response on a pixel that itself clearly lost vegetation (cheap prefilter first)
  const resp = new Float32Array(NP).fill(NaN);
  const respOf = (p: number) => (Number.isNaN(resp[p]) ? (resp[p] = respAt(p)) : resp[p]);
  const cand = new Uint8Array(NP);
  const grow: number[] = [];
  for (let p = 0; p < NP; p++) {
    if (Number.isNaN(r[p]) || r[p] < 0.75 * noise || d[p] <= 0) continue;
    if (respOf(p) >= threshold) { cand[p] = 1; grow.push(p); }
  }
  // hysteresis: extend along the line into weaker response (faint stretches of the same track)
  while (grow.length) {
    const p = grow.pop()!;
    const y = (p / W) | 0, x = p - y * W;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const q = yy * W + xx;
        if (cand[q] || Number.isNaN(r[q]) || r[q] <= 0 || d[q] <= 0) continue;
        const v = respOf(q);
        if (v >= low) { cand[q] = 1; grow.push(q); }
      }
  }

  // 4. pieces: 2-pixel neighbourhood bridges single-pixel gaps in a faint track
  const mask = new Uint8Array(NP);
  const seen = new Uint8Array(NP);
  const pieces: LinearPiece[] = [];
  const stack: number[] = [];
  for (let p0 = 0; p0 < NP; p0++) {
    if (!cand[p0] || seen[p0]) continue;
    const px: number[] = [];
    stack.push(p0);
    seen[p0] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      px.push(p);
      const y = (p / W) | 0, x = p - y * W;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const q = yy * W + xx;
          if (cand[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
        }
    }
    const geo = shapeOf(px, W);
    // thin: long axis much longer than the short one, or few pixels for the span (curved tracks)
    const thin = geo.elong >= 3 || px.length <= 2.5 * geo.span;
    const lenPx = Math.max(geo.lengthPx, geo.span);
    if (!thin || lenPx < minLenPx) continue;
    let s = 0;
    for (const p of px) { mask[p] = 1; s += d[p]; }
    pieces.push({ pixels: px, lengthM: lenPx * pixelM, meanDrop: s / px.length });
  }
  pieces.sort((a, b) => b.lengthM - a.lengthM);
  return { mask, pieces, threshold, noise };
}

/** Second-moment shape of a set of pixels: long-axis length (≈ 2√3·σ), elongation, bounding span. */
export function shapeOf(px: number[], W: number): { lengthPx: number; elong: number; span: number } {
  let mx = 0, my = 0, mxx = 0, myy = 0, mxy = 0;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of px) {
    const y = (p / W) | 0, x = p - y * W;
    mx += x; my += y; mxx += x * x; myy += y * y; mxy += x * y;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const n = px.length;
  const ux = mx / n, uy = my / n;
  const cxx = mxx / n - ux * ux, cyy = myy / n - uy * uy, cxy = mxy / n - ux * uy;
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
  const q = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + q, l2 = Math.max(1 / 12, tr / 2 - q); // a 1-px-wide line has variance 1/12 across
  return { lengthPx: Math.sqrt(12 * l1), elong: Math.sqrt(l1 / l2), span: Math.hypot(x1 - x0 + 1, y1 - y0 + 1) };
}
