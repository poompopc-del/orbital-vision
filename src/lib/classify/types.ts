// Shared types for land-cover classification, quality assessment and validation.
//
// Design rules (see docs in README "Classification"):
//  • a pixel that fails quality control is never given a normal surface class;
//  • a pixel is only classified when several independent pieces of evidence agree — otherwise it is Unknown;
//  • confidence is the agreement of the evidence (or the model's vote share), NEVER accuracy;
//  • accuracy is reported only from reference samples that were kept apart from training.

/** Land-cover classes. Ids are stable (stored in saved models and exports). */
export enum LC {
  None = 0, // outside AOI
  Water = 1,
  Vegetation = 2,
  DenseVegetation = 3,
  Agriculture = 4,
  BareSoil = 5,
  BuiltUp = 6,
  Wetland = 7,
  Cloud = 8,
  CloudShadow = 9,
  Unknown = 10,
}

export const LC_CLASSES: LC[] = [LC.Water, LC.Vegetation, LC.DenseVegetation, LC.Agriculture, LC.BareSoil, LC.BuiltUp, LC.Wetland, LC.Cloud, LC.CloudShadow, LC.Unknown];

/** Surface classes a classifier may assign (cloud / shadow / unknown come from QA and evidence rules). */
export const SURFACE_CLASSES: LC[] = [LC.Water, LC.Vegetation, LC.DenseVegetation, LC.Agriculture, LC.BareSoil, LC.BuiltUp, LC.Wetland];

export const LC_INFO: Record<LC, { en: string; th: string; rgba: [number, number, number, number]; hatch?: boolean }> = {
  [LC.None]: { en: 'Outside AOI', th: 'นอกพื้นที่', rgba: [0, 0, 0, 0] },
  [LC.Water]: { en: 'Open water', th: 'แหล่งน้ำเปิด', rgba: [38, 120, 214, 235] },
  [LC.Vegetation]: { en: 'Vegetation', th: 'พืชพรรณ', rgba: [120, 190, 90, 225] },
  [LC.DenseVegetation]: { en: 'Dense vegetation', th: 'พืชพรรณหนาแน่น', rgba: [32, 112, 56, 230] },
  [LC.Agriculture]: { en: 'Agricultural land', th: 'พื้นที่เกษตร', rgba: [214, 196, 92, 225] },
  [LC.BareSoil]: { en: 'Bare soil', th: 'ดินเปล่า', rgba: [176, 124, 82, 225] },
  [LC.BuiltUp]: { en: 'Built-up area', th: 'สิ่งปลูกสร้าง', rgba: [222, 84, 84, 230] },
  [LC.Wetland]: { en: 'Wetland', th: 'พื้นที่ชุ่มน้ำ', rgba: [64, 186, 170, 230] },
  [LC.Cloud]: { en: 'Cloud', th: 'เมฆ', rgba: [235, 238, 240, 200], hatch: true },
  [LC.CloudShadow]: { en: 'Cloud shadow', th: 'เงาเมฆ', rgba: [90, 96, 120, 200], hatch: true },
  [LC.Unknown]: { en: 'Unknown / unclassified', th: 'ระบุไม่ได้ / ไม่จำแนก', rgba: [150, 150, 150, 150], hatch: true },
};

/** Confidence levels. Stored as 0..3 in Uint8 rasters. */
export enum Conf {
  Unknown = 0,
  Low = 1,
  Medium = 2,
  High = 3,
}

export const CONF_INFO: Record<Conf, { en: string; th: string; rgba: [number, number, number, number] }> = {
  [Conf.Unknown]: { en: 'Unknown', th: 'ไม่ทราบ', rgba: [120, 120, 120, 170] },
  [Conf.Low]: { en: 'Low confidence', th: 'ความเชื่อมั่นต่ำ', rgba: [232, 96, 76, 210] },
  [Conf.Medium]: { en: 'Medium confidence', th: 'ความเชื่อมั่นปานกลาง', rgba: [230, 178, 74, 210] },
  [Conf.High]: { en: 'High confidence', th: 'ความเชื่อมั่นสูง', rgba: [56, 196, 180, 210] },
};

export type Sensor = 's2' | 'landsat' | 's1';

/** Per-pixel quality codes (Uint8). 0 is also used for "outside the scene". */
export enum QA {
  NoData = 0,
  Saturated = 1,
  Cloud = 2,
  Cirrus = 3,
  CloudShadow = 4,
  CloudEdge = 5, // dilated cloud / cloud edge / haze around cloud
  Snow = 6,
  Dark = 7, // S2 SCL 2 "dark area" — often terrain shadow; usable but suspicious for water
  Unclassified = 8, // S2 SCL 7 — mostly thin cloud / haze; not used
  Clear = 9,
  ClearWaterHint = 10, // clear, and the producer's own mask says water (S2 SCL 6 / Landsat QA water bit)
  LowSignal = 11, // SAR: backscatter at the noise floor (radar shadow, noise or very smooth water)
}

export const QA_INFO: Record<QA, { en: string; th: string; valid: boolean; rgba: [number, number, number, number] }> = {
  [QA.NoData]: { en: 'No data', th: 'ไม่มีข้อมูล', valid: false, rgba: [60, 60, 60, 180] },
  [QA.Saturated]: { en: 'Saturated / defective', th: 'ค่าอิ่มตัว / พิกเซลเสีย', valid: false, rgba: [255, 0, 255, 200] },
  [QA.Cloud]: { en: 'Cloud', th: 'เมฆ', valid: false, rgba: [240, 240, 240, 210] },
  [QA.Cirrus]: { en: 'Cirrus', th: 'เมฆซีร์รัส', valid: false, rgba: [190, 220, 255, 200] },
  [QA.CloudShadow]: { en: 'Cloud shadow', th: 'เงาเมฆ', valid: false, rgba: [70, 70, 110, 210] },
  [QA.CloudEdge]: { en: 'Cloud edge / haze', th: 'ขอบเมฆ / หมอกควัน', valid: false, rgba: [200, 200, 200, 160] },
  [QA.Snow]: { en: 'Snow / ice', th: 'หิมะ / น้ำแข็ง', valid: false, rgba: [210, 250, 255, 200] },
  [QA.Dark]: { en: 'Dark area (possible terrain shadow)', th: 'พื้นที่มืด (อาจเป็นเงาภูเขา)', valid: true, rgba: [110, 80, 140, 170] },
  [QA.Unclassified]: { en: 'Unclassified by producer (haze / thin cloud)', th: 'ผู้ผลิตภาพจำแนกไม่ได้ (หมอก / เมฆบาง)', valid: false, rgba: [180, 180, 150, 170] },
  [QA.Clear]: { en: 'Clear', th: 'ใช้ได้', valid: true, rgba: [0, 0, 0, 0] },
  [QA.ClearWaterHint]: { en: 'Clear (producer mask: water)', th: 'ใช้ได้ (หน้ากากผู้ผลิตระบุว่าเป็นน้ำ)', valid: true, rgba: [0, 0, 0, 0] },
  [QA.LowSignal]: { en: 'Radar signal at noise floor', th: 'สัญญาณเรดาร์ต่ำระดับสัญญาณรบกวน', valid: true, rgba: [130, 60, 160, 170] },
};

export const qaValid = (q: number) => QA_INFO[q as QA]?.valid ?? false;

/** Feature vector for one pixel. Optical reflectance is surface reflectance 0–1; SAR in dB. */
export interface PixelFeatures {
  blue?: number;
  green?: number;
  red?: number;
  nir?: number;
  swir1?: number;
  swir2?: number;
  ndvi?: number;
  evi?: number;
  savi?: number;
  ndre?: number;
  ndwi?: number;
  mndwi?: number;
  awei?: number; // AWEI no-shadow
  aweish?: number; // AWEI shadow variant
  ndbi?: number;
  bsi?: number;
  vv?: number;
  vh?: number;
  vvvh?: number; // VV − VH in dB (= VV/VH ratio in linear)
}

export type FeatureName = keyof PixelFeatures;

export const OPTICAL_FEATURES: FeatureName[] = ['blue', 'green', 'red', 'nir', 'swir1', 'swir2', 'ndvi', 'evi', 'savi', 'ndwi', 'mndwi', 'awei', 'aweish', 'ndbi', 'bsi'];
export const S2_EXTRA_FEATURES: FeatureName[] = ['ndre'];
export const SAR_FEATURES: FeatureName[] = ['vv', 'vh', 'vvvh'];

export function featuresFor(sensor: Sensor): FeatureName[] {
  if (sensor === 's1') return SAR_FEATURES;
  return sensor === 's2' ? [...OPTICAL_FEATURES, ...S2_EXTRA_FEATURES] : OPTICAL_FEATURES;
}

/** Result of classifying one pixel. */
export interface PixelResult {
  cls: LC;
  level: Conf;
  /** 0–1 agreement of the evidence (rules) or vote share (model). Not accuracy. */
  score: number;
  /** short machine codes explaining the decision (only filled when explain=true) */
  why?: string[];
}
