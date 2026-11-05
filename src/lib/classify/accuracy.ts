// Accuracy assessment from reference samples (Congalton & Green; Olofsson et al. 2014 terminology).
//   rows = reference (truth), columns = predicted.
//   Producer's accuracy = recall = correct / reference total (omission error = 1 − PA)
//   User's accuracy     = precision = correct / predicted total (commission error = 1 − UA)
// Numbers are only meaningful when the reference samples are independent of the training samples —
// spatialSplit() keeps whole sample groups (polygons / ~1 km blocks) on one side to avoid spatial leakage.

export interface ClassMetrics {
  cls: number;
  reference: number;
  predicted: number;
  correct: number;
  producers: number; // = recall
  users: number; // = precision
  f1: number;
  iou: number;
}

export interface Assessment {
  classes: number[];
  matrix: number[][];
  n: number;
  overallAccuracy: number;
  kappa: number;
  perClass: ClassMetrics[];
}

export function assess(reference: number[], predicted: number[], classes?: number[]): Assessment {
  if (reference.length !== predicted.length) throw new Error('reference and predicted differ in length');
  const cls = classes ?? [...new Set([...reference, ...predicted])].sort((a, b) => a - b);
  const K = cls.length;
  const ix = new Map(cls.map((c, i) => [c, i]));
  const m = Array.from({ length: K }, () => new Array(K).fill(0));
  let n = 0;
  for (let i = 0; i < reference.length; i++) {
    const r = ix.get(reference[i]), p = ix.get(predicted[i]);
    if (r == null || p == null) continue;
    m[r][p]++;
    n++;
  }
  const row = m.map((r) => r.reduce((a, b) => a + b, 0));
  const col = cls.map((_, j) => m.reduce((a, r) => a + r[j], 0));
  const diag = cls.map((_, i) => m[i][i]);
  const correct = diag.reduce((a, b) => a + b, 0);
  const oa = n ? correct / n : NaN;
  const pe = n ? cls.reduce((a, _, i) => a + (row[i] * col[i]) / (n * n), 0) : NaN;
  const kappa = n && pe < 1 ? (oa - pe) / (1 - pe) : NaN;
  const perClass = cls.map((c, i) => {
    const pa = row[i] ? diag[i] / row[i] : NaN;
    const ua = col[i] ? diag[i] / col[i] : NaN;
    const f1 = pa + ua > 0 ? (2 * pa * ua) / (pa + ua) : NaN;
    const union = row[i] + col[i] - diag[i];
    return { cls: c, reference: row[i], predicted: col[i], correct: diag[i], producers: pa, users: ua, f1, iou: union ? diag[i] / union : NaN };
  });
  return { classes: cls, matrix: m, n, overallAccuracy: oa, kappa, perClass };
}

export interface Sample {
  cls: number;
  /** spatial group (polygon id or spatial block) — never split between training and validation */
  group: string;
  x: number[];
  lon?: number;
  lat?: number;
}

/** Spatial block id for a point (blockDeg ≈ 0.01° ≈ 1.1 km). */
export const blockOf = (lon: number, lat: number, blockDeg = 0.01) => `b${Math.floor(lon / blockDeg)}_${Math.floor(lat / blockDeg)}`;

/**
 * Split by group so that no group appears on both sides. Groups are assigned per class (stratified) so
 * each class with ≥ 2 groups gets validation groups. Deterministic for a seed.
 */
export function spatialSplit<T extends { cls: number; group: string }>(samples: T[], valShare = 0.3, seed = 7): { train: T[]; val: T[]; trainGroups: string[]; valGroups: string[]; warnings: string[] } {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const byClass = new Map<number, string[]>();
  const groupClass = new Map<string, number>();
  for (const x of samples) {
    if (!groupClass.has(x.group)) groupClass.set(x.group, x.cls);
    const arr = byClass.get(x.cls) ?? [];
    if (!arr.includes(x.group)) arr.push(x.group);
    byClass.set(x.cls, arr);
  }
  const valGroups = new Set<string>();
  const warnings: string[] = [];
  for (const [c, groups] of [...byClass.entries()].sort((a, b) => a[0] - b[0])) {
    const g = [...groups].sort();
    for (let i = g.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [g[i], g[j]] = [g[j], g[i]];
    }
    if (g.length < 2) {
      warnings.push(`class ${c}: only one sample group — cannot be validated independently`);
      continue;
    }
    const k = Math.max(1, Math.round(g.length * valShare));
    g.slice(0, k).forEach((x) => valGroups.add(x));
  }
  // a group shared by several classes (mixed polygon) goes wholly to one side
  const train = samples.filter((x) => !valGroups.has(x.group));
  const val = samples.filter((x) => valGroups.has(x.group));
  const trainGroups = [...new Set(train.map((x) => x.group))];
  return { train, val, trainGroups, valGroups: [...valGroups], warnings };
}
