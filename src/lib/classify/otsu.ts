// Otsu (1979) adaptive threshold with a bimodality check.
// Otsu always returns a number, even for a one-mode histogram; using it there produces nonsense.
// We only accept it when the histogram separates well (η = σ²_between / σ²_total ≥ minEta; a single
// Gaussian already gives η ≈ 2/π ≈ 0.64, so the default is 0.7) and both
// sides hold a meaningful share of pixels; otherwise the caller keeps its fixed threshold.

export interface OtsuResult {
  threshold: number;
  /** separability η in 0–1 (Otsu's effectiveness measure) */
  eta: number;
  /** share of samples below the threshold */
  lowShare: number;
  accepted: boolean;
  reason: string;
}

export function otsu(
  values: ArrayLike<number>,
  lo: number,
  hi: number,
  opts: { bins?: number; minEta?: number; minShare?: number; clamp?: [number, number] } = {},
): OtsuResult {
  const bins = opts.bins ?? 128, minEta = opts.minEta ?? 0.7, minShare = opts.minShare ?? 0.03;
  const hist = new Float64Array(bins);
  let n = 0, sum = 0, sum2 = 0;
  const w = (hi - lo) / bins;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const c = Math.min(hi, Math.max(lo, v));
    hist[Math.min(bins - 1, Math.floor((c - lo) / w))]++;
    n++;
    sum += c;
    sum2 += c * c;
  }
  if (n < 50) return { threshold: NaN, eta: 0, lowShare: 0, accepted: false, reason: 'too few valid pixels' };
  const mean = sum / n;
  const varT = sum2 / n - mean * mean;
  if (varT <= 1e-12) return { threshold: NaN, eta: 0, lowShare: 0, accepted: false, reason: 'no variation' };
  let wB = 0, sumB = 0, best = -1, bestK = 0, bestEnd = 0;
  let sumAll = 0;
  for (let k = 0; k < bins; k++) sumAll += hist[k] * (lo + (k + 0.5) * w);
  for (let k = 0; k < bins - 1; k++) {
    wB += hist[k];
    sumB += hist[k] * (lo + (k + 0.5) * w);
    const wF = n - wB;
    if (!wB || !wF) continue;
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = (wB / n) * (wF / n) * (mB - mF) ** 2;
    if (between > best * (1 + 1e-9)) {
      best = between;
      bestK = k;
      bestEnd = k;
    } else if (between >= best * (1 - 1e-9)) bestEnd = k; // empty bins between the modes: same score
  }
  // middle of the plateau of equal scores (the valley between the modes), not its first edge
  bestK = Math.floor((bestK + bestEnd) / 2);
  const threshold = lo + (bestK + 1) * w;
  let below = 0;
  for (let k = 0; k <= bestK; k++) below += hist[k];
  const eta = best / varT;
  const lowShare = below / n;
  let accepted = eta >= minEta && lowShare >= minShare && lowShare <= 1 - minShare;
  let reason = accepted ? `bimodal (η = ${eta.toFixed(2)})` : eta < minEta ? `histogram not bimodal (η = ${eta.toFixed(2)})` : 'one class too small';
  if (accepted && opts.clamp && (threshold < opts.clamp[0] || threshold > opts.clamp[1])) {
    accepted = false;
    reason = `threshold ${threshold.toFixed(3)} outside plausible range ${opts.clamp[0]}…${opts.clamp[1]}`;
  }
  return { threshold, eta, lowShare, accepted, reason };
}
