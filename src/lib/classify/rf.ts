// Random Forest classifier (Breiman 2001): bootstrap-sampled CART trees with Gini splits and a random
// feature subset at each node. Small and dependency-free so it runs in the browser on a few thousand samples.
//
// The forest's vote share is reported as "model confidence". It is NOT accuracy and is not calibrated;
// probability calibration needs an independent validation set (see accuracy.ts).
import type { FeatureName, Sensor } from './types';

export interface TreeNode {
  /** leaf: class probabilities indexed like `classes` */
  p?: number[];
  f?: number; // feature index
  t?: number; // threshold (go left when value <= t)
  l?: TreeNode;
  r?: TreeNode;
}

export interface ForestParams {
  nTrees: number;
  maxDepth: number;
  minLeaf: number;
  /** features tried per split; default √F */
  mtry?: number;
  seed: number;
  /** candidate thresholds per feature per node (quantiles) */
  maxThresholds: number;
}

export const FOREST_DEFAULT: ForestParams = { nTrees: 60, maxDepth: 14, minLeaf: 2, seed: 42, maxThresholds: 24 };

export interface ModelMeta {
  id: string;
  name: string;
  sensor: Sensor;
  features: FeatureName[];
  classes: number[]; // LC ids
  createdAt: string;
  params: ForestParams;
  training: { samples: number; groups: number; perClass: Record<number, number>; sceneIds: string[] };
  /** null until evaluated on held-out reference samples */
  validation: null | { samples: number; groups: number; overallAccuracy: number; kappa: number; method: string };
  notes?: string;
}

export interface Forest {
  meta: ModelMeta;
  trees: TreeNode[];
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gini(counts: number[], n: number) {
  if (!n) return 0;
  let s = 1;
  for (const c of counts) s -= (c / n) ** 2;
  return s;
}

function leaf(idx: number[], y: number[], K: number): TreeNode {
  const c = new Array(K).fill(0);
  for (const i of idx) c[y[i]]++;
  return { p: c.map((x) => x / idx.length) };
}

function buildTree(X: number[][], y: number[], idx: number[], K: number, depth: number, P: ForestParams, mtry: number, rand: () => number): TreeNode {
  const F = X[0].length;
  const counts = new Array(K).fill(0);
  for (const i of idx) counts[y[i]]++;
  if (depth >= P.maxDepth || idx.length < 2 * P.minLeaf || counts.some((c) => c === idx.length)) return leaf(idx, y, K);
  const parent = gini(counts, idx.length);
  let best = { gain: 1e-9, f: -1, t: 0 };
  // random feature subset
  const feats = Array.from({ length: F }, (_, i) => i);
  for (let i = feats.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [feats[i], feats[j]] = [feats[j], feats[i]];
  }
  for (const f of feats.slice(0, mtry)) {
    const vals = idx.map((i) => X[i][f]).filter(Number.isFinite).sort((a, b) => a - b);
    if (vals.length < 2 || vals[0] === vals[vals.length - 1]) continue;
    const cand = new Set<number>();
    for (let q = 1; q < P.maxThresholds; q++) {
      const k = Math.floor((q / P.maxThresholds) * (vals.length - 1));
      if (vals[k] < vals[vals.length - 1]) cand.add((vals[k] + vals[Math.min(vals.length - 1, k + 1)]) / 2);
    }
    for (const t of cand) {
      const cl = new Array(K).fill(0), cr = new Array(K).fill(0);
      let nl = 0, nr = 0;
      for (const i of idx) {
        const v = X[i][f];
        // missing values go right (consistent at predict time)
        if (Number.isFinite(v) && v <= t) { cl[y[i]]++; nl++; } else { cr[y[i]]++; nr++; }
      }
      if (nl < P.minLeaf || nr < P.minLeaf) continue;
      const gain = parent - (nl / idx.length) * gini(cl, nl) - (nr / idx.length) * gini(cr, nr);
      if (gain > best.gain) best = { gain, f, t };
    }
  }
  if (best.f < 0) return leaf(idx, y, K);
  const L: number[] = [], R: number[] = [];
  for (const i of idx) {
    const v = X[i][best.f];
    (Number.isFinite(v) && v <= best.t ? L : R).push(i);
  }
  return { f: best.f, t: best.t, l: buildTree(X, y, L, K, depth + 1, P, mtry, rand), r: buildTree(X, y, R, K, depth + 1, P, mtry, rand) };
}

/** Train a forest. `y` holds class ids (any numbers); they are mapped to indices internally. */
export function trainForest(X: number[][], yIds: number[], meta: Omit<ModelMeta, 'classes' | 'params'>, params: Partial<ForestParams> = {}): Forest {
  if (!X.length) throw new Error('No training samples');
  if (X.length !== yIds.length) throw new Error('X and y differ in length');
  const P = { ...FOREST_DEFAULT, ...params };
  const classes = [...new Set(yIds)].sort((a, b) => a - b);
  if (classes.length < 2) throw new Error('Training needs at least two classes');
  const y = yIds.map((c) => classes.indexOf(c));
  const F = X[0].length;
  const mtry = P.mtry ?? Math.max(1, Math.round(Math.sqrt(F)));
  const rand = rng(P.seed);
  const trees: TreeNode[] = [];
  for (let t = 0; t < P.nTrees; t++) {
    const idx = Array.from({ length: X.length }, () => Math.floor(rand() * X.length));
    trees.push(buildTree(X, y, idx, classes.length, 0, P, mtry, rand));
  }
  return { meta: { ...meta, classes, params: P }, trees };
}

function walk(n: TreeNode, x: number[]): number[] {
  while (!n.p) {
    const v = x[n.f!];
    n = Number.isFinite(v) && v <= n.t! ? n.l! : n.r!;
  }
  return n.p;
}

/** Mean class probabilities over all trees (indexed like forest.meta.classes). */
export function predictProba(forest: Forest, x: number[]): number[] {
  const K = forest.meta.classes.length;
  const s = new Array(K).fill(0);
  for (const t of forest.trees) {
    const p = walk(t, x);
    for (let k = 0; k < K; k++) s[k] += p[k];
  }
  return s.map((v) => v / forest.trees.length);
}

export function predict(forest: Forest, x: number[]): { cls: number; p: number; margin: number } {
  const pr = predictProba(forest, x);
  let a = 0, b = -1;
  for (let k = 1; k < pr.length; k++) if (pr[k] > pr[a]) a = k;
  for (let k = 0; k < pr.length; k++) if (k !== a && (b < 0 || pr[k] > pr[b])) b = k;
  return { cls: forest.meta.classes[a], p: pr[a], margin: pr[a] - (b >= 0 ? pr[b] : 0) };
}

/** Compact JSON (rounded thresholds) for storage. */
export function serializeForest(f: Forest): string {
  const r = (n: TreeNode): any => (n.p ? { p: n.p.map((v) => Math.round(v * 1000) / 1000) } : { f: n.f, t: Math.round(n.t! * 1e5) / 1e5, l: r(n.l!), r: r(n.r!) });
  return JSON.stringify({ meta: f.meta, trees: f.trees.map(r) });
}

export function parseForest(s: string): Forest {
  const o = JSON.parse(s);
  if (!o?.meta || !Array.isArray(o.trees) || !Array.isArray(o.meta.features) || !Array.isArray(o.meta.classes)) throw new Error('Not an ORBITAL VISION model file');
  return o as Forest;
}
