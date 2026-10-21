// AOI change monitoring: a watchlist of areas, each checked against new imagery on a cycle
// (7 / 14 / 30 days). Runs happen in the browser when the user opens the monitoring page and
// presses "run" (no server scheduler yet), and are kept in this browser: metadata in
// localStorage, rendered images in IndexedDB.
//
// Honesty rules built in:
//  • no usable image → status "insufficient", never a made-up result
//  • every number comes from pixels actually read; every run records its scenes and method
//  • confidence is derived from cloud-free coverage, scene geometry and time gap, and is shown
import { classify, cellAreaKm2, cellLonLat, fetchRaster, gridFor, type ClassDef, type Classified, type Raster } from './change';
import { pickBestScene } from './autoscene';
import { aoiStatistics, indexExpression, indexSummary, INDICES, S2_CLEAR_EXPR, sarDbExpression, sensorOf } from './spectral';
import { renderScene } from './export';
import { centroid } from './geo';
import { geometryAreaKm2, fmtArea, type AreaUnit } from './area';
import { checkPair, checkScene, comparisonQuality, familyOf, gsdMeters, loadQc, sameSeason, type AoiCloud, type Quality, type QcSettings } from './qc';
import { searchArchive } from './stac';
import type { ImageryItem, StacCollectionId } from './stac';
const areaKm2 = (g: GeoJSON.Polygon) => geometryAreaKm2(g);

// ---------------------------------------------------------------- types

export type Purpose = 'clearing' | 'construction' | 'water' | 'fire' | 'general';
export type Region = 'TH-KH' | 'TH-MY' | 'TH-MM' | 'TH-LA' | 'TH' | 'OTHER';
/** Which satellite a watch area uses: 'optical' = Sentinel-2 (kept for older saved areas). */
export type SensorMode = 'auto' | 'optical' | 'landsat' | 'optical-any' | 'sar';
export const SATELLITES: { id: SensorMode; th: string; en: string; note: string }[] = [
  { id: 'auto', th: 'อัตโนมัติ (Sentinel-2 → เรดาร์)', en: 'Auto (Sentinel-2 → radar)', note: 'ใช้ Sentinel-2 ก่อน ถ้าเมฆมากเกินเกณฑ์จะใช้เรดาร์ Sentinel-1 แทน (หัวข้อน้ำใช้เรดาร์ก่อน)' },
  { id: 'optical', th: 'Sentinel-2 (10 ม.)', en: 'Sentinel-2 (10 m)', note: 'ภาพปกติ 10 ม. ถ่ายซ้ำราว 5 วัน · ใช้ไม่ได้เมื่อเมฆมาก' },
  { id: 'landsat', th: 'Landsat 8/9 (30 ม.)', en: 'Landsat 8/9 (30 m)', note: 'ภาพปกติ 30 ม. ถ่ายซ้ำราว 8 วัน · หยาบกว่า เห็นการเปลี่ยนแปลงขนาดเล็กได้น้อยกว่า' },
  { id: 'optical-any', th: 'Sentinel-2 หรือ Landsat', en: 'Sentinel-2 or Landsat', note: 'เลือกภาพที่เมฆน้อยที่สุดจากทั้งสองดวง · ภาพก่อน–หลังจะเป็นดาวเทียมเดียวกันเมื่อหาได้' },
  { id: 'sar', th: 'Sentinel-1 เรดาร์ (10 ม.)', en: 'Sentinel-1 radar (10 m)', note: 'ถ่ายทะลุเมฆได้ · ใช้ได้กับหัวข้อถางป่า สิ่งปลูกสร้าง และน้ำ' },
];
export const satelliteOf = (m: SensorMode | undefined) => SATELLITES.find((x) => x.id === m) ?? SATELLITES[0];

export interface MonitorAoi {
  id: string;
  name: string;
  region: Region;
  purpose: Purpose;
  sensor: SensorMode;
  geometry: GeoJSON.Polygon;
  freqDays: number;
  createdAt: string;
  notes?: string;
  active: boolean;
  /** when the box was last moved/resized — results before this used the old box */
  editedAt?: string;
}

export interface SceneMeta {
  id: string;
  collection: string;
  label: string;
  /** acquisition time (never the processing or catalogue time) */
  datetime: string;
  /** whole-scene cloud from the catalogue, % */
  cloud: number | null;
  /** cloud (incl. cirrus) inside the AOI from the per-pixel mask, % */
  aoiCloudPct: number | null;
  /** cloud shadow inside the AOI, % */
  aoiShadowPct?: number | null;
  gsd: string;
  processed?: string | null;
  ingested?: string | null;
}

export interface Hotspot {
  n: number;
  lat: number;
  lon: number;
  /** legacy field (older runs); new runs also carry areaKm2 */
  areaHa: number;
  areaKm2?: number;
  cls: number;
}
export const hotspotKm2 = (h: Hotspot) => h.areaKm2 ?? h.areaHa / 100;

export interface LegendItem {
  id: number;
  label: string;
  labelTh: string;
  color: string;
}

export type Level = 'significant' | 'minor' | 'none';

export interface MonitorRun {
  id: string;
  aoiId: string;
  aoiName: string;
  purpose: Purpose;
  at: string;
  status: 'ok' | 'insufficient' | 'error';
  reason?: string;
  windows: { before: [string, string]; after: [string, string] };
  sensor?: 'optical' | 'sar';
  A?: SceneMeta;
  B?: SceneMeta;
  stats?: {
    aoiKm2: number;
    /** analysable in both images */
    validKm2: number;
    /** cloud + shadow + no data (everything not analysable) */
    noDataKm2: number;
    /** breakdown of the not-analysable part (new runs) */
    cloudKm2?: number;
    shadowKm2?: number;
    missingKm2?: number;
    /** all change classes (pixels counted once) */
    changeKm2?: number;
    /** analysable and below the change thresholds */
    noChangeKm2?: number;
    classKm2: Record<number, number>;
    /** change of interest in patches above the minimum size */
    interestKm2: number;
  };
  legend?: LegendItem[];
  interest?: number[];
  hotspots?: Hotspot[];
  level?: Level;
  confidence?: 'high' | 'medium' | 'low';
  confidenceNotes?: string[];
  method?: string;
  note?: string;
  bounds?: { west: number; south: number; east: number; north: number };
  overlayBounds?: { west: number; south: number; east: number; north: number };
  /** comparison quality (images and their match) — separate from classification confidence */
  quality?: Quality;
  /** thresholds in force for this run */
  qc?: QcSettings;
  /** fair-comparison notes (sensor, geometry, season) */
  pairNotes?: string[];
  /** how the scenes were chosen */
  mode?: 'auto' | 'manual';
  /** other scenes that pass the thresholds (offered when this run could not conclude) */
  suggestions?: { id: string; datetime: string; cloud: number | null; collection: string }[];
}

export const PURPOSES: { id: Purpose; label: string; labelTh: string; hint: string }[] = [
  { id: 'clearing', label: 'Forest clearing / encroachment', labelTh: 'บุกรุก ถางป่า', hint: 'NDVI drop on previously vegetated land (optical) or VH backscatter drop (radar)' },
  { id: 'construction', label: 'New roads / structures / bare ground', labelTh: 'ทำทาง สิ่งปลูกสร้าง ดินเปิดใหม่', hint: 'NDVI down + NDBI up (optical) or strong VV increase (radar)' },
  { id: 'water', label: 'Flood / water extent', labelTh: 'น้ำท่วม / แหล่งน้ำ', hint: 'MNDWI (optical) or low VV backscatter (radar)' },
  { id: 'fire', label: 'Burned area / wildfire', labelTh: 'ไฟป่า / พื้นที่เผาไหม้', hint: 'dNBR (optical only)' },
  { id: 'general', label: 'General vegetation change', labelTh: 'การเปลี่ยนแปลงพืชพรรณทั่วไป', hint: 'NDVI ± 0.2' },
];

export const REGIONS: { id: Region; label: string; labelTh: string }[] = [
  { id: 'TH-KH', label: 'Thailand–Cambodia border', labelTh: 'ชายแดนไทย–กัมพูชา' },
  { id: 'TH-MY', label: 'Thailand–Malaysia border', labelTh: 'ชายแดนไทย–มาเลเซีย' },
  { id: 'TH-MM', label: 'Thailand–Myanmar border', labelTh: 'ชายแดนไทย–เมียนมา' },
  { id: 'TH-LA', label: 'Thailand–Laos border', labelTh: 'ชายแดนไทย–ลาว' },
  { id: 'TH', label: 'Inside Thailand (disaster)', labelTh: 'ในประเทศ (สาธารณภัย)' },
  { id: 'OTHER', label: 'Other', labelTh: 'อื่น ๆ' },
];

// ---------------------------------------------------------------- storage

const AOI_KEY = 'ov.monitor.aois.v1';
const RUN_KEY = 'ov.monitor.runs.v1';

const readJson = <T>(k: string, d: T): T => {
  try {
    const v = JSON.parse(localStorage.getItem(k) || 'null');
    return v ?? d;
  } catch {
    return d;
  }
};
const writeJson = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage full or blocked */
  }
};

export const loadAois = () => readJson<MonitorAoi[]>(AOI_KEY, []);
export const saveAois = (l: MonitorAoi[]) => writeJson(AOI_KEY, l);
export const loadRuns = () => readJson<MonitorRun[]>(RUN_KEY, []);
export const saveRuns = (l: MonitorRun[]) => writeJson(RUN_KEY, l.slice(0, 400));

// images (data URLs) in IndexedDB, keyed "<runId>:before|after|change"
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ov-monitor', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('img');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function putImage(key: string, dataUrl: string) {
  try {
    const db = await idb();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction('img', 'readwrite');
      tx.objectStore('img').put(dataUrl, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    /* images are optional — the run record still stands */
  }
}
export async function getImage(key: string): Promise<string | null> {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const rq = db.transaction('img').objectStore('img').get(key);
      rq.onsuccess = () => res((rq.result as string) ?? null);
      rq.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}
export async function deleteImages(runId: string) {
  try {
    const db = await idb();
    const tx = db.transaction('img', 'readwrite');
    ['before', 'after', 'change'].forEach((k) => tx.objectStore('img').delete(`${runId}:${k}`));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- schedule helpers

export const lastRunOf = (aoiId: string, runs: MonitorRun[]) => runs.find((r) => r.aoiId === aoiId);
export function isDue(a: MonitorAoi, runs: MonitorRun[], now = Date.now()) {
  if (!a.active) return false;
  const l = lastRunOf(a.id, runs);
  return !l || now - new Date(l.at).getTime() >= a.freqDays * 86400e3 - 3600e3;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** After = the last `periodDays`; before = the best reference in the 60 days preceding it. */
export function windowsFor(periodDays: number, end = Date.now()) {
  const aFrom = end - periodDays * 86400e3;
  return { after: [day(aFrom), day(end)] as [string, string], before: [day(aFrom - 61 * 86400e3), day(aFrom - 86400e3)] as [string, string] };
}

// ---------------------------------------------------------------- method per purpose

interface Method {
  sensor: 'optical' | 'sar';
  text: string;
  inputs: (it: ImageryItem) => { expr: string; range: [number, number] }[];
  /** v = [a0, a1, …, b0, b1, …] (same order as inputs, before then after) */
  fn: (a: number[], b: number[]) => number;
  legend: LegendItem[];
  interest: number[];
}

const idx = (id: string) => (it: ImageryItem) => ({ expr: indexExpression(it, INDICES.find((i) => i.id === id)!), range: [-1, 1] as [number, number] });
const sar = (pol: 'vv' | 'vh') => () => ({ expr: sarDbExpression(pol), range: [-30, 5] as [number, number] });
const rgba = (c: string) => c;

function methodFor(p: Purpose, sensor: 'optical' | 'sar'): Method | null {
  if (sensor === 'optical') {
    switch (p) {
      case 'clearing':
        return {
          sensor, text: 'Sentinel-2 NDVI: loss = NDVI(before) ≥ 0.45 and drop ≥ 0.20, only on tree/shrub cover (ESA WorldCover 2021); gain = rise ≥ 0.20 to ≥ 0.45. Cloud/shadow masked with SCL.',
          inputs: (it) => [idx('ndvi')(it)],
          fn: ([a], [b]) => (a >= 0.45 && a - b >= 0.2 ? 1 : b >= 0.45 && b - a >= 0.2 ? 2 : 3),
          legend: [
            { id: 1, label: 'Vegetation loss (possible clearing)', labelTh: 'พืชพรรณหายไป (อาจถูกถาง)', color: rgba('#ef4444') },
            { id: 2, label: 'Vegetation gain', labelTh: 'พืชพรรณเพิ่มขึ้น', color: rgba('#22c55e') },
          ],
          interest: [1],
        };
      case 'construction':
        return {
          sensor, text: 'Sentinel-2: new bare/built surface = NDVI drop ≥ 0.15 and NDBI rise ≥ 0.10, outside cropland and existing built-up (ESA WorldCover 2021). Cloud/shadow masked with SCL.',
          inputs: (it) => [idx('ndvi')(it), idx('ndbi')(it)],
          fn: ([na, ba], [nb, bb]) => (na - nb >= 0.15 && bb - ba >= 0.1 ? 1 : 3),
          legend: [{ id: 1, label: 'New bare / built surface (possible road, clearing or structure)', labelTh: 'ผิวดินเปิด / สิ่งปลูกสร้างใหม่ (อาจเป็นทาง ที่โล่ง หรืออาคาร)', color: '#f97316' }],
          interest: [1],
        };
      case 'water':
        return {
          sensor, text: 'Sentinel-2 MNDWI > 0 = water. New water = dry before, wet after. Cloud/shadow masked with SCL.',
          inputs: (it) => [idx('mndwi')(it)],
          fn: ([a], [b]) => (a <= 0 && b > 0 ? 1 : a > 0 && b <= 0 ? 2 : a > 0 && b > 0 ? 4 : 3),
          legend: [
            { id: 1, label: 'New water (possible flooding)', labelTh: 'น้ำใหม่ (อาจเป็นน้ำท่วม)', color: '#ef4444' },
            { id: 2, label: 'Water receded', labelTh: 'น้ำลดลง', color: '#f5b84b' },
            { id: 4, label: 'Permanent / existing water', labelTh: 'น้ำเดิม', color: '#3b82f6' },
          ],
          interest: [1],
        };
      case 'fire':
        return {
          sensor, text: 'Sentinel-2 dNBR = NBR(before) − NBR(after); ≥ 0.27 moderate–high, 0.10–0.27 low (Key & Benson 2006). Cloud masked.',
          inputs: (it) => [idx('nbr')(it)],
          fn: ([a], [b]) => (a - b >= 0.27 ? 1 : a - b >= 0.1 ? 2 : 3),
          legend: [
            { id: 1, label: 'Burned — moderate to high severity', labelTh: 'เผาไหม้ ระดับปานกลางถึงรุนแรง', color: '#dc2626' },
            { id: 2, label: 'Burned — low severity', labelTh: 'เผาไหม้ ระดับต่ำ', color: '#f5b84b' },
          ],
          interest: [1],
        };
      default:
        return {
          sensor, text: 'Sentinel-2 NDVI change ≥ 0.20 either way. Cloud masked.',
          inputs: (it) => [idx('ndvi')(it)],
          fn: ([a], [b]) => (a - b >= 0.2 ? 1 : b - a >= 0.2 ? 2 : 3),
          legend: [
            { id: 1, label: 'Vegetation decrease', labelTh: 'พืชพรรณลดลง', color: '#ef4444' },
            { id: 2, label: 'Vegetation increase', labelTh: 'พืชพรรณเพิ่มขึ้น', color: '#22c55e' },
          ],
          interest: [1, 2],
        };
    }
  }
  switch (p) {
    case 'clearing':
      return {
        sensor, text: 'Sentinel-1 RTC VH (5×5 speckle filter): possible clearing = VH(before) > −20 dB and drop ≥ 3 dB, only on tree/shrub cover (ESA WorldCover 2021).',
        inputs: () => [sar('vh')()],
        fn: ([a], [b]) => (a > -20 && a - b >= 3 ? 1 : b - a >= 3 ? 2 : 3),
        legend: [
          { id: 1, label: 'Radar VH drop (possible clearing)', labelTh: 'สัญญาณเรดาร์ VH ลดลง (อาจถูกถาง)', color: '#ef4444' },
          { id: 2, label: 'Radar VH increase', labelTh: 'สัญญาณเรดาร์ VH เพิ่มขึ้น', color: '#22c55e' },
        ],
        interest: [1],
      };
    case 'construction':
      return {
        sensor, text: 'Sentinel-1 RTC VV (5×5 speckle filter): new strong scatterers = rise ≥ 4 dB to > −8 dB, outside cropland and existing built-up (ESA WorldCover 2021).',
        inputs: () => [sar('vv')()],
        fn: ([a], [b]) => (b - a >= 4 && b > -8 ? 1 : 3),
        legend: [{ id: 1, label: 'New strong radar return (possible structure)', labelTh: 'สัญญาณเรดาร์สะท้อนแรงขึ้น (อาจเป็นสิ่งปลูกสร้าง)', color: '#f97316' }],
        interest: [1],
      };
    case 'water':
      return {
        sensor, text: 'Sentinel-1 RTC VV (5×5 speckle filter) < −18 dB = open water. New water = dry before, wet after (same relative orbit preferred).',
        inputs: () => [sar('vv')()],
        fn: ([a], [b]) => (a >= -18 && b < -18 ? 1 : a < -18 && b >= -18 ? 2 : a < -18 && b < -18 ? 4 : 3),
        legend: [
          { id: 1, label: 'New water (possible flooding)', labelTh: 'น้ำใหม่ (อาจเป็นน้ำท่วม)', color: '#ef4444' },
          { id: 2, label: 'Water receded', labelTh: 'น้ำลดลง', color: '#f5b84b' },
          { id: 4, label: 'Permanent / existing water', labelTh: 'น้ำเดิม', color: '#3b82f6' },
        ],
        interest: [1],
      };
    default:
      return null; // fire / general: optical only
  }
}

export const methodText = (p: Purpose, s: 'optical' | 'sar') => methodFor(p, s)?.text ?? '';

// ---------------------------------------------------------------- run

const OPT: StacCollectionId = 'sentinel-2-l2a';
const RAD: StacCollectionId = 'sentinel-1-rtc';


// ---- ESA WorldCover 2021 (10 m) land-cover mask, read through the Planetary Computer data API
const WC_ALLOW: Partial<Record<Purpose, number[]>> = { clearing: [10, 20] }; // tree cover, shrubland
const WC_DENY: Partial<Record<Purpose, number[]>> = { construction: [40, 50] }; // cropland, built-up

async function worldCoverItem(aoi: GeoJSON.Polygon, signal?: AbortSignal): Promise<ImageryItem | null> {
  const r = await fetch('https://planetarycomputer.microsoft.com/api/stac/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collections: ['esa-worldcover'], intersects: aoi, limit: 4, sortby: [{ field: 'properties.datetime', direction: 'desc' }] }),
    signal,
  });
  if (!r.ok) return null;
  const feats: any[] = (await r.json()).features ?? [];
  const f = feats.find((x) => String(x.properties?.datetime ?? x.properties?.start_datetime ?? '').startsWith('2021')) ?? feats[0];
  return f ? ({ id: f.id, collection: 'esa-worldcover' } as unknown as ImageryItem) : null;
}

/** Share of the AOI in key ESA WorldCover 2021 classes (km²) — context for impact assessment. */
export async function landCoverShares(aoi: GeoJSON.Polygon, signal?: AbortSignal): Promise<{ label: string; labelTh: string; km2: number }[] | null> {
  const it = await worldCoverItem(aoi, signal).catch(() => null);
  if (!it) return null;
  const total = areaKm2(aoi);
  const classes = [
    { c: 40, label: 'Cropland', labelTh: 'พื้นที่เกษตร' },
    { c: 50, label: 'Built-up', labelTh: 'สิ่งปลูกสร้าง / ชุมชน' },
    { c: 10, label: 'Tree cover', labelTh: 'ป่าไม้' },
    { c: 80, label: 'Permanent water', labelTh: 'แหล่งน้ำถาวร' },
  ];
  const out = [];
  for (const k of classes) {
    // values 2 (class) / 1 (other) avoid the nodata=0 convention; mean − 1 = fraction
    const st = await aoiStatistics(it, `where(map==${k.c},2,1)`, aoi, { signal }).catch(() => null);
    if (st) out.push({ label: k.label, labelTh: k.labelTh, km2: Math.max(0, st.mean - 1) * total });
  }
  return out.length ? out : null;
}

async function landCoverMask(aoi: GeoJSON.Polygon, purpose: Purpose, grid: ReturnType<typeof gridFor>, signal?: AbortSignal): Promise<Float32Array | null> {
  const allow = WC_ALLOW[purpose], deny = WC_DENY[purpose];
  if (!allow && !deny) return null;
  const r = await fetch('https://planetarycomputer.microsoft.com/api/stac/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collections: ['esa-worldcover'], intersects: aoi, limit: 4, sortby: [{ field: 'properties.datetime', direction: 'desc' }] }),
    signal,
  });
  if (!r.ok) return null;
  const feats: any[] = (await r.json()).features ?? [];
  const f = feats.find((x) => String(x.properties?.datetime ?? x.properties?.start_datetime ?? '').startsWith('2021')) ?? feats[0];
  if (!f) return null;
  const cond = allow ? allow.map((c) => `(map==${c})`).join('|') : deny!.map((c) => `(map!=${c})`).join('&');
  // 2 = keep, 1 = drop (0 is reserved for no-data)
  const pseudo = { id: f.id, collection: 'esa-worldcover' } as unknown as ImageryItem;
  const m = await fetchRaster(pseudo, `where(${cond},2,1)`, [0, 2], grid, signal);
  return m.values;
}

/** 5×5 mean in linear power units (dB in, dB out), NaN-aware — reduces radar speckle. */
function despeckle(r: Raster): Raster {
  const { width: W, height: H } = r.grid;
  const lin = new Float32Array(r.values.length);
  for (let p = 0; p < lin.length; p++) lin[p] = Number.isNaN(r.values[p]) ? NaN : 10 ** (r.values[p] / 10);
  const out = new Float32Array(lin.length);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (Number.isNaN(lin[p])) { out[p] = NaN; continue; }
      let s = 0, n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const v = lin[yy * W + xx];
          if (!Number.isNaN(v)) { s += v; n++; }
        }
      }
      out[p] = 10 * Math.log10(s / n);
    }
  return { grid: r.grid, values: out };
}

// ---------------------------------------------------------------- cloud / shadow / no-data masks

const lsBit = (k: number) => `(((qa_pixel/${2 ** k})%2)>=1)`;
/** per-pixel state codes: 0 no data · 3 cloud shadow · 8 cloud · 4 clear */
function stateExpr(it: ImageryItem): string | null {
  const k = sensorOf(it);
  if (k === 's2') return 'where((SCL==0)|(SCL==1),0,where(SCL==3,3,where((SCL==8)|(SCL==9)|(SCL==10),8,4)))';
  if (k === 'landsat') return `where(${lsBit(0)},0,where(${lsBit(1)}|${lsBit(2)}|${lsBit(3)},8,where(${lsBit(4)},3,4)))`;
  return null;
}
const cloudExpr = (it: ImageryItem) => (sensorOf(it) === 's2' ? 'where((SCL==8)|(SCL==9)|(SCL==10),1,0)' : `where(${lsBit(1)}|${lsBit(2)}|${lsBit(3)},1,0)`);
const shadowExpr = (it: ImageryItem) => (sensorOf(it) === 's2' ? 'where(SCL==3,1,0)' : `where(${lsBit(4)}&(~${lsBit(3)}),1,0)`);

/** Cloud and shadow inside the AOI from the scene's own mask (Sentinel-2 SCL / Landsat QA_PIXEL). Radar → null. */
export async function measureAoiCloud(it: ImageryItem, aoi: GeoJSON.Polygon, signal?: AbortSignal): Promise<AoiCloud | null> {
  const k = sensorOf(it);
  if (k !== 's2' && k !== 'landsat') return null;
  const [c, sh] = await Promise.all([aoiStatistics(it, cloudExpr(it), aoi, { signal }), aoiStatistics(it, shadowExpr(it), aoi, { signal }).catch(() => null)]);
  const cover = it.coveragePct ?? 100;
  const f = cover / 100;
  return { cloudPct: c.mean * 100 * f, shadowPct: (sh?.mean ?? 0) * 100 * f, noDataPct: Math.max(0, 100 - cover) };
}

export interface RunProgress {
  (msg: string): void;
}

const OPT_COLLECTIONS: StacCollectionId[] = ['sentinel-2-l2a'];

/** Optical candidates in a window that pass the scene thresholds and the AOI-cloud threshold, best first. */
async function passingOptical(aoi: GeoJSON.Polygon, from: string, to: string, qc: QcSettings, match: ImageryItem | null, signal: AbortSignal | undefined, seen: { it: ImageryItem; cl: AoiCloud | null; why: string[] }[], collections: StacCollectionId[] = OPT_COLLECTIONS) {
  const all = (await searchArchive({ aoi, collections, from, to, maxCloud: qc.maxSceneCloud, limit: 40 })).filter((x) => x.source === 'planetary-computer');
  const pre = all.filter((x) => checkScene(x, { cloudPct: 0, shadowPct: 0, noDataPct: 0 }, qc).ok || checkScene(x, null, qc).pending);
  const sameGeom = (x: ImageryItem) =>
    !match || (x.collection === match.collection && ['s2:mgrs_tile', 'landsat:wrs_path', 'landsat:wrs_row'].every((k) => x.raw?.properties?.[k] == null || x.raw.properties[k] === match.raw?.properties?.[k]));
  const sameSat = (x: ImageryItem) => !match || x.collection === match.collection;
  const ordered = [...pre].sort((a, b) => Number(sameSat(b)) - Number(sameSat(a)) || Number(sameGeom(b)) - Number(sameGeom(a)) || (a.cloudCover ?? 100) - (b.cloudCover ?? 100) || b.datetime.localeCompare(a.datetime)).slice(0, 6);
  for (const it of ordered) {
    const cl = await measureAoiCloud(it, aoi, signal).catch(() => null);
    const chk = checkScene(it, cl, qc);
    seen.push({ it, cl, why: chk.reasons });
    if (cl && chk.ok) return { it, cl };
  }
  return null;
}

export async function runMonitor(a: MonitorAoi, periodDays: number, progress: RunProgress, signal?: AbortSignal, qc: QcSettings = loadQc()): Promise<MonitorRun> {
  const w = windowsFor(periodDays);
  const base: MonitorRun = {
    id: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    aoiId: a.id,
    aoiName: a.name,
    purpose: a.purpose,
    at: new Date().toISOString(),
    status: 'insufficient',
    windows: w,
    qc,
    mode: 'auto',
  };
  const aoi = a.geometry;
  const mode: SensorMode = a.sensor ?? 'auto';
  const wantSar = mode === 'sar' || (mode === 'auto' && a.purpose === 'water');
  const optCols: StacCollectionId[] = mode === 'landsat' ? ['landsat-c2-l2'] : mode === 'optical-any' ? ['sentinel-2-l2a', 'landsat-c2-l2'] : ['sentinel-2-l2a'];
  const optName = mode === 'landsat' ? 'Landsat 8/9' : mode === 'optical-any' ? 'Sentinel-2/Landsat' : 'Sentinel-2';
  // choosing Landsat explicitly accepts its 30 m pixels; mixing both needs cross-sensor consent
  if (mode === 'landsat' || mode === 'optical-any') qc = { ...qc, maxGsdM: Math.max(qc.maxGsdM, 30) };
  base.qc = qc;
  const sarPossible = !!methodFor(a.purpose, 'sar');
  const tried: string[] = [];
  const seen: { it: ImageryItem; cl: AoiCloud | null; why: string[] }[] = [];

  try {
    let A: ImageryItem | null = null, B: ImageryItem | null = null;
    let clA: AoiCloud | null = null, clB: AoiCloud | null = null;
    const optical = async () => {
      progress(`ค้นหาภาพ ${optName} ช่วงล่าสุด (เมฆรวม ≤ ${qc.maxSceneCloud}%, เมฆใน AOI ≤ ${qc.maxAoiCloud}%)…`);
      const b = await passingOptical(aoi, w.after[0], w.after[1], qc, null, signal, seen, optCols);
      if (!b) return void tried.push(`ไม่มีภาพ ${optName} ช่วง ${w.after[0]} ถึง ${w.after[1]} ที่ผ่านเกณฑ์เมฆ`);
      progress('ค้นหาภาพอ้างอิงช่วงก่อนหน้า…');
      const aa = await passingOptical(aoi, w.before[0], w.before[1], qc, b.it, signal, seen, optCols);
      if (!aa) return void tried.push(`ไม่มีภาพอ้างอิง ${optName} ช่วง ${w.before[0]} ถึง ${w.before[1]} ที่ผ่านเกณฑ์เมฆ`);
      if (aa.it.collection !== b.it.collection && !qc.allowCrossSensor) return void tried.push(`ภาพก่อน (${aa.it.collectionLabel}) กับภาพหลัง (${b.it.collectionLabel}) คนละดาวเทียม — เปิด “ยอมให้เทียบข้ามเซนเซอร์” ในเกณฑ์ถ้าต้องการ`);
      A = aa.it; B = b.it; clA = aa.cl; clB = b.cl;
    };
    const radar = async () => {
      progress('ค้นหาภาพเรดาร์ Sentinel-1…');
      const rb = await pickBestScene(aoi, RAD, w.after[0], w.after[1]);
      if (!rb.item) return void tried.push('ไม่มีภาพเรดาร์ใหม่ในช่วงที่ตรวจ');
      const ra = await pickBestScene(aoi, RAD, w.before[0], w.before[1], { match: rb.item });
      if (!ra.item) return void tried.push('ไม่มีภาพเรดาร์อ้างอิง');
      A = ra.item; B = rb.item;
    };
    if (!wantSar) await optical();
    if (!A && (wantSar || (mode === 'auto' && sarPossible))) {
      if (!sarPossible) tried.push('หัวข้อนี้ใช้เรดาร์ไม่ได้ (ต้องใช้ภาพปกติ)');
      else await radar();
    }
    if (!A && wantSar && mode === 'auto') await optical();
    if (!A || !B) {
      const sugg = seen.filter((x) => !x.why.length && x.cl).map((x) => ({ id: x.it.id, datetime: x.it.datetime, cloud: x.it.cloudCover, collection: x.it.collection }));
      const rejected = seen.filter((x) => x.why.length).slice(0, 4).map((x) => `${x.it.datetime.slice(0, 10)}: ${x.why.join(', ')}`);
      return { ...base, reason: [...tried, ...rejected].join(' · ') || 'ไม่มีภาพที่ใช้ได้', suggestions: sugg };
    }
    const sarUsedInstead = familyOf(B) === 'sar' && !wantSar && tried.length ? `ภาพปกติใช้ไม่ได้ (${tried.join('; ')}) จึงใช้เรดาร์แทน` : undefined;
    const r = await compareScenes(a, A, B, progress, signal, { qc, clA, clB, base });
    return sarUsedInstead ? { ...r, note: [sarUsedInstead, r.note].filter(Boolean).join(' · ') } : r;
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    return { ...base, status: 'error', reason: e?.message ?? String(e) };
  }
}

const CLOUD = 250, SHADOW = 251, NODATA = 255;

/** Compare two given scenes over the AOI with quality control. Used by the automatic check and by manual comparison. */
export async function compareScenes(
  a: MonitorAoi,
  A: ImageryItem,
  B: ImageryItem,
  progress: RunProgress,
  signal?: AbortSignal,
  opt: { qc?: QcSettings; clA?: AoiCloud | null; clB?: AoiCloud | null; base?: MonitorRun; mode?: 'auto' | 'manual' } = {},
): Promise<MonitorRun> {
  const qc = opt.qc ?? loadQc();
  const base: MonitorRun = opt.base ?? {
    id: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    aoiId: a.id, aoiName: a.name, purpose: a.purpose, at: new Date().toISOString(), status: 'insufficient',
    windows: { before: [A.datetime.slice(0, 10), A.datetime.slice(0, 10)], after: [B.datetime.slice(0, 10), B.datetime.slice(0, 10)] },
    qc, mode: opt.mode ?? 'manual',
  };
  const aoi = a.geometry;
  const sensor: 'optical' | 'sar' = familyOf(B);
  const metaOf = (it: ImageryItem, cl: AoiCloud | null | undefined): SceneMeta => {
    const p = it.raw?.properties ?? {};
    return {
      id: it.id, collection: it.collection, label: it.collectionLabel, datetime: it.datetime, cloud: it.cloudCover,
      aoiCloudPct: cl ? cl.cloudPct : null, aoiShadowPct: cl ? cl.shadowPct : null, gsd: it.gsd,
      processed: p['s2:generation_time'] ?? p['s1:processing_datetime'] ?? p['processing:datetime'] ?? null, ingested: p.created ?? null,
    };
  };
  try {
    const pair = checkPair(A, B, qc);
    if (!pair.ok) return { ...base, reason: pair.reasons.join(' · '), A: metaOf(A, opt.clA), B: metaOf(B, opt.clB), pairNotes: pair.notes };
    const m = methodFor(a.purpose, sensor);
    if (!m) return { ...base, reason: sensor === 'sar' ? 'หัวข้อนี้วิเคราะห์ด้วยเรดาร์ไม่ได้ ต้องใช้ภาพปกติ' : 'ไม่มีวิธีวิเคราะห์สำหรับหัวข้อนี้' };
    // measure AOI cloud if the caller did not
    let clA = opt.clA ?? null, clB = opt.clB ?? null;
    if (sensor === 'optical') {
      progress('ตรวจเมฆใน AOI ของทั้งสองภาพ…');
      if (!clA) clA = await measureAoiCloud(A, aoi, signal).catch(() => null);
      if (!clB) clB = await measureAoiCloud(B, aoi, signal).catch(() => null);
      const fails = [['ก่อน', A, clA], ['หลัง', B, clB]].map(([lbl, it, cl]) => ({ lbl, chk: checkScene(it as ImageryItem, cl as AoiCloud | null, qc) })).filter((x) => !x.chk.ok);
      if (fails.length)
        return {
          ...base, A: metaOf(A, clA), B: metaOf(B, clB), pairNotes: pair.notes,
          reason: fails.map((x) => `ภาพ${x.lbl}: ${x.chk.pending ? 'วัดเมฆใน AOI ไม่ได้' : x.chk.reasons.join(', ')}`).join(' · '),
        };
    }

    // ---- read pixels + per-pixel state
    const grid = gridFor(aoi);
    const read = async (it: ImageryItem, lbl: string) => {
      const out: Raster[] = [];
      const ins = m.inputs(it);
      for (let k = 0; k < ins.length; k++) out.push(await fetchRaster(it, ins[k].expr, ins[k].range, grid, signal, (d, n) => progress(`อ่านภาพ${lbl} ${k + 1}/${ins.length} · ${d}/${n}`)));
      const se = stateExpr(it);
      const state = se ? await fetchRaster(it, se, [0, 255], grid, signal, (d, n) => progress(`อ่านหน้ากากเมฆภาพ${lbl} ${d}/${n}`)) : null;
      return { vals: sensorOf(it) === 's1' ? out.map(despeckle) : out, state };
    };
    const ra = await read(A, 'ก่อน');
    const rb = await read(B, 'หลัง');
    progress('อ่านแผนที่สิ่งปกคลุมดิน (ESA WorldCover)…');
    const lc = await landCoverMask(aoi, a.purpose, grid, signal).catch(() => null);
    const lcNote = (WC_ALLOW[a.purpose] || WC_DENY[a.purpose]) && !lc ? 'land-cover mask unavailable — all land classes analysed' : undefined;
    progress('จำแนกการเปลี่ยนแปลง (แยกเมฆ เงาเมฆ และไม่มีข้อมูลออก)…');
    const n = ra.vals.length;
    const idxR: Raster = { grid, values: new Float32Array(ra.vals[0].values.length).map((_, p) => p) };
    const st = (s: Raster | null, p: number) => {
      if (!s) return 4;
      const v = s.values[p];
      if (Number.isNaN(v)) return 0;
      const c = Math.round(v);
      return c <= 1 ? 0 : c <= 5 ? (c === 3 ? 3 : 4) : 8;
    };
    const anyNaN = (rs: Raster[], p: number) => rs.some((r) => Number.isNaN(r.values[p]));
    const defs: ClassDef[] = [
      ...m.legend.map((l) => ({ id: l.id, label: l.label, rgba: hexRgba(l.color, 215) })),
      { id: 3, label: 'No significant change', rgba: [0, 0, 0, 0] },
      { id: CLOUD, label: 'Cloud', rgba: [235, 235, 245, 170], hatch: true },
      { id: SHADOW, label: 'Cloud shadow', rgba: [120, 90, 200, 170], hatch: true },
      { id: NODATA, label: 'No data', rgba: [90, 90, 90, 150], hatch: true },
    ];
    const res: Classified = classify(aoi, idxR, idxR, (pa) => {
      const p = pa as number;
      const sa = st(ra.state, p), sb = st(rb.state, p);
      if (sa === 8 || sb === 8) return CLOUD;
      if (sa === 3 || sb === 3) return SHADOW;
      if (sa === 0 || sb === 0 || anyNaN(ra.vals, p) || anyNaN(rb.vals, p)) return NODATA;
      const va: number[] = [], vb: number[] = [];
      for (let k = 0; k < n; k++) {
        va.push(ra.vals[k].values[p]);
        vb.push(rb.vals[k].values[p]);
      }
      const c = m.fn(va, vb);
      if (lc && m.interest.includes(c) && !(lc[p] > 1.5)) return 3;
      return c;
    }, defs);
    // every AOI pixel is in exactly one state: change class / no change / cloud / shadow / no data
    const cloudKm2 = res.areasKm2[CLOUD] ?? 0, shadowKm2 = res.areasKm2[SHADOW] ?? 0, ndKm2 = res.areasKm2[NODATA] ?? 0;
    const missKm2 = ndKm2 + res.noDataKm2;
    const validKm2 = Math.max(0, res.validKm2 - cloudKm2 - shadowKm2 - ndKm2);
    [CLOUD, SHADOW, NODATA].forEach((k) => delete res.areasKm2[k]);
    const changeIds = m.legend.map((l) => l.id).filter((id) => id !== 4);
    const changeKm2 = changeIds.reduce((t, id) => t + (res.areasKm2[id] ?? 0), 0);
    const validFrac = validKm2 / Math.max(res.aoiKm2, 1e-12);

    const pixKm2 = Math.max(gsdMeters(A), gsdMeters(B)) ** 2 / 1e6;
    const { list: hotspots, totalKm2 } = findHotspots(res, m.interest, Math.max(sensor === 'sar' ? 0.005 : 0.002, 20 * pixKm2));
    const quality = comparisonQuality({
      validFrac,
      aoiCloudA: clA ? (clA.cloudPct + clA.shadowPct) / 100 : null,
      aoiCloudB: clB ? (clB.cloudPct + clB.shadowPct) / 100 : null,
      sameCollection: A.collection === B.collection,
      sameFamily: familyOf(A) === familyOf(B),
      sameGeometry: !pair.notes.some((x) => x.startsWith('เรขาคณิต')),
      gapDays: Math.abs(new Date(B.datetime).getTime() - new Date(A.datetime).getTime()) / 86400e3,
      sameSeason: sameSeason(A.datetime, B.datetime),
      gsdA: gsdMeters(A),
      gsdB: gsdMeters(B),
    });

    // ---- images for the record / report / swipe
    progress('สร้างภาพประกอบ…');
    const after = await renderScene(B, aoi, { maxPx: 1400, signal }).catch(() => null);
    const before = await renderScene(A, aoi, { maxPx: 1400, signal }).catch(() => null);
    if (after) await putImage(`${base.id}:after`, after.canvas.toDataURL('image/jpeg', 0.85));
    if (before) await putImage(`${base.id}:before`, before.canvas.toDataURL('image/jpeg', 0.85));
    await putImage(`${base.id}:change`, res.imageUrl);

    const classKm2: Record<number, number> = {};
    Object.entries(res.areasKm2).forEach(([k, v]) => (classKm2[+k] = v));
    const stats = {
      aoiKm2: res.aoiKm2, validKm2, noDataKm2: cloudKm2 + shadowKm2 + missKm2, cloudKm2, shadowKm2, missingKm2: missKm2,
      changeKm2, noChangeKm2: Math.max(0, validKm2 - changeKm2), classKm2, interestKm2: totalKm2,
    };
    const common = {
      ...base, sensor, A: metaOf(A, clA), B: metaOf(B, clB), stats, legend: m.legend, interest: m.interest, method: m.text, quality, pairNotes: pair.notes, qc,
      bounds: after ? { west: after.west, south: after.south, east: after.east, north: after.north } : undefined,
      overlayBounds: { west: res.grid.west, south: res.grid.south, east: res.grid.east, north: res.grid.north },
    };
    // not enough analysable area → report the breakdown, but no change conclusion
    if (validFrac * 100 < qc.minValidPct)
      return { ...common, status: 'insufficient', reason: `พื้นที่ใช้วิเคราะห์ได้ ${(validFrac * 100).toFixed(0)}% ต่ำกว่าเกณฑ์ ${qc.minValidPct}% (เมฆ ${fmtArea(cloudKm2)}, เงาเมฆ ${fmtArea(shadowKm2)}, ไม่มีข้อมูล ${fmtArea(missKm2)}) — เลือกภาพวันอื่น` };

    const sigKm2 = Math.max(0.02, 0.01 * validKm2);
    const level: Level = totalKm2 >= sigKm2 ? 'significant' : totalKm2 >= 0.003 ? 'minor' : 'none';
    // classification confidence (separate from image quality)
    const notes: string[] = [];
    let score = quality.score >= 75 ? 3 : quality.score >= 50 ? 2 : 1;
    if (quality.score < 75) notes.push(`คุณภาพการเปรียบเทียบ ${quality.score}/100`);
    if (sensor === 'sar') { notes.push('สัญญาณเรดาร์เปลี่ยนได้จากความชื้นดิน พืชผล ฝน หรือความหยาบผิว ไม่ใช่เฉพาะการเปลี่ยนแปลงจริง'); score = Math.min(score, 2); }
    if (A.collection !== B.collection) { notes.push('เทียบข้ามเซนเซอร์'); score = Math.min(score, 2); }
    if (lcNote) { notes.push(lcNote); score = Math.max(1, score - 1); }
    pair.notes.forEach((x) => notes.push(x));
    const confidence = score >= 3 ? 'high' : score === 2 ? 'medium' : 'low';
    return { ...common, status: 'ok', hotspots, level, confidence, confidenceNotes: notes };
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    return { ...base, status: 'error', reason: e?.message ?? String(e) };
  }
}

function hexRgba(hex: string, a: number): [number, number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
}

/** 8-connected components of the interest classes; keeps those ≥ minKm2, largest first. Pixels belong to one class only, so nothing is counted twice. */
function findHotspots(res: Classified, interest: number[], minKm2: number): { list: Hotspot[]; totalKm2: number } {
  const g = res.grid;
  const W = g.width, H = g.height;
  const want = new Uint8Array(256);
  interest.forEach((c) => (want[c] = 1));
  const seen = new Uint8Array(W * H);
  const out: Hotspot[] = [];
  const stack: number[] = [];
  for (let p0 = 0; p0 < W * H; p0++) {
    const c0 = res.classes[p0];
    if (!want[c0] || seen[p0]) continue;
    let area = 0, sx = 0, sy = 0, cnt = 0;
    stack.push(p0);
    seen[p0] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const row = (p / W) | 0, col = p - row * W;
      const [lon, lat] = cellLonLat(g, row, col);
      area += cellAreaKm2(g, row);
      sx += lon; sy += lat; cnt++;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const r = row + dr, c = col + dc;
          if (r < 0 || c < 0 || r >= H || c >= W) continue;
          const q = r * W + c;
          if (!seen[q] && res.classes[q] === c0) {
            seen[q] = 1;
            stack.push(q);
          }
        }
    }
    if (area >= minKm2) out.push({ n: 0, lat: sy / cnt, lon: sx / cnt, areaHa: area * 100, areaKm2: area, cls: c0 });
  }
  out.sort((x, y) => (y.areaKm2 ?? 0) - (x.areaKm2 ?? 0));
  const totalKm2 = out.reduce((s, h) => s + (h.areaKm2 ?? 0), 0);
  return { list: out.slice(0, 50).map((h, i) => ({ ...h, n: i + 1 })), totalKm2 };
}

// ---------------------------------------------------------------- narrative (facts only, from numbers)

const fmt = (v: number, d = 1) => v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
export const rai = (km2: number) => km2 * 625;

const SENSOR_TH: Record<string, string> = { 'sentinel-2-l2a': 'Sentinel-2', 'landsat-c2-l2': 'Landsat 8/9', 'sentinel-1-rtc': 'เรดาร์ Sentinel-1' };

export function narrative(r: MonitorRun, lang: 'th' | 'en', unit: AreaUnit = 'km2'): string[] {
  const th = lang === 'th';
  const A = (km2: number) => fmtArea(km2, unit, th);
  if (r.status !== 'ok' || !r.stats) {
    return [th ? `ข้อมูลไม่เพียงพอสำหรับสรุปผล (ไม่ได้แปลว่าไม่มีการเปลี่ยนแปลง): ${r.reason ?? ''}` : `Insufficient data to conclude (this does not mean "no change"): ${r.reason ?? ''}`];
  }
  const s = r.stats;
  const lines: string[] = [];
  const label = r.legend?.find((l) => r.interest?.includes(l.id));
  const what = th ? label?.labelTh ?? 'การเปลี่ยนแปลง' : label?.label ?? 'change';
  if (r.level === 'none') lines.push(th ? `ไม่พบการเปลี่ยนแปลงที่เกินเกณฑ์ในส่วนที่ตรวจสอบได้` : `No change above the threshold in the part that could be checked.`);
  else lines.push(th ? `พบ${what} รวม ${A(s.interestKm2)} ${r.hotspots?.length ?? 0} จุด` : `${what}: ${A(s.interestKm2)} in ${r.hotspots?.length ?? 0} patch(es).`);
  const big = r.hotspots?.[0];
  if (big && r.level !== 'none') lines.push(th ? `จุดใหญ่ที่สุด ${A(hotspotKm2(big))} ที่พิกัด ${big.lat.toFixed(4)}, ${big.lon.toFixed(4)}` : `Largest patch ${A(hotspotKm2(big))} at ${big.lat.toFixed(4)}, ${big.lon.toFixed(4)}.`);
  const sa = SENSOR_TH[r.A?.collection ?? ''] ?? r.A?.label, sb = SENSOR_TH[r.B?.collection ?? ''] ?? r.B?.label;
  const sens = sa === sb ? sa : `${sa} / ${sb}`;
  lines.push(th ? `เปรียบเทียบภาพถ่ายวันที่ ${r.A?.datetime.slice(0, 10)} กับ ${r.B?.datetime.slice(0, 10)} (${sens})` : `Compared images acquired ${r.A?.datetime.slice(0, 10)} and ${r.B?.datetime.slice(0, 10)} (${sens}).`);
  const cov = (100 * s.validKm2) / Math.max(s.aoiKm2, 1e-9);
  const unc = s.noDataKm2;
  lines.push(
    th
      ? `ตรวจสอบได้ ${fmt(cov, 0)}% ของพื้นที่${unc > 0 ? ` · ตรวจไม่ได้ (เมฆ/เงาเมฆ/ไม่มีข้อมูล) ${A(unc)}` : ''} · ความเชื่อมั่น${confTh(r.confidence)}${r.quality ? ` · คุณภาพการเปรียบเทียบ ${r.quality.score}/100` : ''}`
      : `${fmt(cov, 0)}% of the AOI checkable${unc > 0 ? ` · not checkable (cloud/shadow/no data) ${A(unc)}` : ''} · confidence ${r.confidence}${r.quality ? ` · comparison quality ${r.quality.score}/100` : ''}.`,
  );
  return lines;
}

export const confTh = (c?: string) => (c === 'high' ? 'สูง' : c === 'medium' ? 'ปานกลาง' : c === 'low' ? 'ต่ำ' : '—');
export const levelTh = (l?: Level) => (l === 'significant' ? 'มีนัยสำคัญ' : l === 'minor' ? 'เล็กน้อย' : l === 'none' ? 'ไม่พบ' : '—');

export function aoiFromPolygon(name: string, geometry: GeoJSON.Polygon, region: Region, purpose: Purpose, freqDays = 7, sensor: SensorMode = 'auto'): MonitorAoi {
  return {
    id: `aoi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    region,
    purpose,
    sensor,
    geometry,
    freqDays,
    createdAt: new Date().toISOString(),
    active: true,
  };
}

export const aoiInfo = (a: MonitorAoi) => {
  const [lon, lat] = centroid(a.geometry);
  return { lon, lat, km2: areaKm2(a.geometry) };
};
