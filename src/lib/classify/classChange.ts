// Change detection from two land-cover maps — kept separate from classification itself.
// A pixel is only reported as changed when BOTH dates are QC-passed, classified (not Unknown) and at least
// Medium confidence; otherwise it is "uncertain change" or not checkable. When the dates fall in different
// seasons, changes that agriculture or seasonal water can explain are downgraded to uncertain.
import { Conf, LC, qaValid } from './types';
import type { LandCover } from './run';

export enum CC {
  NoChange = 1,
  VegLoss = 2,
  VegGain = 3,
  PossibleFlood = 4, // new water
  WaterLoss = 5,
  BuiltGain = 6,
  BareGain = 7,
  Uncertain = 8,
  NotCheckable = 255,
}

export const CC_INFO: Record<CC, { en: string; th: string; rgba: [number, number, number, number]; hatch?: boolean }> = {
  [CC.NoChange]: { en: 'No class change', th: 'ประเภทไม่เปลี่ยน', rgba: [0, 0, 0, 0] },
  [CC.VegLoss]: { en: 'Vegetation change: loss', th: 'พืชพรรณลดลง', rgba: [226, 88, 64, 225] },
  [CC.VegGain]: { en: 'Vegetation change: gain', th: 'พืชพรรณเพิ่มขึ้น', rgba: [88, 196, 104, 225] },
  [CC.PossibleFlood]: { en: 'Possible flood (new water)', th: 'อาจเป็นน้ำท่วม (น้ำใหม่)', rgba: [40, 140, 240, 235] },
  [CC.WaterLoss]: { en: 'Water change: water gone', th: 'น้ำหายไป', rgba: [232, 180, 76, 225] },
  [CC.BuiltGain]: { en: 'Built-up change: new built-up', th: 'สิ่งปลูกสร้างเพิ่ม', rgba: [200, 70, 160, 230] },
  [CC.BareGain]: { en: 'Bare soil change: new bare soil', th: 'ดินเปล่าเพิ่ม', rgba: [170, 120, 70, 225] },
  [CC.Uncertain]: { en: 'Uncertain change', th: 'การเปลี่ยนแปลงไม่แน่นอน', rgba: [160, 160, 160, 170], hatch: true },
  [CC.NotCheckable]: { en: 'Not checkable (cloud / no data)', th: 'ตรวจไม่ได้ (เมฆ / ไม่มีข้อมูล)', rgba: [110, 110, 110, 140], hatch: true },
};

const isVeg = (c: number) => c === LC.Vegetation || c === LC.DenseVegetation || c === LC.Agriculture || c === LC.Wetland;

export function classChange(a: Pick<LandCover, 'cls' | 'level' | 'qa'>, b: Pick<LandCover, 'cls' | 'level' | 'qa'>, opts: { differentSeason: boolean; mask?: Uint8Array }): Uint8Array {
  const n = a.cls.length;
  const out = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    if (opts.mask && !opts.mask[p]) continue;
    if (!qaValid(a.qa[p]) || !qaValid(b.qa[p])) { out[p] = CC.NotCheckable; continue; }
    const ca = a.cls[p], cb = b.cls[p];
    if (ca === LC.Unknown || cb === LC.Unknown || ca === LC.Cloud || cb === LC.Cloud || ca === LC.CloudShadow || cb === LC.CloudShadow) { out[p] = CC.Uncertain; continue; }
    const same = ca === cb || (isVeg(ca) && isVeg(cb) && ca !== LC.Wetland && cb !== LC.Wetland);
    if (same) { out[p] = CC.NoChange; continue; }
    if (a.level[p] < Conf.Medium || b.level[p] < Conf.Medium) { out[p] = CC.Uncertain; continue; }
    let c: CC;
    if (cb === LC.Water && ca !== LC.Water) c = CC.PossibleFlood;
    else if (ca === LC.Water && cb !== LC.Water) c = CC.WaterLoss;
    else if (cb === LC.BuiltUp) c = CC.BuiltGain;
    else if (isVeg(ca) && !isVeg(cb)) c = cb === LC.BareSoil ? CC.BareGain : CC.VegLoss;
    else if (!isVeg(ca) && isVeg(cb)) c = CC.VegGain;
    else if (cb === LC.BareSoil) c = CC.BareGain;
    else c = CC.Uncertain;
    // seasonal crops and seasonal water explain many changes between seasons
    if (opts.differentSeason && (ca === LC.Agriculture || cb === LC.Agriculture || c === CC.PossibleFlood || c === CC.WaterLoss || c === CC.BareGain)) c = CC.Uncertain;
    out[p] = c;
  }
  return out;
}

export interface Compatibility {
  ok: boolean;
  blocking: string[];
  warnings: string[];
  validShare: number;
}

/** Can two maps be compared? Checks sensor family, resolution, date order, season and valid-pixel share. */
export function compatibility(
  A: { sensor: string; gsdM: number; date: string; collection?: string; geometryKey?: string },
  B: { sensor: string; gsdM: number; date: string; collection?: string; geometryKey?: string },
  validA: number,
  validB: number,
  minValid = 0.6,
  lang: 'en' | 'th' = 'en',
): Compatibility {
  const blocking: string[] = [], warnings: string[] = [];
  const L = (en: string, th: string) => (lang === 'th' ? th : en);
  const fam = (s: string) => (s === 's1' ? 'sar' : 'optical');
  if (fam(A.sensor) !== fam(B.sensor)) blocking.push(L('Radar and optical maps cannot be compared', 'เทียบแผนที่จากเรดาร์กับภาพออปติคัลไม่ได้'));
  else if (A.sensor !== B.sensor) warnings.push(L('Different sensors: band centres and resolution differ — differences may be sensor effects', 'คนละเซนเซอร์: ช่วงคลื่นและความละเอียดต่างกัน ความแตกต่างบางส่วนอาจมาจากเซนเซอร์'));
  if (A.date >= B.date) blocking.push(L('The “before” image must be older than the “after” image', 'ภาพ “ก่อน” ต้องถ่ายก่อนภาพ “หลัง”'));
  if (A.gsdM !== B.gsdM) warnings.push(L(`Different pixel sizes (${A.gsdM} m / ${B.gsdM} m): both are read on one common grid`, `ขนาดพิกเซลต่างกัน (${A.gsdM} ม. / ${B.gsdM} ม.) ระบบอ่านทั้งสองภาพบนกริดเดียวกัน`));
  if (A.geometryKey && B.geometryKey && A.geometryKey !== B.geometryKey) warnings.push(L('Different orbit / tile: viewing geometry and shadows differ; edges may shift (co-registration is not redone)', 'คนละวงโคจร / ไทล์: มุมมองและเงาต่างกัน ขอบวัตถุอาจเลื่อน (ระบบไม่ได้จัดภาพให้ตรงกันใหม่)'));
  const doy = (d: string) => { const x = new Date(d); return (x.getTime() - Date.UTC(x.getUTCFullYear(), 0, 1)) / 864e5; };
  const dd = Math.abs(doy(A.date) - doy(B.date));
  if (Math.min(dd, 365 - dd) > 45) warnings.push(L('Different seasons: crop and seasonal-water changes are reported as uncertain', 'ต่างฤดูกาล: การเปลี่ยนของพืชไร่และน้ำตามฤดูกาลจะแสดงเป็น “ไม่แน่นอน”'));
  const v = Math.min(validA, validB);
  if (v < minValid) blocking.push(L(`Only ${(v * 100).toFixed(0)}% of the area is usable in both images (minimum ${(minValid * 100).toFixed(0)}%)`, `พื้นที่ที่ใช้ได้ในทั้งสองภาพมีเพียง ${(v * 100).toFixed(0)}% (ต้องมีอย่างน้อย ${(minValid * 100).toFixed(0)}%)`));
  return { ok: !blocking.length, blocking, warnings, validShare: v };
}

export const sameSeasonWindow = (a: string, b: string, tol = 45) => {
  const doy = (d: string) => { const x = new Date(d); return (x.getTime() - Date.UTC(x.getUTCFullYear(), 0, 1)) / 864e5; };
  const dd = Math.abs(doy(a) - doy(b));
  return Math.min(dd, 365 - dd) <= tol;
};
