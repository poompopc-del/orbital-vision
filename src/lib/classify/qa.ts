// Per-pixel quality control from each producer's own quality layer.
//
// Sentinel-2 L2A — SCL (Scene Classification Layer, ESA Sen2Cor):
//   0 no data · 1 saturated/defective · 2 dark area / topographic cast shadow · 3 cloud shadow · 4 vegetation ·
//   5 not vegetated · 6 water · 7 unclassified · 8 cloud medium prob. · 9 cloud high prob. · 10 thin cirrus · 11 snow/ice
// Landsat 8/9 Collection 2 L2 — QA_PIXEL bit flags (USGS LSDS-1619):
//   bit 0 fill · 1 dilated cloud · 2 cirrus · 3 cloud · 4 cloud shadow · 5 snow · 6 clear · 7 water
//   QA_RADSAT: any bit set = a band is saturated, or the pixel is dropped / terrain-occluded
// Sentinel-1 RTC: no producer cloud mask (radar sees through cloud). No data = outside swath; very low
//   backscatter in both polarisations is at the instrument noise floor (radar shadow, noise or calm water) and is flagged.
import { QA, type Sensor } from './types';

/** Sentinel-2 SCL value → QA code. */
export function decodeScl(scl: number): QA {
  switch (scl) {
    case 0: return QA.NoData;
    case 1: return QA.Saturated;
    case 2: return QA.Dark;
    case 3: return QA.CloudShadow;
    case 6: return QA.ClearWaterHint;
    case 7: return QA.Unclassified;
    case 8:
    case 9: return QA.Cloud;
    case 10: return QA.Cirrus;
    case 11: return QA.Snow;
    case 4:
    case 5: return QA.Clear;
    default: return QA.NoData;
  }
}

const bit = (v: number, k: number) => Math.floor(v / 2 ** k) % 2 === 1;

/** Landsat C2 QA_PIXEL (+ optional QA_RADSAT) → QA code. Cloud wins over shadow; dilation marks cloud edges. */
export function decodeLandsatQa(qaPixel: number, radsat = 0): QA {
  if (!Number.isFinite(qaPixel) || bit(qaPixel, 0)) return QA.NoData;
  if (radsat > 0) return QA.Saturated;
  if (bit(qaPixel, 3)) return QA.Cloud;
  if (bit(qaPixel, 2)) return QA.Cirrus;
  if (bit(qaPixel, 4)) return QA.CloudShadow;
  if (bit(qaPixel, 1)) return QA.CloudEdge;
  if (bit(qaPixel, 5)) return QA.Snow;
  if (bit(qaPixel, 7)) return QA.ClearWaterHint;
  return QA.Clear;
}

/** Sentinel-1 backscatter (dB) → QA code. Default floor follows the IW-mode noise-equivalent sigma zero (≈ −22 to −26 dB). */
export function decodeSar(vvDb: number, vhDb: number, floor = { vv: -24, vh: -28 }): QA {
  if (!Number.isFinite(vvDb) || !Number.isFinite(vhDb)) return QA.NoData;
  if (vvDb < floor.vv && vhDb < floor.vh) return QA.LowSignal;
  return QA.Clear;
}

// ---------------------------------------------------------------- server-side expressions (TiTiler / numexpr)
// These return the QA code directly so a single 8-bit tile (rescale 0–255) carries the exact code.

/** Sentinel-2 SCL → QA code. SCL 0 is read as no data by the tile server (nodata=0) and arrives transparent. */
export const S2_QA_EXPR =
  'where(SCL==1,1,where(SCL==3,4,where((SCL==8)|(SCL==9),2,where(SCL==10,3,where(SCL==11,6,where(SCL==2,7,where(SCL==7,8,where(SCL==6,10,9))))))))';

const lsBit = (k: number) => `(((qa_pixel/${2 ** k})%2)>=1)`;
/** Landsat QA_PIXEL → QA code (saturation is read separately, see LANDSAT_RADSAT_EXPR). */
export const LANDSAT_QA_EXPR = `where(${lsBit(0)},0,where(${lsBit(3)},2,where(${lsBit(2)},3,where(${lsBit(4)},4,where(${lsBit(1)},5,where(${lsBit(5)},6,where(${lsBit(7)},10,9)))))))`;
/** 2 = saturated / dropped / occluded, 1 = fine. Must be read WITHOUT nodata=0 (0 is the normal value of QA_RADSAT). */
export const LANDSAT_RADSAT_EXPR = 'where(qa_radsat>0,2,1)';

export function qaExpression(sensor: Sensor): string | null {
  return sensor === 's2' ? S2_QA_EXPR : sensor === 'landsat' ? LANDSAT_QA_EXPR : null;
}

// ---------------------------------------------------------------- mask post-processing

const isCloudy = (q: number) => q === QA.Cloud || q === QA.Cirrus;

/**
 * Mark clear pixels within `radius` pixels of cloud as cloud edge (thin cloud and haze rings that the
 * producer masks miss, plus mis-registration of the 20 m SCL against 10 m bands). Returns a new array.
 */
export function dilateCloud(qa: Uint8Array, width: number, height: number, radius = 1): Uint8Array {
  const out = qa.slice();
  if (radius <= 0) return out;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!isCloudy(qa[p])) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const q = yy * width + xx;
          if (out[q] === QA.Clear || out[q] === QA.ClearWaterHint || out[q] === QA.Dark) out[q] = QA.CloudEdge;
        }
      }
    }
  return out;
}

/** Count QA codes over the pixels selected by `mask` (1 = in AOI). */
export function qaBreakdown(qa: Uint8Array, mask?: Uint8Array): Record<number, number> {
  const out: Record<number, number> = {};
  for (let p = 0; p < qa.length; p++) {
    if (mask && !mask[p]) continue;
    out[qa[p]] = (out[qa[p]] ?? 0) + 1;
  }
  return out;
}
