// Rule-based PROVISIONAL land-cover classification with multi-index verification.
//
// No single index decides a class. Each class has a set of independent criteria drawn from several
// bands and indices; the class whose criteria agree best wins, but only if
//   • its key physical criterion holds (e.g. water must be bright in green relative to SWIR and dark in SWIR),
//   • enough criteria agree (≥ minScore), and
//   • it beats the runner-up by a clear margin — otherwise the pixel is Low confidence or Unknown.
// Pixels that fail quality control are never given a surface class.
//
// Thresholds are starting values from the literature (McFeeters 1996; Xu 2006; Feyisa et al. 2014;
// Huete et al. 2002; Zha et al. 2003) set per sensor in a profile, so they can be tuned for a region.
// This is NOT a validated classifier: results are labelled "provisional" until checked against reference data.
import { Conf, LC, QA, type PixelFeatures, type PixelResult, type Sensor } from './types';

export interface OpticalProfile {
  sensor: 's2' | 'landsat';
  water: { mndwi: number; ndwi: number; awei: number; ndviMax: number; nirMax: number; swir1Max: number };
  veg: { ndvi: number; evi: number; savi: number; nirMin: number; ndre: number };
  dense: { ndvi: number; evi: number; ndre: number };
  bare: { bsi: number; ndviMax: number; swir1Min: number; vslopeMin: number };
  built: { ndbi: number; ndviMax: number; bsiMax: number; vslopeMax: number; swir1Min: number };
  wetland: { ndviMin: number; ndviMax: number; mndwiMin: number; nirMax: number; swir1Max: number };
  minScore: number;
}

export interface SarProfile {
  sensor: 's1';
  vvWater: number;
  vhWater: number;
  vvBuilt: number;
  vhVeg: number;
}

export const PROFILE_S2: OpticalProfile = {
  sensor: 's2',
  water: { mndwi: 0, ndwi: 0, awei: 0, ndviMax: 0.15, nirMax: 0.15, swir1Max: 0.1 },
  veg: { ndvi: 0.3, evi: 0.2, savi: 0.2, nirMin: 0.15, ndre: 0.2 },
  dense: { ndvi: 0.7, evi: 0.45, ndre: 0.35 },
  bare: { bsi: 0.1, ndviMax: 0.25, swir1Min: 0.2, vslopeMin: 0.2 },
  built: { ndbi: 0, ndviMax: 0.3, bsiMax: 0.2, vslopeMax: 0.2, swir1Min: 0.12 },
  wetland: { ndviMin: 0.1, ndviMax: 0.5, mndwiMin: -0.15, nirMax: 0.25, swir1Max: 0.12 },
  minScore: 0.65,
};

/** Landsat OLI: same physics, slightly different band centres (NIR 865 nm, no red edge). */
export const PROFILE_LANDSAT: OpticalProfile = {
  ...PROFILE_S2,
  sensor: 'landsat',
  water: { ...PROFILE_S2.water, nirMax: 0.14 },
  veg: { ...PROFILE_S2.veg, ndre: NaN },
  dense: { ...PROFILE_S2.dense, ndre: NaN },
};

/** Sentinel-1 RTC (dB). Calm open water ≲ −18 dB VV; built-up double bounce ≳ −6 dB VV; vegetation volume scattering raises VH. */
export const PROFILE_S1: SarProfile = { sensor: 's1', vvWater: -18, vhWater: -24, vvBuilt: -6, vhVeg: -17 };

export function profileFor(sensor: Sensor): OpticalProfile | SarProfile {
  return sensor === 's1' ? PROFILE_S1 : sensor === 'landsat' ? PROFILE_LANDSAT : PROFILE_S2;
}

/** Optional context for one pixel. worldCover = ESA WorldCover 2021 class code (10 tree, 40 cropland, 50 built-up, 80 water, 90 wetland, 95 mangrove). */
export interface PixelContext {
  worldCover?: number;
}

const fin = (v: number | undefined): v is number => v != null && Number.isFinite(v);
/** Share of the available criteria that hold; fewer than 3 available criteria is not evidence. */
const share = (c: (boolean | null)[], minUsed = 3) => {
  const used = c.filter((x) => x !== null) as boolean[];
  return used.length >= minUsed ? used.filter(Boolean).length / used.length : 0;
};
const lower = (l: Conf): Conf => (l === Conf.High ? Conf.Medium : l === Conf.Medium ? Conf.Low : l);
const raise = (l: Conf): Conf => (l === Conf.Low ? Conf.Medium : l === Conf.Medium ? Conf.High : l);

/** Visible-spectrum slope (red vs blue): soils redden with iron oxides; concrete/asphalt are flatter. */
export const visibleSlope = (f: PixelFeatures) => (fin(f.red) && fin(f.blue) && f.red + f.blue > 0 ? (f.red - f.blue) / (f.red + f.blue) : NaN);

export interface Evidence {
  water: number;
  veg: number;
  bare: number;
  built: number;
  /** key-criterion guards (a class cannot win without them) */
  guard: { water: boolean; veg: boolean; bare: boolean; built: boolean };
}

/** Score every class from independent criteria (each criterion is skipped when its input is missing). */
export function opticalEvidence(f: PixelFeatures, p: OpticalProfile): Evidence {
  const gt = (v: number | undefined, t: number) => (fin(v) && Number.isFinite(t) ? v > t : null);
  const lt = (v: number | undefined, t: number) => (fin(v) && Number.isFinite(t) ? v < t : null);
  const vs = visibleSlope(f);
  const water = share([gt(f.mndwi, p.water.mndwi), gt(f.ndwi, p.water.ndwi), gt(f.awei, p.water.awei), lt(f.ndvi, p.water.ndviMax), lt(f.nir, p.water.nirMax), lt(f.swir1, p.water.swir1Max)]);
  const veg = share([gt(f.ndvi, p.veg.ndvi), gt(f.evi, p.veg.evi), gt(f.savi, p.veg.savi), gt(f.nir, p.veg.nirMin), lt(f.mndwi, 0), gt(f.ndre, p.veg.ndre)]);
  const bare = share([gt(f.bsi, p.bare.bsi), lt(f.ndvi, p.bare.ndviMax), gt(f.swir1, p.bare.swir1Min), lt(f.mndwi, 0), gt(vs, p.bare.vslopeMin)]);
  const built = share([gt(f.ndbi, p.built.ndbi), lt(f.ndvi, p.built.ndviMax), lt(f.mndwi, 0), lt(f.bsi, p.built.bsiMax), lt(vs, p.built.vslopeMax), gt(f.swir1, p.built.swir1Min)]);
  return {
    water,
    veg,
    bare,
    built,
    guard: {
      // water: brighter in green than SWIR1 AND dark in SWIR1 — rules out most shadows, built-up and wet soil
      water: !!gt(f.mndwi, p.water.mndwi) && lt(f.swir1, p.water.swir1Max) !== false,
      veg: !!gt(f.ndvi, p.veg.ndvi),
      bare: !!lt(f.ndvi, p.bare.ndviMax) && lt(f.mndwi, 0) !== false,
      built: !!gt(f.ndbi, p.built.ndbi) && !!lt(f.ndvi, p.built.ndviMax),
    },
  };
}

const QA_TO_CLASS: Partial<Record<QA, LC>> = {
  [QA.Cloud]: LC.Cloud,
  [QA.Cirrus]: LC.Cloud,
  [QA.CloudEdge]: LC.Cloud,
  [QA.CloudShadow]: LC.CloudShadow,
};

/** Class for a pixel that failed QC (never a surface class). */
export function qaClass(q: QA): LC | null {
  if (q === QA.Clear || q === QA.ClearWaterHint || q === QA.Dark || q === QA.LowSignal) return null;
  return QA_TO_CLASS[q] ?? LC.Unknown;
}

/** Classify one optical pixel. */
export function classifyOptical(f: PixelFeatures, q: QA, p: OpticalProfile, ctx: PixelContext = {}, explain = false): PixelResult {
  const why: string[] | undefined = explain ? [] : undefined;
  const qc = qaClass(q);
  if (qc != null) {
    why?.push(`qa:${QA[q]}`);
    return { cls: qc, level: Conf.Unknown, score: 0, why };
  }
  const ev = opticalEvidence(f, p);
  const cand: [LC, number, boolean][] = [
    [LC.Water, ev.water, ev.guard.water],
    [LC.Vegetation, ev.veg, ev.guard.veg],
    [LC.BareSoil, ev.bare, ev.guard.bare],
    [LC.BuiltUp, ev.built, ev.guard.built],
  ];
  const ranked = [...cand].sort((a, b) => b[1] - a[1]);
  const eligible = ranked.filter((c) => c[2] && c[1] >= p.minScore);
  why?.push(`scores:w${ev.water.toFixed(2)} v${ev.veg.toFixed(2)} b${ev.bare.toFixed(2)} u${ev.built.toFixed(2)}`);

  // wetland / mixed water–vegetation: neither clean water nor clean vegetation, but wet and green
  const wetlandLike =
    fin(f.ndvi) && f.ndvi >= p.wetland.ndviMin && f.ndvi <= p.wetland.ndviMax &&
    fin(f.mndwi) && f.mndwi > p.wetland.mndwiMin &&
    (!fin(f.nir) || f.nir < p.wetland.nirMax) && (!fin(f.swir1) || f.swir1 < p.wetland.swir1Max);

  if (!eligible.length) {
    if (wetlandLike) {
      const ctxWet = ctx.worldCover === 90 || ctx.worldCover === 95 || q === QA.ClearWaterHint;
      why?.push('mixed water/vegetation');
      return { cls: LC.Wetland, level: ctxWet ? Conf.Medium : Conf.Low, score: 0.5, why };
    }
    why?.push('no class has enough agreeing evidence');
    return { cls: LC.Unknown, level: Conf.Unknown, score: ranked[0][1] * 0.5, why };
  }

  const [cls0, s1] = eligible[0];
  // runner-up: best other class regardless of guard (a strong but guard-failing class still signals conflict)
  const s2 = Math.max(...ranked.filter((c) => c[0] !== cls0).map((c) => (c[2] ? c[1] : c[1] * 0.75)));
  const margin = s1 - s2;
  let cls: LC = cls0;
  let level: Conf;
  if (margin < 0.05) {
    // two classes explain the pixel equally well → do not guess
    if (wetlandLike && (cls0 === LC.Water || cls0 === LC.Vegetation)) {
      why?.push('water/vegetation conflict → wetland');
      return { cls: LC.Wetland, level: Conf.Low, score: 0.45, why };
    }
    if (ctx.worldCover === 50 && (cls0 === LC.BareSoil || cls0 === LC.BuiltUp)) {
      why?.push('built/bare conflict resolved by ESA WorldCover built-up');
      return { cls: LC.BuiltUp, level: Conf.Low, score: 0.45, why };
    }
    why?.push(`conflict: margin ${margin.toFixed(2)}`);
    return { cls: LC.Unknown, level: Conf.Unknown, score: s1 * 0.5, why };
  }
  level = s1 >= 0.83 && margin >= 0.3 ? Conf.High : margin >= 0.15 ? Conf.Medium : Conf.Low;

  // dense vegetation: vegetation with saturated greenness
  if (cls === LC.Vegetation && fin(f.ndvi) && f.ndvi > p.dense.ndvi && fin(f.evi) && f.evi > p.dense.evi && (!fin(f.ndre) || !Number.isFinite(p.dense.ndre) || f.ndre > p.dense.ndre))
    cls = LC.DenseVegetation;

  // quality flags
  if (q === QA.Dark) {
    // dark area / terrain shadow: shadows mimic water — never better than Low for water
    level = cls === LC.Water ? Conf.Low : lower(level);
    why?.push('dark area (possible terrain shadow)');
  }
  if (q === QA.ClearWaterHint) {
    if (cls === LC.Water) level = raise(level);
    else if (ev.water >= 0.5) level = lower(level);
    why?.push('producer mask says water');
  }

  // context: cropland vs natural vegetation cannot be told apart from one date of spectra
  if (ctx.worldCover === 40 && (cls === LC.Vegetation || cls === LC.DenseVegetation || cls === LC.BareSoil)) {
    cls = LC.Agriculture;
    level = Math.min(level, Conf.Medium) as Conf;
    why?.push('context: ESA WorldCover 2021 cropland');
  }
  if (ctx.worldCover === 50 && cls === LC.BareSoil && margin < 0.25) {
    cls = LC.BuiltUp;
    level = Conf.Low;
    why?.push('context: ESA WorldCover 2021 built-up');
  }

  const score = Math.max(0, Math.min(1, s1 * (0.5 + 0.5 * Math.min(1, margin / 0.5))));
  return { cls, level, score, why };
}

/** Classify one Sentinel-1 pixel. Radar separates water and strong scatterers well; other classes stay Unknown or Low. */
export function classifySar(f: PixelFeatures, q: QA, p: SarProfile = PROFILE_S1, explain = false): PixelResult {
  const why: string[] | undefined = explain ? [] : undefined;
  if (q === QA.NoData || !fin(f.vv)) return { cls: LC.Unknown, level: Conf.Unknown, score: 0, why: explain ? ['qa:NoData'] : undefined };
  const vv = f.vv, vh = fin(f.vh) ? f.vh : NaN;
  if (vv < p.vvWater) {
    const vhAgrees = Number.isFinite(vh) && vh < p.vhWater;
    let level = vhAgrees ? (vv < p.vvWater - 2 ? Conf.High : Conf.Medium) : Conf.Low;
    if (q === QA.LowSignal) {
      // at the noise floor: calm water, radar shadow behind slopes, or noise — cannot be told apart from backscatter alone
      level = Conf.Low;
      why?.push('signal at noise floor (water, radar shadow or noise)');
    }
    why?.push(`VV ${vv.toFixed(1)} dB < ${p.vvWater}`);
    return { cls: LC.Water, level, score: vhAgrees ? 0.8 : 0.5, why };
  }
  if (vv > p.vvBuilt) {
    why?.push(`VV ${vv.toFixed(1)} dB > ${p.vvBuilt} (strong scatterer)`);
    return { cls: LC.BuiltUp, level: Conf.Low, score: 0.5, why };
  }
  if (Number.isFinite(vh) && vh > p.vhVeg) {
    why?.push(`VH ${vh.toFixed(1)} dB > ${p.vhVeg} (volume scattering)`);
    return { cls: LC.Vegetation, level: Conf.Low, score: 0.45, why };
  }
  why?.push('radar cannot separate this surface reliably');
  return { cls: LC.Unknown, level: Conf.Unknown, score: 0.2, why };
}

export function classifyPixel(sensor: Sensor, f: PixelFeatures, q: QA, ctx: PixelContext = {}, explain = false, profile?: OpticalProfile | SarProfile): PixelResult {
  const p = profile ?? profileFor(sensor);
  return sensor === 's1' ? classifySar(f, q, p as SarProfile, explain) : classifyOptical(f, q, p as OpticalProfile, ctx, explain);
}
