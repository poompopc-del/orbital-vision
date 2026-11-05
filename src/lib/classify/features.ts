// Spectral indices from surface reflectance (0–1). Same formulas as src/lib/spectral.ts (which builds
// the server-side expressions); these are used for per-pixel classification in the browser.
import type { PixelFeatures } from './types';

const nd = (a: number, b: number) => (a + b === 0 ? NaN : (a - b) / (a + b));

export const ndvi = (nir: number, red: number) => nd(nir, red); // Rouse et al. 1974
export const ndwi = (green: number, nir: number) => nd(green, nir); // McFeeters 1996
export const mndwi = (green: number, swir1: number) => nd(green, swir1); // Xu 2006
export const ndbi = (swir1: number, nir: number) => nd(swir1, nir); // Zha et al. 2003
export const ndre = (nirn: number, re1: number) => nd(nirn, re1);
/** EVI, Huete et al. 2002 (needs reflectance 0–1). */
export const evi = (nir: number, red: number, blue: number) => {
  const d = nir + 6 * red - 7.5 * blue + 1;
  return d === 0 ? NaN : (2.5 * (nir - red)) / d;
};
/** SAVI, Huete 1988, L = 0.5. */
export const savi = (nir: number, red: number, L = 0.5) => (nir + red + L === 0 ? NaN : ((nir - red) / (nir + red + L)) * (1 + L));
/** BSI (bare soil index). */
export const bsi = (swir1: number, red: number, nir: number, blue: number) => nd(swir1 + red, nir + blue);
/** AWEI no-shadow, Feyisa et al. 2014. */
export const aweiNsh = (green: number, swir1: number, nir: number, swir2: number) => 4 * (green - swir1) - (0.25 * nir + 2.75 * swir2);
/** AWEI shadow variant, Feyisa et al. 2014 — designed to suppress shadow pixels. */
export const aweiSh = (blue: number, green: number, nir: number, swir1: number, swir2: number) => blue + 2.5 * green - 1.5 * (nir + swir1) - 0.25 * swir2;

/**
 * Fill every derivable index from the reflectance bands present. Indices already present (e.g. read
 * server-side at higher precision) are kept.
 */
export function deriveIndices(f: PixelFeatures): PixelFeatures {
  const o = { ...f };
  const { blue, green, red, nir, swir1, swir2 } = f;
  const has = (...v: (number | undefined)[]) => v.every((x) => x != null && Number.isFinite(x));
  if (o.ndvi == null && has(nir, red)) o.ndvi = ndvi(nir!, red!);
  if (o.ndwi == null && has(green, nir)) o.ndwi = ndwi(green!, nir!);
  if (o.mndwi == null && has(green, swir1)) o.mndwi = mndwi(green!, swir1!);
  if (o.ndbi == null && has(swir1, nir)) o.ndbi = ndbi(swir1!, nir!);
  if (o.evi == null && has(nir, red, blue)) o.evi = evi(nir!, red!, blue!);
  if (o.savi == null && has(nir, red)) o.savi = savi(nir!, red!);
  if (o.bsi == null && has(swir1, red, nir, blue)) o.bsi = bsi(swir1!, red!, nir!, blue!);
  if (o.awei == null && has(green, swir1, nir, swir2)) o.awei = aweiNsh(green!, swir1!, nir!, swir2!);
  if (o.aweish == null && has(blue, green, nir, swir1, swir2)) o.aweish = aweiSh(blue!, green!, nir!, swir1!, swir2!);
  if (o.vvvh == null && has(f.vv, f.vh)) o.vvvh = f.vv! - f.vh!;
  return o;
}

/** Typical surface reflectance signatures (illustrative, from standard spectral libraries) used ONLY in unit tests and docs. */
export const REFERENCE_SIGNATURES = {
  clearWater: { blue: 0.06, green: 0.07, red: 0.05, nir: 0.02, swir1: 0.01, swir2: 0.005 },
  turbidWater: { blue: 0.08, green: 0.11, red: 0.1, nir: 0.05, swir1: 0.02, swir2: 0.01 },
  denseForest: { blue: 0.02, green: 0.05, red: 0.025, nir: 0.38, swir1: 0.17, swir2: 0.07 },
  cropGreen: { blue: 0.04, green: 0.08, red: 0.05, nir: 0.32, swir1: 0.2, swir2: 0.1 },
  sparseVeg: { blue: 0.06, green: 0.09, red: 0.1, nir: 0.24, swir1: 0.25, swir2: 0.17 },
  bareSoil: { blue: 0.1, green: 0.14, red: 0.19, nir: 0.24, swir1: 0.34, swir2: 0.29 },
  urban: { blue: 0.12, green: 0.13, red: 0.14, nir: 0.17, swir1: 0.22, swir2: 0.19 },
  mixedWaterVeg: { blue: 0.04, green: 0.07, red: 0.05, nir: 0.14, swir1: 0.07, swir2: 0.03 },
  cloudShadowOverVeg: { blue: 0.02, green: 0.025, red: 0.015, nir: 0.07, swir1: 0.035, swir2: 0.015 },
  terrainShadowForest: { blue: 0.01, green: 0.02, red: 0.01, nir: 0.09, swir1: 0.04, swir2: 0.015 },
};
