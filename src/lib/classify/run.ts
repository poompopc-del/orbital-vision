// Classify a whole stack (rules or a trained model), refine with spatial context and summarise.
import { Conf, LC, LC_CLASSES, QA, qaValid, type FeatureName } from './types';
import { classifyPixel, qaClass, type OpticalProfile, type PixelContext, type SarProfile } from './rules';
import { predict, type Forest } from './rf';
import { refine, REFINE_DEFAULT, type Refined, type RefineOptions } from './spatial';
import { completeStack, pixelFeatures, type Stack } from './stack';

export type Method = 'rules' | 'model';

export interface LandCover {
  width: number;
  height: number;
  method: Method;
  methodLabel: string;
  /** raw per-pixel result */
  cls: Uint8Array;
  level: Uint8Array;
  score: Float32Array;
  qa: Uint8Array;
  /** spatially refined copy (raw is kept) */
  refined: Refined;
  /** 'provisional' = rules or a model never checked against held-out reference data */
  status: 'provisional' | 'validated-on-samples';
  sensor: Stack['sensor'];
  sceneId?: string;
  acquired?: string;
}

export function featureVector(s: Stack, p: number, names: FeatureName[]): number[] {
  return names.map((k) => {
    const v = s.data[k]?.[p];
    return v != null && Number.isFinite(v) ? v : NaN;
  });
}

/** Model confidence → level. Vote share is not accuracy; thresholds are deliberately strict. */
export function levelFromVotes(p: number, margin: number): Conf {
  if (p >= 0.7 && margin >= 0.4) return Conf.High;
  if (p >= 0.5 && margin >= 0.2) return Conf.Medium;
  if (p >= 0.4 && margin >= 0.1) return Conf.Low;
  return Conf.Unknown;
}

export function classifyStack(
  s: Stack,
  opts: { method?: Method; model?: Forest | null; profile?: OpticalProfile | SarProfile; worldCover?: Float32Array | null; mask?: Uint8Array; refine?: RefineOptions } = {},
): LandCover {
  completeStack(s);
  const n = s.width * s.height;
  const cls = new Uint8Array(n), level = new Uint8Array(n), score = new Float32Array(n);
  const model = opts.method === 'model' ? opts.model : null;
  if (opts.method === 'model' && !model) throw new Error('No trained model selected');
  if (model && model.meta.sensor !== s.sensor) throw new Error(`Model was trained for ${model.meta.sensor}, scene is ${s.sensor}`);
  for (let p = 0; p < n; p++) {
    if (opts.mask && !opts.mask[p]) continue;
    const q = s.qa[p] as QA;
    if (model) {
      const qc = qaClass(q);
      if (qc != null) { cls[p] = qc; level[p] = Conf.Unknown; continue; }
      const x = featureVector(s, p, model.meta.features);
      if (x.every((v) => Number.isNaN(v))) { cls[p] = LC.Unknown; continue; }
      const r = predict(model, x);
      let lv = levelFromVotes(r.p, r.margin);
      if (q === QA.Dark) lv = Math.max(Conf.Unknown, lv - 1) as Conf;
      // the model may only output a surface class; cloud labels from training are left to QA
      cls[p] = lv === Conf.Unknown ? LC.Unknown : r.cls;
      level[p] = lv;
      score[p] = r.p;
      continue;
    }
    const ctx: PixelContext = opts.worldCover ? { worldCover: opts.worldCover[p] } : {};
    const r = classifyPixel(s.sensor, pixelFeatures(s, p), q, ctx, false, opts.profile);
    cls[p] = r.cls;
    level[p] = r.level;
    score[p] = r.score;
  }
  const refined = refine({ width: s.width, height: s.height, cls, level }, opts.refine ?? REFINE_DEFAULT);
  return {
    width: s.width,
    height: s.height,
    method: model ? 'model' : 'rules',
    methodLabel: model ? `Random Forest “${model.meta.name}” (${model.trees.length} trees, ${model.meta.features.length} features)` : `Rule-based multi-index (${s.sensor === 's1' ? 'Sentinel-1 VV/VH' : s.sensor === 'landsat' ? 'Landsat profile' : 'Sentinel-2 profile'})`,
    cls,
    level,
    score,
    qa: s.qa,
    refined,
    status: model?.meta.validation ? 'validated-on-samples' : 'provisional',
    sensor: s.sensor,
    sceneId: s.sceneId,
    acquired: s.acquired,
  };
}

export interface Summary {
  aoiKm2: number;
  perClassKm2: Record<number, number>;
  perLevelKm2: Record<number, number>;
  /** surface classes (water … wetland) */
  classifiedKm2: number;
  unknownKm2: number;
  cloudShadowKm2: number;
  /** QA-failed (no data, cloud, shadow, saturated, snow, haze) */
  invalidKm2: number;
  lowConfidencePixels: number;
  pixels: number;
  qaKm2: Record<number, number>;
}

/** Area per class from `cls`/`level` (raw or refined) over the AOI mask, using per-row pixel areas. */
export function summarize(cls: Uint8Array, level: Uint8Array, qa: Uint8Array, width: number, mask: Uint8Array, rowArea: Float64Array): Summary {
  const s: Summary = { aoiKm2: 0, perClassKm2: {}, perLevelKm2: {}, classifiedKm2: 0, unknownKm2: 0, cloudShadowKm2: 0, invalidKm2: 0, lowConfidencePixels: 0, pixels: 0, qaKm2: {} };
  for (const c of LC_CLASSES) s.perClassKm2[c] = 0;
  for (let p = 0; p < cls.length; p++) {
    if (!mask[p]) continue;
    const a = rowArea[Math.floor(p / width)];
    s.aoiKm2 += a;
    s.pixels++;
    const c = cls[p];
    s.perClassKm2[c] = (s.perClassKm2[c] ?? 0) + a;
    s.perLevelKm2[level[p]] = (s.perLevelKm2[level[p]] ?? 0) + a;
    s.qaKm2[qa[p]] = (s.qaKm2[qa[p]] ?? 0) + a;
    if (!qaValid(qa[p])) s.invalidKm2 += a;
    if (c === LC.Cloud || c === LC.CloudShadow) s.cloudShadowKm2 += a;
    else if (c === LC.Unknown || c === LC.None) s.unknownKm2 += a;
    else {
      s.classifiedKm2 += a;
      if (level[p] === Conf.Low) s.lowConfidencePixels++;
    }
  }
  return s;
}
