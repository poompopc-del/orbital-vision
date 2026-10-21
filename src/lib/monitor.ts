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
import { indexExpression, indexSummary, INDICES, PC_DATA, S2_CLEAR_EXPR, sarDbExpression, sensorOf } from './spectral';
import { renderScene } from './export';
import { areaKm2, centroid } from './geo';
import type { ImageryItem, StacCollectionId } from './stac';

// ---------------------------------------------------------------- types

export type Purpose = 'clearing' | 'construction' | 'water' | 'fire' | 'general';
export type Region = 'TH-KH' | 'TH-MY' | 'TH-MM' | 'TH-LA' | 'TH' | 'OTHER';
export type SensorMode = 'auto' | 'optical' | 'sar';

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
}

export interface SceneMeta {
  id: string;
  collection: string;
  label: string;
  datetime: string;
  cloud: number | null;
  aoiCloudPct: number | null;
  gsd: string;
}

export interface Hotspot {
  n: number;
  lat: number;
  lon: number;
  areaHa: number;
  cls: number;
}

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
  stats?: { aoiKm2: number; validKm2: number; noDataKm2: number; classKm2: Record<number, number>; interestKm2: number };
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

const MIN_HOTSPOT_HA = 0.2;
const OPT: StacCollectionId = 'sentinel-2-l2a';
const RAD: StacCollectionId = 'sentinel-1-rtc';

function meta(it: ImageryItem, aoiCloud: number | null): SceneMeta {
  return { id: it.id, collection: it.collection, label: it.collectionLabel, datetime: it.datetime, cloud: it.cloudCover, aoiCloudPct: aoiCloud, gsd: it.gsd };
}

/** Among optical candidates pick the one with the least cloud *inside the AOI* (SCL statistics). */
async function clearestOptical(aoi: GeoJSON.Polygon, from: string, to: string, match: ImageryItem | null, signal?: AbortSignal) {
  const r = await pickBestScene(aoi, OPT, from, to, { match, maxCloud: 80 });
  const pool = [r.item, ...r.candidates.filter((c) => c.source === 'planetary-computer' && c.id !== r.item?.id && (c.coveragePct ?? 0) >= 90)]
    .filter(Boolean)
    .slice(0, 5) as ImageryItem[];
  let best: { it: ImageryItem; cloud: number } | null = null;
  for (const it of pool) {
    try {
      const s = await indexSummary(it, idx('ndvi')(it).expr, aoi, [-1, 1], signal);
      const c = s.cloudFraction ?? 1;
      if (!best || c < best.cloud) best = { it, cloud: c };
      if (c < 0.05) break;
    } catch {
      /* scene may not cover */
    }
  }
  return best;
}

// ---- ESA WorldCover 2021 (10 m) land-cover mask, read through the Planetary Computer data API
const WC_ALLOW: Partial<Record<Purpose, number[]>> = { clearing: [10, 20] }; // tree cover, shrubland
const WC_DENY: Partial<Record<Purpose, number[]>> = { construction: [40, 50] }; // cropland, built-up

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

export interface RunProgress {
  (msg: string): void;
}

export async function runMonitor(a: MonitorAoi, periodDays: number, progress: RunProgress, signal?: AbortSignal): Promise<MonitorRun> {
  const w = windowsFor(periodDays);
  const base: MonitorRun = {
    id: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    aoiId: a.id,
    aoiName: a.name,
    purpose: a.purpose,
    at: new Date().toISOString(),
    status: 'insufficient',
    windows: w,
  };
  const aoi = a.geometry;
  const wantSar = a.sensor === 'sar' || (a.sensor === 'auto' && a.purpose === 'water');
  const sarPossible = !!methodFor(a.purpose, 'sar');
  const tried: string[] = [];

  try {
    // ---- choose scenes
    let A: ImageryItem | null = null, B: ImageryItem | null = null, sensor: 'optical' | 'sar' = 'optical';
    let aCloud: number | null = null, bCloud: number | null = null;
    if (!wantSar) {
      progress('ค้นหาภาพ Sentinel-2 ช่วงล่าสุด…');
      const b = await clearestOptical(aoi, w.after[0], w.after[1], null, signal);
      if (b && b.cloud <= 0.5) {
        progress('ค้นหาภาพอ้างอิงช่วงก่อนหน้า…');
        const aa = await clearestOptical(aoi, w.before[0], w.before[1], b.it, signal);
        if (aa && aa.cloud <= 0.5) {
          A = aa.it; B = b.it; aCloud = aa.cloud; bCloud = b.cloud;
        } else tried.push(aa ? `optical reference too cloudy over the AOI (${Math.round(aa.cloud * 100)}%)` : 'no optical reference scene');
      } else tried.push(b ? `latest optical scene too cloudy over the AOI (${Math.round(b.cloud * 100)}%)` : 'no new optical scene in the period');
    }
    if (!A && (wantSar || (a.sensor === 'auto' && sarPossible))) {
      progress('ค้นหาภาพเรดาร์ Sentinel-1…');
      const rb = await pickBestScene(aoi, RAD, w.after[0], w.after[1]);
      if (rb.item) {
        const ra = await pickBestScene(aoi, RAD, w.before[0], w.before[1], { match: rb.item });
        if (ra.item) {
          A = ra.item; B = rb.item; sensor = 'sar';
        } else tried.push('no radar reference scene');
      } else tried.push('no new radar scene in the period');
    }
    if (!A || !B) {
      return { ...base, reason: tried.join('; ') || 'no usable imagery' };
    }
    const m = methodFor(a.purpose, sensor)!;
    const note = sensor === 'sar' && !wantSar && tried.length ? `optical not usable (${tried.join('; ')}) — radar used instead` : undefined;

    // ---- read pixels
    const grid = gridFor(aoi);
    const read = async (it: ImageryItem, lbl: string): Promise<Raster[]> => {
      const out: Raster[] = [];
      const ins = m.inputs(it);
      for (let k = 0; k < ins.length; k++) {
        const r = await fetchRaster(it, ins[k].expr, ins[k].range, grid, signal, (d, n) => progress(`อ่านภาพ${lbl} ${k + 1}/${ins.length} · ${d}/${n}`));
        out.push(r);
      }
      if (sensorOf(it) === 's2') {
        const clear = await fetchRaster(it, S2_CLEAR_EXPR, [0, 1], grid, signal, (d, n) => progress(`ตรวจเมฆภาพ${lbl} ${d}/${n}`));
        for (const r of out) for (let p = 0; p < r.values.length; p++) if (!(clear.values[p] > 0.5)) r.values[p] = NaN;
      }
      if (sensorOf(it) === 's1') return out.map(despeckle);
      return out;
    };
    const ra = await read(A, 'ก่อน');
    const rb = await read(B, 'หลัง');
    progress('อ่านแผนที่สิ่งปกคลุมดิน (ESA WorldCover)…');
    const lc = await landCoverMask(aoi, a.purpose, grid, signal).catch(() => null);
    const lcNote = (WC_ALLOW[a.purpose] || WC_DENY[a.purpose]) && !lc ? 'land-cover mask unavailable — all land classes analysed' : undefined;
    progress('จำแนกการเปลี่ยนแปลง…');
    // pack multi-input pixels into one virtual raster pair for classify(): index p → arrays
    const n = ra.length;
    const vA = new Float32Array(ra[0].values.length).map((_, p) => p);
    const RA: Raster = { grid, values: vA };
    const RB: Raster = { grid, values: vA };
    const anyNaN = (rs: Raster[], p: number) => rs.some((r) => Number.isNaN(r.values[p]));
    const defs: ClassDef[] = [
      ...m.legend.map((l) => ({ id: l.id, label: l.label, rgba: hexRgba(l.color, 215) })),
      { id: 3, label: 'No significant change', rgba: [0, 0, 0, 0] },
    ];
    const res: Classified = classify(aoi, RA, RB, (pa) => {
      const p = pa as number;
      if (anyNaN(ra, p) || anyNaN(rb, p)) return 255;
      const va: number[] = [], vb: number[] = [];
      for (let k = 0; k < n; k++) {
        va.push(ra[k].values[p]);
        vb.push(rb[k].values[p]);
      }
      const c = m.fn(va, vb);
      // land-cover filter applies to the classes of interest only (e.g. loss on forest)
      if (lc && m.interest.includes(c) && !(lc[p] > 1.5)) return 3;
      return c;
    }, defs);
    // classify() counts 255 as a class; move it to no-data
    const nd = res.areasKm2[255] ?? 0;
    delete res.areasKm2[255];
    res.validKm2 -= nd;
    res.noDataKm2 += nd;

    // ---- hotspots (connected components of the classes of interest)
    const { list: hotspots, totalHa } = findHotspots(res, m.interest, sensor === 'sar' ? 0.5 : MIN_HOTSPOT_HA);
    const interestKm2 = totalHa / 100;
    const validFrac = res.validKm2 / Math.max(res.aoiKm2, 1e-9);
    if (validFrac < 0.2) {
      return { ...base, sensor, A: meta(A, aCloud != null ? aCloud * 100 : null), B: meta(B, bCloud != null ? bCloud * 100 : null), reason: `only ${Math.round(validFrac * 100)}% of the AOI is cloud-free in both images` };
    }
    const sigHa = Math.max(2, 0.01 * res.validKm2 * 100);
    const level: Level = interestKm2 * 100 >= sigHa ? 'significant' : interestKm2 * 100 >= 0.3 ? 'minor' : 'none';

    // ---- confidence
    const notes: string[] = [];
    let score = 3;
    if (validFrac < 0.8) { score--; notes.push(`${Math.round((1 - validFrac) * 100)}% of the AOI has no usable data (cloud/shadow/edge)`); }
    if (validFrac < 0.5) score--;
    const gap = Math.abs(new Date(B.datetime).getTime() - new Date(A.datetime).getTime()) / 86400e3;
    if (gap > 45) { score--; notes.push(`${Math.round(gap)} days between images — seasonal change possible`); }
    const geomA = A.raw?.properties?.['sat:relative_orbit'] ?? A.raw?.properties?.['s2:mgrs_tile'];
    const geomB = B.raw?.properties?.['sat:relative_orbit'] ?? B.raw?.properties?.['s2:mgrs_tile'];
    if (geomA != null && geomB != null && geomA !== geomB) { score--; notes.push('images from different orbit/tile geometry'); }
    if (sensor === 'sar') { notes.push('radar change can also come from soil moisture, crops or rain'); score = Math.min(score, 2); }
    if (lcNote) notes.push(lcNote);
    const confidence = score >= 3 ? 'high' : score === 2 ? 'medium' : 'low';

    // ---- images for the record / report
    progress('สร้างภาพประกอบ…');
    const after = await renderScene(B, aoi, { maxPx: 1400, signal }).catch(() => null);
    const before = await renderScene(A, aoi, { maxPx: 1400, signal }).catch(() => null);
    if (after) await putImage(`${base.id}:after`, after.canvas.toDataURL('image/jpeg', 0.85));
    if (before) await putImage(`${base.id}:before`, before.canvas.toDataURL('image/jpeg', 0.85));
    await putImage(`${base.id}:change`, res.imageUrl);

    const classKm2: Record<number, number> = {};
    Object.entries(res.areasKm2).forEach(([k, v]) => (classKm2[+k] = v));
    return {
      ...base,
      status: 'ok',
      sensor,
      A: meta(A, aCloud != null ? aCloud * 100 : null),
      B: meta(B, bCloud != null ? bCloud * 100 : null),
      stats: { aoiKm2: res.aoiKm2, validKm2: res.validKm2, noDataKm2: res.noDataKm2, classKm2, interestKm2 },
      legend: m.legend,
      interest: m.interest,
      hotspots,
      level,
      confidence,
      confidenceNotes: notes,
      method: m.text,
      note,
      bounds: after ? { west: after.west, south: after.south, east: after.east, north: after.north } : undefined,
      overlayBounds: { west: res.grid.west, south: res.grid.south, east: res.grid.east, north: res.grid.north },
    };
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    return { ...base, status: 'error', reason: e?.message ?? String(e) };
  }
}

function hexRgba(hex: string, a: number): [number, number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
}

/** 8-connected components of the interest classes; keeps those ≥ MIN_HOTSPOT_HA, largest first. */
function findHotspots(res: Classified, interest: number[], minHa: number): { list: Hotspot[]; totalHa: number } {
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
      area += cellAreaKm2(g, lat);
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
    const ha = area * 100;
    if (ha >= minHa) out.push({ n: 0, lat: sy / cnt, lon: sx / cnt, areaHa: ha, cls: c0 });
  }
  out.sort((x, y) => y.areaHa - x.areaHa);
  const totalHa = out.reduce((s, h) => s + h.areaHa, 0);
  return { list: out.slice(0, 50).map((h, i) => ({ ...h, n: i + 1 })), totalHa };
}

// ---------------------------------------------------------------- narrative (facts only, from numbers)

const fmt = (v: number, d = 1) => v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
export const rai = (km2: number) => km2 * 625;

export function narrative(r: MonitorRun, lang: 'th' | 'en'): string[] {
  const th = lang === 'th';
  if (r.status !== 'ok' || !r.stats) {
    return [th ? `ข้อมูลไม่เพียงพอสำหรับประเมินการเปลี่ยนแปลง: ${r.reason ?? ''}` : `Insufficient data to assess change: ${r.reason ?? ''}`];
  }
  const s = r.stats;
  const lines: string[] = [];
  const ha = s.interestKm2 * 100;
  const label = r.legend?.find((l) => r.interest?.includes(l.id));
  const what = th ? label?.labelTh ?? 'การเปลี่ยนแปลง' : label?.label ?? 'change';
  if (r.level === 'none') lines.push(th ? `ไม่พบการเปลี่ยนแปลงที่เกินเกณฑ์จากข้อมูลที่ใช้วิเคราะห์` : `No change above the threshold was detected in the data analysed.`);
  else
    lines.push(
      th
        ? `พบ${what} รวม ${fmt(ha)} เฮกตาร์ (${fmt(rai(s.interestKm2), 0)} ไร่) ${r.hotspots?.length ?? 0} จุด`
        : `${what}: ${fmt(ha)} ha (${fmt(rai(s.interestKm2), 0)} rai) detected in ${r.hotspots?.length ?? 0} patch(es).`,
    );
  const big = r.hotspots?.[0];
  if (big && r.level !== 'none')
    lines.push(th ? `จุดใหญ่ที่สุด ${fmt(big.areaHa)} เฮกตาร์ ที่พิกัด ${big.lat.toFixed(4)}, ${big.lon.toFixed(4)}` : `Largest patch ${fmt(big.areaHa)} ha at ${big.lat.toFixed(4)}, ${big.lon.toFixed(4)}.`);
  lines.push(
    th
      ? `เปรียบเทียบภาพ ${r.A?.datetime.slice(0, 10)} กับ ${r.B?.datetime.slice(0, 10)} (${r.sensor === 'sar' ? 'เรดาร์ Sentinel-1' : 'Sentinel-2'})`
      : `Compared ${r.A?.datetime.slice(0, 10)} with ${r.B?.datetime.slice(0, 10)} (${r.sensor === 'sar' ? 'Sentinel-1 radar' : 'Sentinel-2'}).`,
  );
  const cov = (100 * s.validKm2) / Math.max(s.aoiKm2, 1e-9);
  lines.push(th ? `วิเคราะห์ได้ ${fmt(cov, 0)}% ของพื้นที่ · ความเชื่อมั่น${confTh(r.confidence)}` : `${fmt(cov, 0)}% of the AOI analysable · confidence ${r.confidence}.`);
  return lines;
}

export const confTh = (c?: string) => (c === 'high' ? 'สูง' : c === 'medium' ? 'ปานกลาง' : c === 'low' ? 'ต่ำ' : '—');
export const levelTh = (l?: Level) => (l === 'significant' ? 'มีนัยสำคัญ' : l === 'minor' ? 'เล็กน้อย' : l === 'none' ? 'ไม่พบ' : '—');

export function aoiFromPolygon(name: string, geometry: GeoJSON.Polygon, region: Region, purpose: Purpose, freqDays = 7): MonitorAoi {
  return {
    id: `aoi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    region,
    purpose,
    sensor: 'auto',
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
