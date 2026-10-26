// Coordinate slots: saved points that are watched for new imagery and compared with last year.
// A slot is an ordinary watch area (MonitorAoi) with `point` set, so every existing result view,
// swipe and report works for it too.
import { compareScenes, measureAoiCloud, type MonitorAoi, type MonitorRun, type SlotWatch } from './monitor';
import { checkScene, familyOf, nearestPassing, type AoiCloud, type QcSettings } from './qc';
import { searchArchive, type ImageryItem, type StacCollectionId } from './stac';

const day = 86400e3;
const iso10 = (t: number) => new Date(t).toISOString().slice(0, 10);

export function slotCollections(a: Pick<MonitorAoi, 'sensor'>): StacCollectionId[] {
  switch (a.sensor) {
    case 'sar':
      return ['sentinel-1-rtc'];
    case 'landsat':
      return ['landsat-c2-l2'];
    case 'optical-any':
      return ['sentinel-2-l2a', 'landsat-c2-l2'];
    default:
      return ['sentinel-2-l2a'];
  }
}

// A point is judged by the cloud over the point itself, not by the cloud of the whole 100 km tile.
const qcFor = (a: MonitorAoi, qc: QcSettings): QcSettings => ({ ...qc, maxSceneCloud: 100, maxGsdM: a.sensor === 'landsat' || a.sensor === 'optical-any' ? Math.max(qc.maxGsdM, 30) : qc.maxGsdM });

export const emptyWatch = (notify = true): SlotWatch => ({ notify, seenIds: [], newScenes: [] });

/** Is the place itself clear enough in this scene to compare (ignores cloud elsewhere in the tile)? */
export function usableAtPoint(it: ImageryItem, cl: AoiCloud | null, qc: QcSettings): boolean {
  if (familyOf(it) === 'sar') return (it.coveragePct ?? 100) >= qc.minValidPct;
  if (!cl) return false;
  const obscured = cl.cloudPct + cl.shadowPct;
  return obscured <= qc.maxAoiCloud && 100 - obscured - cl.noDataPct >= qc.minValidPct;
}

/**
 * Look for scenes of this slot that are new to the catalogue since the last check.
 * Only scenes where the point is clear enough to compare are reported as new; the first check
 * just records what already exists.
 */
export async function checkNewScenes(a: MonitorAoi, qc: QcSettings, signal?: AbortSignal): Promise<{ watch: SlotWatch; added: SlotWatch['newScenes'] }> {
  const w = a.watch ?? emptyWatch();
  const now = Date.now();
  const items = (await searchArchive({ aoi: a.geometry, collections: slotCollections(a), from: iso10(now - 40 * day), to: iso10(now), limit: 30 })).filter((x) => x.source === 'planetary-computer');
  const first = !w.lastCheck && !w.seenIds.length;
  const fresh = items.filter((x) => !w.seenIds.includes(x.id));
  const seen: string[] = [];
  const added: SlotWatch['newScenes'] = [];
  if (first) seen.push(...fresh.map((x) => x.id));
  else
    for (const it of fresh.slice(0, 8)) {
      if (familyOf(it) === 'sar') {
        seen.push(it.id);
        if (usableAtPoint(it, null, qc)) added.push({ id: it.id, datetime: it.datetime, collection: it.collection, cloud: null });
        continue;
      }
      let cl: AoiCloud | null;
      try {
        cl = await measureAoiCloud(it, a.geometry, signal);
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        continue; // not marked as seen: retried next time
      }
      seen.push(it.id);
      if (usableAtPoint(it, cl, qc)) added.push({ id: it.id, datetime: it.datetime, collection: it.collection, cloud: cl ? +(cl.cloudPct + cl.shadowPct).toFixed(1) : null });
    }
  return {
    watch: {
      ...w,
      seenIds: [...seen, ...w.seenIds].slice(0, 200),
      newScenes: [...added, ...w.newScenes].sort((x, y) => y.datetime.localeCompare(x.datetime)).slice(0, 20),
      lastCheck: new Date(now).toISOString(),
    },
    added,
  };
}

/** Newest scene in the list that passes the checks for this place (measures AOI cloud as needed). */
async function firstPassing(list: ImageryItem[], a: MonitorAoi, qc: QcSettings, signal?: AbortSignal, max = 8) {
  const cl: Record<string, AoiCloud | null> = {};
  // pixel size and footprint coverage first (no cloud needed for that)
  const basicOk = (x: ImageryItem) => checkScene(x, familyOf(x) === 'sar' ? null : { cloudPct: 0, shadowPct: 0, noDataPct: 0 }, qc).ok;
  for (const it of list.filter(basicOk).slice(0, max)) {
    if (familyOf(it) === 'optical') {
      try {
        cl[it.id] = await measureAoiCloud(it, a.geometry, signal);
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        cl[it.id] = null;
      }
    }
    if (usableAtPoint(it, cl[it.id] ?? null, qc)) return { it, cl };
  }
  return { it: null as ImageryItem | null, cl };
}

export interface YearCompare {
  run: MonitorRun;
  A: ImageryItem;
  B: ImageryItem;
}

/**
 * Compare the newest usable scene of this place with the usable scene closest to the same date
 * one year earlier (same satellite). Scene-wide cloud is ignored: only cloud over the place counts.
 */
export async function compareWithLastYear(a: MonitorAoi, qcIn: QcSettings, progress: (msg: string) => void, signal?: AbortSignal): Promise<YearCompare> {
  const qc = qcFor(a, qcIn);
  const cols = slotCollections(a);
  const now = Date.now();
  progress('ค้นหาภาพล่าสุดของจุดนี้ (90 วัน)…');
  const recent = (await searchArchive({ aoi: a.geometry, collections: cols, from: iso10(now - 90 * day), to: iso10(now), limit: 40 })).filter((x) => x.source === 'planetary-computer');
  if (!recent.length) throw new Error('ไม่พบภาพของจุดนี้ใน 90 วันที่ผ่านมา');
  progress(`ตรวจเมฆเหนือจุดนี้ในภาพล่าสุด (${Math.min(recent.length, 8)} ภาพ)…`);
  const b = await firstPassing(recent, a, qc, signal);
  if (!b.it) throw new Error(`ภาพล่าสุด ${Math.min(recent.length, 8)} ภาพมีเมฆเหนือจุดนี้เกินเกณฑ์ (${qc.maxAoiCloud}%) — รอภาพใหม่ ผ่อนเกณฑ์เมฆ หรือเปลี่ยนเป็นเรดาร์`);
  const B = b.it;
  const target = new Date(B.datetime).getTime() - 365 * day;
  let A: ImageryItem | null = null;
  let clA: AoiCloud | null = null;
  for (const win of [45, 100]) {
    progress(`ค้นหาภาพปีที่แล้ว ใกล้วันที่ ${iso10(target)} (±${win} วัน)…`);
    const old = (await searchArchive({ aoi: a.geometry, collections: [B.collection], from: iso10(target - win * day), to: iso10(target + win * day), limit: 60 }))
      .filter((x) => x.source === 'planetary-computer' && x.datetime < B.datetime)
      .sort((x, y) => Math.abs(+new Date(x.datetime) - target) - Math.abs(+new Date(y.datetime) - target));
    if (!old.length) continue;
    // prefer the same orbit / tile as B, then the date closest to one year earlier
    const cand = nearestPassing(old, iso10(target), () => true, B);
    const ordered = cand ? [cand, ...old.filter((x) => x !== cand)] : old;
    progress('ตรวจเมฆเหนือจุดนี้ในภาพปีที่แล้ว…');
    const r = await firstPassing(ordered, a, qc, signal, 10);
    if (r.it) {
      A = r.it;
      clA = r.cl[A.id] ?? null;
      break;
    }
  }
  if (!A) throw new Error(`ไม่พบภาพปีที่แล้วที่เมฆเหนือจุดนี้ไม่เกิน ${qc.maxAoiCloud}% ช่วง ${iso10(target - 100 * day)} ถึง ${iso10(target + 100 * day)}`);
  const run = await compareScenes(a, A, B, progress, signal, { qc, clA, clB: b.cl[B.id] ?? null, mode: 'manual' });
  return { run, A, B };
}
