// A raster stack: co-registered feature rasters (same grid) + a QA code raster.
import type { FeatureName, PixelFeatures, Sensor } from './types';
import { deriveIndices } from './features';

export interface Stack {
  sensor: Sensor;
  width: number;
  height: number;
  data: Partial<Record<FeatureName, Float32Array>>;
  qa: Uint8Array;
  /** acquisition date + scene id, carried into results and reports */
  sceneId?: string;
  acquired?: string;
}

/** Feature vector of one pixel (missing / NaN features are omitted). */
export function pixelFeatures(s: Stack, p: number): PixelFeatures {
  const f: PixelFeatures = {};
  for (const k in s.data) {
    const v = s.data[k as FeatureName]![p];
    if (Number.isFinite(v)) f[k as FeatureName] = v;
  }
  return f;
}

/** Add every index derivable from the bands to the stack (in place); indices already present are kept. */
export function completeStack(s: Stack): Stack {
  const n = s.width * s.height;
  const out: Partial<Record<FeatureName, Float32Array>> = { ...s.data };
  const want: FeatureName[] = ['ndvi', 'ndwi', 'mndwi', 'ndbi', 'evi', 'savi', 'bsi', 'awei', 'aweish', 'vvvh'];
  const missing = want.filter((k) => !out[k]);
  if (!missing.length) return s;
  const arrs = Object.fromEntries(missing.map((k) => [k, new Float32Array(n).fill(NaN)])) as Record<FeatureName, Float32Array>;
  let any: Record<string, boolean> = {};
  for (let p = 0; p < n; p++) {
    const f = deriveIndices(pixelFeatures(s, p));
    for (const k of missing) {
      const v = f[k];
      if (v != null && Number.isFinite(v)) {
        arrs[k][p] = v;
        any[k] = true;
      }
    }
  }
  for (const k of missing) if (any[k]) out[k] = arrs[k];
  s.data = out;
  return s;
}
