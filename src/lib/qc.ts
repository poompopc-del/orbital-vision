// Quality control for surveillance comparisons: user thresholds, per-scene checks, fair-comparison
// checks and a quality score built only from criteria that can be checked from the data.
//
// The quality score rates the *comparison* (images and their match). It is kept separate from the
// confidence of the change classification, which also depends on the sensor and method.
import type { ImageryItem } from './stac';

export interface QcSettings {
  /** max cloud of the whole scene (catalogue eo:cloud_cover), % */
  maxSceneCloud: number;
  /** max cloud + cloud shadow inside the AOI (from the per-pixel mask), % */
  maxAoiCloud: number;
  /** min share of the AOI that must be analysable in both images, % */
  minValidPct: number;
  /** coarsest pixel size accepted, m */
  maxGsdM: number;
  /** allow Sentinel-2 ↔ Landsat comparisons (radar ↔ optical is never allowed) */
  allowCrossSensor: boolean;
  /** buffer added around cloud and cloud shadow before comparing, m (cloud edges look like change) */
  cloudBufferM: number;
  /** also mask thin cloud / haze and dark shadow pixels that the scene's own mask misses near clouds */
  thinCloud: boolean;
}

export const QC_DEFAULT: QcSettings = { maxSceneCloud: 20, maxAoiCloud: 20, minValidPct: 90, maxGsdM: 10, allowCrossSensor: false, cloudBufferM: 100, thinCloud: true };
const KEY = 'ov.monitor.qc.v1';
export function loadQc(): QcSettings {
  try {
    return { ...QC_DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return QC_DEFAULT;
  }
}
export function saveQc(q: QcSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(q));
  } catch {
    /* ignore */
  }
}

export type Family = 'optical' | 'sar';
export const familyOf = (it: Pick<ImageryItem, 'collection'>): Family => (String(it.collection).startsWith('sentinel-1') ? 'sar' : 'optical');
export const sensorName = (it: Pick<ImageryItem, 'collection'>) =>
  it.collection === 'sentinel-2-l2a' ? 'Sentinel-2 MSI' : it.collection === 'landsat-c2-l2' ? 'Landsat 8/9 OLI' : String(it.collection).startsWith('sentinel-1') ? 'Sentinel-1 C-SAR' : String(it.collection);

/** Nominal pixel size in metres. */
export function gsdMeters(it: Pick<ImageryItem, 'collection' | 'gsd'>): number {
  const m = String(it.gsd ?? '').match(/(\d+(?:\.\d+)?)/);
  if (m) return +m[1];
  return it.collection === 'landsat-c2-l2' ? 30 : 10;
}

/** Acquisition vs processing vs catalogue dates — never substitute one for another. */
export function sceneDates(it: Pick<ImageryItem, 'datetime' | 'raw'>) {
  const p = it.raw?.properties ?? {};
  return {
    acquired: it.datetime ?? null,
    processed: (p['s2:generation_time'] ?? p['processing:datetime'] ?? null) as string | null,
    ingested: (p.created ?? null) as string | null,
    updated: (p.updated ?? null) as string | null,
  };
}

export interface AoiCloud {
  cloudPct: number;
  shadowPct: number;
  /** AOI share outside the scene footprint or flagged no-data/saturated, % */
  noDataPct: number;
}

export interface SceneCheck {
  ok: boolean;
  /** true when AOI cloud still has to be measured before the scene can pass */
  pending: boolean;
  reasons: string[];
}

/** Check one scene against the thresholds. `aoi` is the measured AOI cloud (optical only). */
export function checkScene(it: Pick<ImageryItem, 'collection' | 'gsd' | 'cloudCover' | 'coveragePct'>, aoi: AoiCloud | null | undefined, qc: QcSettings): SceneCheck {
  const reasons: string[] = [];
  const fam = familyOf(it);
  if (fam === 'optical') {
    if (it.cloudCover == null) reasons.push('ไม่มีค่าเมฆรวมในแคตตาล็อก');
    else if (it.cloudCover > qc.maxSceneCloud) reasons.push(`เมฆรวมทั้งภาพ ${it.cloudCover.toFixed(0)}% เกินเกณฑ์ ${qc.maxSceneCloud}%`);
  }
  if (gsdMeters(it) > qc.maxGsdM) reasons.push(`ความละเอียด ${gsdMeters(it)} ม. หยาบกว่าเกณฑ์ ${qc.maxGsdM} ม.`);
  if (it.coveragePct != null && it.coveragePct < 50) reasons.push(`ภาพครอบคลุม AOI เพียง ${it.coveragePct.toFixed(0)}%`);
  let pending = false;
  if (fam === 'optical') {
    if (aoi == null) pending = true;
    else {
      const obscured = aoi.cloudPct + aoi.shadowPct;
      if (obscured > qc.maxAoiCloud) reasons.push(`เมฆ+เงาเมฆใน AOI ${obscured.toFixed(0)}% เกินเกณฑ์ ${qc.maxAoiCloud}%`);
      if (100 - obscured - aoi.noDataPct < qc.minValidPct) reasons.push(`พื้นที่ใช้ได้ใน AOI ${(100 - obscured - aoi.noDataPct).toFixed(0)}% ต่ำกว่าเกณฑ์ ${qc.minValidPct}%`);
    }
  } else if (it.coveragePct != null && it.coveragePct < qc.minValidPct) {
    reasons.push(`ภาพเรดาร์ครอบคลุม AOI ${it.coveragePct.toFixed(0)}% ต่ำกว่าเกณฑ์ ${qc.minValidPct}%`);
  }
  return { ok: !reasons.length && !pending, pending: !reasons.length && pending, reasons };
}

export interface PairCheck {
  ok: boolean;
  reasons: string[];
  notes: string[];
}

/** Can these two scenes be compared fairly? */
export function checkPair(A: ImageryItem, B: ImageryItem, qc: QcSettings): PairCheck {
  const reasons: string[] = [], notes: string[] = [];
  if (familyOf(A) !== familyOf(B)) reasons.push('เทียบภาพเรดาร์กับภาพปกติ (optical) โดยตรงไม่ได้ วิธีวัดต่างกัน');
  else if (A.collection !== B.collection) {
    if (!qc.allowCrossSensor) reasons.push(`คนละเซนเซอร์ (${sensorName(A)} / ${sensorName(B)}) — เปิด “ยอมให้เทียบข้ามเซนเซอร์” ในเกณฑ์ก่อน`);
    else notes.push(`เทียบข้ามเซนเซอร์ ${sensorName(A)} กับ ${sensorName(B)}: ช่วงคลื่นและความละเอียดต่างกัน ผลอาจคลาดเคลื่อนมากกว่าปกติ`);
  }
  if (A.datetime >= B.datetime) reasons.push('ภาพ “ก่อน” ต้องถ่ายก่อนภาพ “หลัง”');
  const ga = gsdMeters(A), gb = gsdMeters(B);
  if (ga !== gb) notes.push(`ความละเอียดต่างกัน (${ga} ม. / ${gb} ม.) ระบบอ่านทั้งสองภาพบนกริดเดียวกัน`);
  const geom = ['sat:relative_orbit', 'sat:orbit_state', 's2:mgrs_tile', 'landsat:wrs_path', 'landsat:wrs_row'];
  const diff = geom.filter((k) => A.raw?.properties?.[k] != null && B.raw?.properties?.[k] != null && A.raw.properties[k] !== B.raw.properties[k]);
  if (diff.length) notes.push(`เรขาคณิตการถ่ายต่างกัน (${diff.join(', ')}) — มุมมอง/เงาอาจทำให้ดูเหมือนมีการเปลี่ยนแปลง`);
  const gap = Math.abs(new Date(B.datetime).getTime() - new Date(A.datetime).getTime()) / 86400e3;
  if (gap > 45 && !sameSeason(A.datetime, B.datetime)) notes.push(`ห่างกัน ${Math.round(gap)} วัน และต่างฤดูกาล — พืชผล/ระดับน้ำตามฤดูกาลอาจถูกนับเป็นการเปลี่ยนแปลง`);
  return { ok: !reasons.length, reasons, notes };
}

const doy = (iso: string) => {
  const d = new Date(iso);
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400e3);
};
export function sameSeason(a: string, b: string, tolDays = 30) {
  const x = Math.abs(doy(a) - doy(b));
  return Math.min(x, 365 - x) <= tolDays;
}

export interface QualityFactor {
  key: string;
  label: string;
  points: number;
  max: number;
  detail: string;
}
export interface Quality {
  score: number; // 0–100
  grade: 'good' | 'fair' | 'poor';
  factors: QualityFactor[];
}

/**
 * Comparison quality from checkable criteria (total 100):
 *  usable area 40 · AOI cloud 20 · same sensor & geometry 15 · time gap / season 15 · pixel size 10
 */
export function comparisonQuality(inp: {
  validFrac: number;
  aoiCloudA: number | null; // 0–1, null for radar
  aoiCloudB: number | null;
  sameCollection: boolean;
  sameFamily: boolean;
  sameGeometry: boolean;
  gapDays: number;
  sameSeason: boolean;
  gsdA: number;
  gsdB: number;
}): Quality {
  const f: QualityFactor[] = [];
  const v = Math.max(0, Math.min(1, inp.validFrac));
  f.push({ key: 'valid', label: 'พื้นที่ใช้วิเคราะห์ได้', points: 40 * v, max: 40, detail: `${(v * 100).toFixed(0)}% ของ AOI` });
  const cl = inp.aoiCloudA == null && inp.aoiCloudB == null ? 0 : Math.max(inp.aoiCloudA ?? 0, inp.aoiCloudB ?? 0);
  f.push({
    key: 'cloud', label: 'เมฆใน AOI', points: 20 * (1 - Math.min(1, cl)), max: 20,
    detail: inp.aoiCloudA == null && inp.aoiCloudB == null ? 'เรดาร์ ไม่ได้รับผลจากเมฆ' : `สูงสุด ${(cl * 100).toFixed(0)}% ระหว่างสองภาพ`,
  });
  const s = !inp.sameFamily ? 0 : !inp.sameCollection ? 5 : inp.sameGeometry ? 15 : 8;
  f.push({ key: 'sensor', label: 'เซนเซอร์และมุมถ่าย', points: s, max: 15, detail: !inp.sameFamily ? 'คนละประเภทเซนเซอร์' : !inp.sameCollection ? 'คนละเซนเซอร์' : inp.sameGeometry ? 'เซนเซอร์และวงโคจร/ไทล์เดียวกัน' : 'เซนเซอร์เดียวกัน คนละวงโคจร/ไทล์' });
  const g = inp.gapDays;
  const t = g <= 30 ? 15 : g <= 90 ? 10 : inp.sameSeason ? 10 : g <= 365 ? 4 : 0;
  f.push({ key: 'time', label: 'ช่วงห่างและฤดูกาล', points: t, max: 15, detail: `ห่าง ${Math.round(g)} วัน${g > 90 ? (inp.sameSeason ? ' ฤดูกาลเดียวกัน' : ' ต่างฤดูกาล') : ''}` });
  const gs = Math.max(inp.gsdA, inp.gsdB);
  f.push({ key: 'gsd', label: 'ความละเอียดภาพ', points: gs <= 10 ? 10 : gs <= 30 ? 5 : 0, max: 10, detail: `${gs} ม.` });
  const score = Math.round(f.reduce((x, y) => x + y.points, 0));
  return { score, grade: score >= 75 ? 'good' : score >= 50 ? 'fair' : 'poor', factors: f.map((x) => ({ ...x, points: Math.round(x.points * 10) / 10 })) };
}

/** Pick the best passing scene closest to a target date (same collection; prefers the match's geometry). */
export function nearestPassing<T extends ImageryItem>(list: T[], target: string, ok: (x: T) => boolean, match?: ImageryItem | null): T | null {
  const t = new Date(target).getTime();
  const pool = list.filter(ok).filter((x) => !match || x.collection === match.collection);
  if (!pool.length) return null;
  const same = match ? pool.filter((x) => ['sat:relative_orbit', 's2:mgrs_tile', 'landsat:wrs_path'].every((k) => x.raw?.properties?.[k] == null || match.raw?.properties?.[k] == null || x.raw.properties[k] === match.raw.properties[k])) : [];
  const use = same.length ? same : pool;
  return [...use].sort((a, b) => Math.abs(new Date(a.datetime).getTime() - t) - Math.abs(new Date(b.datetime).getTime() - t))[0];
}
