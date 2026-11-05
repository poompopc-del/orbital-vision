// Water and POSSIBLE-flood mapping, kept separate from general land-cover classification.
//
// Optical: water needs agreement of MNDWI, NDWI and AWEI plus NDVI / NIR / SWIR checks (opticalEvidence),
//   on QC-passed pixels only; dark/terrain-shadow pixels are never better than Low.
//   Adaptive mode replaces the fixed MNDWI threshold with Otsu's threshold when the AOI histogram is bimodal.
// Sentinel-1: speckle-filtered VV (and VH when present); adaptive Otsu on VV, clamped to plausible values.
// New water between dates is reported as POSSIBLE flood / potential inundation — never as a confirmed flood.
import { Conf, LC, QA, qaValid } from './types';
import { classifyOptical, classifySar, PROFILE_S1, profileFor, type OpticalProfile, type SarProfile } from './rules';
import { otsu, type OtsuResult } from './otsu';
import { despeckleDb } from './spatial';
import { completeStack, pixelFeatures, type Stack } from './stack';

export const WS = { invalid: 0, water: 1, waterLow: 2, notWater: 3, mixed: 4 } as const;

export interface WaterMap {
  state: Uint8Array;
  method: string;
  threshold: { name: string; value: number; adaptive: OtsuResult | null; used: 'fixed' | 'otsu' };
}

export function waterMap(s: Stack, opts: { adaptive?: boolean; profile?: OpticalProfile | SarProfile; mask?: Uint8Array } = {}): WaterMap {
  completeStack(s);
  const n = s.width * s.height;
  const state = new Uint8Array(n);
  if (s.sensor === 's1') {
    const vv = s.data.vv ? despeckleDb(s.data.vv, s.width, s.height) : new Float32Array(n).fill(NaN);
    const vh = s.data.vh ? despeckleDb(s.data.vh, s.width, s.height) : null;
    let p = { ...((opts.profile as SarProfile) ?? PROFILE_S1) };
    let ad: OtsuResult | null = null;
    if (opts.adaptive) {
      ad = otsu(sel(vv, opts.mask), -30, 0, { clamp: [-24, -12] });
      if (ad.accepted) p = { ...p, vvWater: ad.threshold };
    }
    for (let i = 0; i < n; i++) {
      if (opts.mask && !opts.mask[i]) continue;
      const v = vv[i], h = vh ? vh[i] : NaN;
      if (!Number.isFinite(v)) { state[i] = WS.invalid; continue; }
      const r = classifySar({ vv: v, vh: Number.isFinite(h) ? h : undefined }, s.qa[i] as QA, p);
      state[i] = r.cls === LC.Water ? (r.level >= Conf.Medium ? WS.water : WS.waterLow) : WS.notWater;
    }
    return { state, method: vh ? 'Sentinel-1 VV + VH backscatter (5×5 speckle filter)' : 'Sentinel-1 VV backscatter (5×5 speckle filter)', threshold: { name: 'VV dB', value: p.vvWater, adaptive: ad, used: ad?.accepted ? 'otsu' : 'fixed' } };
  }
  let p = { ...((opts.profile as OpticalProfile) ?? (profileFor(s.sensor) as OpticalProfile)) };
  let ad: OtsuResult | null = null;
  if (opts.adaptive && s.data.mndwi) {
    const vals: number[] = [];
    for (let i = 0; i < n; i++) if ((!opts.mask || opts.mask[i]) && qaValid(s.qa[i]) && s.qa[i] !== QA.Dark) vals.push(s.data.mndwi[i]);
    ad = otsu(vals, -1, 1, { clamp: [-0.2, 0.4] });
    if (ad.accepted) p = { ...p, water: { ...p.water, mndwi: ad.threshold } };
  }
  for (let i = 0; i < n; i++) {
    if (opts.mask && !opts.mask[i]) continue;
    const q = s.qa[i] as QA;
    if (!qaValid(q)) { state[i] = WS.invalid; continue; }
    const r = classifyOptical(pixelFeatures(s, i), q, p);
    state[i] =
      r.cls === LC.Water ? (r.level >= Conf.Medium ? WS.water : WS.waterLow)
      : r.cls === LC.Wetland ? WS.mixed
      : r.cls === LC.Unknown ? WS.mixed
      : WS.notWater;
  }
  return { state, method: 'Multi-index: MNDWI + NDWI + AWEI with NDVI / NIR / SWIR checks, QA-masked', threshold: { name: 'MNDWI', value: p.water.mndwi, adaptive: ad, used: ad?.accepted ? 'otsu' : 'fixed' } };
}

function sel(a: Float32Array, mask?: Uint8Array) {
  if (!mask) return a;
  const o: number[] = [];
  for (let i = 0; i < a.length; i++) if (mask[i]) o.push(a[i]);
  return o;
}

/** Flood classes (255 = no data in the post-event image). */
export const FC = { permanent: 1, possibleFlood: 2, receded: 3, dry: 4, uncertain: 5, nodata: 255 } as const;

/** Combine pre- and post-event water states. Anything not clear-cut becomes Uncertain. */
export function floodPair(pre: Uint8Array, post: Uint8Array): Uint8Array {
  const out = new Uint8Array(post.length);
  for (let i = 0; i < post.length; i++) {
    const a = pre[i], b = post[i];
    if (b === WS.invalid) { out[i] = FC.nodata; continue; }
    if (a === WS.invalid) {
      // cannot tell whether post-event water is new
      out[i] = b === WS.notWater ? FC.dry : FC.uncertain;
      continue;
    }
    if (b === WS.water && a === WS.water) out[i] = FC.permanent;
    else if (b === WS.water && a === WS.notWater) out[i] = FC.possibleFlood;
    else if (b === WS.notWater && a === WS.water) out[i] = FC.receded;
    else if (b === WS.notWater && a !== WS.water) out[i] = FC.dry;
    else out[i] = FC.uncertain; // any Low / mixed state on the side that matters
  }
  return out;
}

/** Single-date water classes: 1 water, 5 uncertain water / mixed, 4 not water, 255 no data. */
export function floodSingle(post: Uint8Array): Uint8Array {
  const out = new Uint8Array(post.length);
  for (let i = 0; i < post.length; i++) {
    const b = post[i];
    out[i] = b === WS.invalid ? FC.nodata : b === WS.water ? FC.permanent : b === WS.notWater ? FC.dry : FC.uncertain;
  }
  return out;
}
