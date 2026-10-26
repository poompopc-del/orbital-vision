// Manual multi-temporal comparison for one watch area: search the archive over the AOI, see every
// scene on a timeline with its real acquisition date and cloud figures, pick two dates (or use a
// preset), check them against the quality thresholds and compare. Scenes that fail are shown with
// the reason and are never used silently.
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useLang } from '../../i18n';
import { Badge, Button, Field, Input, Notice, Panel, Select, Spinner, cx } from '../ui';
import { searchArchive, type ImageryItem, type StacCollectionId } from '../../lib/stac';
import { checkPair, checkScene, familyOf, gsdMeters, nearestPassing, sceneDates, sensorName, type AoiCloud } from '../../lib/qc';
import { compareScenes, measureAoiCloud, type MonitorAoi, type MonitorRun } from '../../lib/monitor';
import { useQc } from '../../lib/qcStore';

const useL = () => {
  const lang = useLang((s) => s.lang);
  return (th: string, en: string) => (lang === 'th' ? th : en);
};
const d10 = (s?: string | null) => (s ? s.slice(0, 10) : '—');
const dt = (s?: string | null) => (s ? `${s.slice(0, 10)} ${s.slice(11, 16)}Z` : '—');
const daysAgo = (n: number) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
const COLL: { id: StacCollectionId; th: string }[] = [
  { id: 'sentinel-2-l2a', th: 'Sentinel-2 (10 ม.)' },
  { id: 'landsat-c2-l2', th: 'Landsat 8/9 (30 ม.)' },
  { id: 'sentinel-1-rtc', th: 'Sentinel-1 เรดาร์ (10 ม.)' },
];

type Preset = 'event' | 'week' | 'month' | 'year';

export default function ComparePanel({ aoi, onRun, onSwipe, swipeOn }: { aoi: MonitorAoi; onRun: (r: MonitorRun) => void; onSwipe: (A: ImageryItem, B: ImageryItem) => void; swipeOn: boolean }) {
  const L = useL();
  const { qc } = useQc();
  const [from, setFrom] = useState(daysAgo(365));
  const [to, setTo] = useState(daysAgo(0));
  const [colls, setColls] = useState<Set<StacCollectionId>>(new Set(['sentinel-2-l2a']));
  const [list, setList] = useState<ImageryItem[] | null>(null);
  const [cl, setCl] = useState<Record<string, AoiCloud | null | 'err'>>({});
  const [A, setA] = useState<ImageryItem | null>(null);
  const [B, setB] = useState<ImageryItem | null>(null);
  const [slot, setSlot] = useState<'A' | 'B'>('A');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [eventDate, setEventDate] = useState(daysAgo(14));
  const [onlyPass, setOnlyPass] = useState(false);
  const [details, setDetails] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const check = (it: ImageryItem) => checkScene(it, cl[it.id] === 'err' ? null : cl[it.id], qc);
  const search = async () => {
    setBusy(L('ค้นหาภาพในคลัง…', 'Searching the archive…'));
    setErr('');
    setA(null);
    setB(null);
    try {
      const r = await searchArchive({ aoi: aoi.geometry, collections: [...colls], from, to, limit: 500 }); // newest first; 100 cut off the older half of a one-year search
      setList(r.filter((x) => x.source === 'planetary-computer').sort((a, b) => a.datetime.localeCompare(b.datetime)));
      setCl({});
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy('');
    }
  };

  /** Measure AOI cloud for optical scenes that pass the scene-level checks (only what is needed). */
  const measure = async (items: ImageryItem[], signal?: AbortSignal) => {
    const out: Record<string, AoiCloud | null | 'err'> = {};
    let i = 0;
    for (const it of items) {
      if (familyOf(it) !== 'optical' || cl[it.id] !== undefined || out[it.id] !== undefined) continue;
      if (checkScene(it, null, qc).reasons.length) continue; // fails anyway (resolution, coverage, near-total cloud)
      setBusy(L(`วัดเมฆใน AOI ${++i}…`, `Measuring AOI cloud ${i}…`));
      out[it.id] = await measureAoiCloud(it, aoi.geometry, signal).catch(() => 'err' as const);
      setCl((c) => ({ ...c, [it.id]: out[it.id] }));
    }
    return { ...cl, ...out };
  };

  /** passes everything that can be checked without measuring (scene cloud, pixel size, coverage) */
  const sceneOk = (it: ImageryItem) => { const c = checkScene(it, null, qc); return c.ok || c.pending; };
  const passes = (it: ImageryItem, m: Record<string, AoiCloud | null | 'err'>) => checkScene(it, m[it.id] === 'err' ? null : (m[it.id] as AoiCloud | null | undefined), qc).ok;

  const preset = async (p: Preset) => {
    if (!list?.length) return;
    const ac = new AbortController();
    abort.current = ac;
    setErr('');
    try {
      if (p === 'event') {
        const ev = new Date(eventDate).toISOString();
        const before = list.filter((x) => x.datetime < ev && sceneOk(x)).reverse().slice(0, 8);
        const m1 = await measure(before, ac.signal);
        const a = before.find((x) => passes(x, m1)) ?? null;
        const after = list.filter((x) => x.datetime >= ev && sceneOk(x) && (!a || x.collection === a.collection)).slice(0, 8);
        const m2 = await measure(after, ac.signal);
        const b = after.find((x) => passes(x, { ...m1, ...m2 })) ?? null;
        setA(a);
        setB(b);
        if (!a || !b) setErr(L(`ไม่พบภาพที่ผ่านเกณฑ์${!a ? 'ก่อน' : 'หลัง'}วันเหตุการณ์ ลองขยายช่วงค้นหา ผ่อนเกณฑ์เมฆ หรือใช้เรดาร์`, `No passing scene ${!a ? 'before' : 'after'} the event — widen the search, relax the cloud limits or use radar`));
        return;
      }
      const latest = [...list].reverse().filter(sceneOk).slice(0, 8);
      const m1 = await measure(latest, ac.signal);
      const b = latest.find((x) => passes(x, m1)) ?? null;
      if (!b) {
        setErr(L(`${latest.length} ภาพล่าสุดมีเมฆในพื้นที่เกินเกณฑ์ — กด “ภาพล่าสุดที่มี” เพื่อดูภาพปัจจุบันแม้มีเมฆ หรือเลือก Sentinel-1 เรดาร์ซึ่งมองทะลุเมฆ`, `The ${latest.length} latest scenes are too cloudy over the area — use “Latest available” to view the current image anyway, or Sentinel-1 radar, which sees through cloud`));
        return;
      }
      const back = p === 'week' ? 7 : p === 'month' ? 30 : 365;
      const target = new Date(new Date(b.datetime).getTime() - back * 86400e3).toISOString();
      const near = [...list].filter((x) => x.collection === b.collection && x.datetime < b.datetime && sceneOk(x)).sort((x, y) => Math.abs(+new Date(x.datetime) - +new Date(target)) - Math.abs(+new Date(y.datetime) - +new Date(target))).slice(0, 8);
      const m2 = await measure(near, ac.signal);
      const a = nearestPassing(near, target, (x) => passes(x, { ...m1, ...m2 }), b);
      setA(a);
      setB(b);
      if (!a) setErr(L(`ไม่มีภาพที่ผ่านเกณฑ์ใกล้วันที่ ${d10(target)} — ขยายช่วงค้นหาย้อนหลังให้ครอบคลุม`, `No passing scene near ${d10(target)} — widen the search range`));
    } catch (e: any) {
      if (e?.name !== 'AbortError') setErr(e?.message ?? String(e));
    } finally {
      setBusy('');
    }
  };

  /** The newest scene in the list as "after", whatever its cloud — for seeing the current state (no conclusion if it fails). */
  const pickLatest = async () => {
    const it = list?.length ? list[list.length - 1] : null;
    if (!it) return;
    setErr('');
    const m = familyOf(it) === 'optical' && cl[it.id] === undefined ? await measure([it]) : cl;
    setBusy('');
    setB(it);
    setSlot('A');
    const c = checkScene(it, m[it.id] === 'err' ? null : (m[it.id] as AoiCloud | null | undefined), qc);
    if (!c.ok && !c.pending)
      setErr(L(`ภาพล่าสุด ${d10(it.datetime)} ไม่ผ่านเกณฑ์ (${c.reasons.join(', ')}) — เลื่อนเทียบดูได้ แต่ระบบจะไม่สรุปผลการเปลี่ยนแปลงจากภาพนี้`, `Latest scene ${d10(it.datetime)} fails the thresholds (${c.reasons.join(', ')}) — you can swipe to look, but no change conclusion is made from it`));
  };

  const pick = async (it: ImageryItem) => {
    if (familyOf(it) === 'optical' && cl[it.id] === undefined) await measure([it]);
    setBusy('');
    if (slot === 'A') {
      setA(it);
      setSlot('B');
    } else {
      setB(it);
      setSlot('A');
    }
  };

  const pair = A && B ? checkPair(A, B, qc) : null;
  const run = async () => {
    if (!A || !B) return;
    const ac = new AbortController();
    abort.current = ac;
    setErr('');
    try {
      const r = await compareScenes(aoi, A, B, (m) => setBusy(m), ac.signal, { qc, clA: cl[A.id] === 'err' ? null : (cl[A.id] as AoiCloud | null), clB: cl[B.id] === 'err' ? null : (cl[B.id] as AoiCloud | null), mode: 'manual' });
      onRun(r);
    } catch (e: any) {
      if (e?.name !== 'AbortError') setErr(e?.message ?? String(e));
    } finally {
      setBusy('');
    }
  };
  /** Trend: compare the reference A with every later passing scene of the same sensor (max 6). */
  const trend = async () => {
    if (!A || !list) return;
    const ac = new AbortController();
    abort.current = ac;
    try {
      const later = list.filter((x) => x.collection === A.collection && x.datetime > A.datetime).slice(-12);
      const m = await measure(later, ac.signal);
      const use = later.filter((x) => passes(x, m)).slice(-6);
      if (!use.length) return setErr(L('ไม่มีภาพหลังจากภาพอ้างอิงที่ผ่านเกณฑ์', 'No later scene passes the thresholds'));
      for (let i = 0; i < use.length; i++) {
        setBusy(L(`แนวโน้ม ${i + 1}/${use.length} · ${d10(use[i].datetime)}`, `Trend ${i + 1}/${use.length}`));
        const r = await compareScenes(aoi, A, use[i], (msg) => setBusy(`${i + 1}/${use.length} · ${msg}`), ac.signal, { qc, clA: m[A.id] === 'err' ? null : (m[A.id] as AoiCloud), clB: m[use[i].id] === 'err' ? null : (m[use[i].id] as AoiCloud), mode: 'manual' });
        onRun(r);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') setErr(e?.message ?? String(e));
    } finally {
      setBusy('');
    }
  };

  // ---- timeline geometry
  const shown = useMemo(() => (list ?? []).filter((x) => !onlyPass || check(x).ok || check(x).pending), [list, onlyPass, cl, qc]);
  const t0 = new Date(from).getTime(), t1 = new Date(to).getTime() + 86400e3;
  const rowY: Record<string, number> = { 'sentinel-2-l2a': 18, 'landsat-c2-l2': 34, 'sentinel-1-rtc': 50 };
  const dotColour = (it: ImageryItem) => {
    const c = check(it);
    if (familyOf(it) === 'sar') return c.ok ? '#60a5fa' : '#64748b';
    return c.ok ? '#4fd18b' : c.pending ? '#f5b84b' : '#ef4444';
  };

  return (
    <Panel collapsible storeKey="compare" title={L('เปรียบเทียบภาพย้อนหลัง (เลือกวันเอง)', 'Compare imagery over time (pick dates)')} right={A && B ? <span className="font-mono text-[10px] text-cyan-300">A {d10(A.datetime)} · B {d10(B.datetime)}</span> : undefined}>
      <div className="grid grid-cols-2 gap-1.5">
        <Field label={L('ค้นหาตั้งแต่', 'From')}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="!py-1 text-xs" /></Field>
        <Field label={L('ถึง', 'To')}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="!py-1 text-xs" /></Field>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-200">
        {COLL.map((c) => (
          <label key={c.id} className="flex items-center gap-1">
            <input type="checkbox" checked={colls.has(c.id)} onChange={(e) => { const s = new Set(colls); e.target.checked ? s.add(c.id) : s.delete(c.id); setColls(s); }} />{c.th}
          </label>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <Button variant="primary" disabled={!!busy || !colls.size} onClick={search}>{L('ค้นหาภาพ', 'Search')}</Button>
        {busy && <Button variant="danger" onClick={() => abort.current?.abort()}>{L('หยุด', 'Stop')}</Button>}
      </div>
      {busy && <p className="mt-1 flex items-center gap-1.5 text-[10px] text-cyan-300"><Spinner />{busy}</p>}
      {err && <p className="mt-1 text-[10px] text-warn">{err}</p>}

      {list && (
        <div className="mt-2 space-y-2">
          {!list.length && <Notice tone="warn">{L('ไม่พบภาพในช่วงนี้ ลองขยายช่วงวันที่หรือเลือกดาวเทียมเพิ่ม', 'No scenes in this range — widen it or add sensors')}</Notice>}
          {list.length > 0 && (
            <>
              <div className="rounded border border-line bg-ink-950/60 p-1">
                <SceneTimeline
                  items={shown}
                  t0={t0}
                  t1={t1}
                  rows={Object.entries(rowY).filter(([k]) => colls.has(k as StacCollectionId)).map(([k, y]) => ({ y, label: k === 'sentinel-2-l2a' ? 'S2' : k === 'landsat-c2-l2' ? 'Landsat' : 'S1' }))}
                  rowY={rowY}
                  A={A}
                  B={B}
                  colour={dotColour}
                  tip={(it) => `${dt(it.datetime)} · ${sensorName(it)}${it.cloudCover != null ? ` · เมฆรวม ${it.cloudCover.toFixed(0)}%` : ''}${check(it).reasons.length ? ` · ไม่ผ่าน: ${check(it).reasons.join(', ')}` : ''}`}
                  onPick={(it) => void pick(it)}
                />
                <div className="flex flex-wrap gap-2 px-1 text-[9px] text-muted">
                  <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-[#4fd18b]" />{L('ผ่านเกณฑ์', 'passes')}</span>
                  <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-[#f5b84b]" />{L('ต้องวัดเมฆใน AOI', 'AOI cloud not measured')}</span>
                  <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-[#ef4444]" />{L('ไม่ผ่าน', 'fails')}</span>
                  <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-[#60a5fa]" />{L('เรดาร์', 'radar')}</span>
                  <label className="ml-auto flex items-center gap-1"><input type="checkbox" checked={onlyPass} onChange={(e) => setOnlyPass(e.target.checked)} />{L('ซ่อนภาพที่ไม่ผ่าน', 'hide failing')}</label>
                </div>
              </div>
              <p className="text-[10px] text-muted">{L(`คลิกจุดบนไทม์ไลน์เพื่อเลือกภาพ ${slot === 'A' ? '“ก่อน” (A)' : '“หลัง” (B)'} · ${list.length} ภาพ`, `Click a dot to set ${slot === 'A' ? 'BEFORE (A)' : 'AFTER (B)'} · ${list.length} scenes`)}</p>

              <div className="flex flex-wrap items-end gap-1">
                <Button disabled={!!busy} onClick={() => void pickLatest()} title={L('ตั้งภาพ “หลัง” (B) เป็นภาพใหม่ที่สุดในคลัง แม้มีเมฆ', 'Set AFTER (B) to the newest scene, even if cloudy')}>
                  {L('ภาพล่าสุดที่มี', 'Latest available')} ({d10(list[list.length - 1].datetime)})
                </Button>
                <Button disabled={!!busy} onClick={() => preset('week')}>{L('รายสัปดาห์', 'Weekly')}</Button>
                <Button disabled={!!busy} onClick={() => preset('month')}>{L('รายเดือน', 'Monthly')}</Button>
                <Button disabled={!!busy} onClick={() => preset('year')}>{L('รายปี', 'Yearly')}</Button>
                <div className="flex items-end gap-1">
                  <Field label={L('วันเหตุการณ์', 'Event date')}><Input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} className="!py-1 text-xs" /></Field>
                  <Button disabled={!!busy} onClick={() => preset('event')}>{L('ก่อน/หลังเหตุการณ์', 'Before/after event')}</Button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                {(['A', 'B'] as const).map((k) => {
                  const it = k === 'A' ? A : B;
                  const c = it ? cl[it.id] : undefined;
                  const chk = it ? check(it) : null;
                  const d = it ? sceneDates(it) : null;
                  return (
                    <button key={k} onClick={() => setSlot(k)} className={cx('rounded border p-1.5 text-left text-[10px]', slot === k ? 'border-cyan-400/70 bg-cyan-400/10' : 'border-line')}>
                      <div className="font-semibold text-white">{k === 'A' ? L('ก่อน (A)', 'Before (A)') : L('หลัง (B)', 'After (B)')}{it && <span className="ml-1 font-mono font-normal">{d10(d!.acquired)}</span>}</div>
                      {it ? (
                        <div className="space-y-0.5 text-slate-300">
                          {familyOf(it) === 'optical' ? (
                            <div>{L('เมฆ/เงาใน AOI', 'AOI cloud/shadow')}: {c && c !== 'err' ? `${c.cloudPct.toFixed(1)}% / ${c.shadowPct.toFixed(1)}%` : c === 'err' ? L('วัดไม่ได้', 'n/a') : '…'}</div>
                          ) : <div>{L('เรดาร์ (ไม่มีผลจากเมฆ)', 'Radar (no cloud effect)')}</div>}
                          {details && (
                            <>
                              <div>{L('ถ่ายภาพ', 'Acquired')}: <span className="font-mono text-white">{dt(d!.acquired)}</span></div>
                              <div>{L('ประมวลผล', 'Processed')}: <span className="font-mono">{dt(d!.processed)}</span></div>
                              <div>{L('เข้าคลัง', 'Catalogued')}: <span className="font-mono">{dt(d!.ingested)}</span></div>
                              <div>{sensorName(it)} · {gsdMeters(it)} ม.</div>
                              {familyOf(it) === 'optical' && <div>{L('เมฆรวมทั้งภาพ', 'Scene cloud')}: {it.cloudCover != null ? `${it.cloudCover.toFixed(1)}%` : '—'}</div>}
                              <div className="break-all text-[9px] text-muted">{it.id}</div>
                            </>
                          )}
                          {chk && !chk.ok && <div className="text-warn">{chk.pending ? L('ยังไม่ได้วัดเมฆใน AOI', 'AOI cloud not measured') : chk.reasons.join(' · ')}</div>}
                        </div>
                      ) : <div className="text-muted">{L('ยังไม่ได้เลือก', 'Not selected')}</div>}
                    </button>
                  );
                })}
              </div>
              <button className="text-[10px] text-muted hover:text-white" onClick={() => setDetails(!details)}>{details ? L('▴ ซ่อนรายละเอียดภาพ', '▴ Hide scene details') : L('▾ รายละเอียดภาพ (วันประมวลผล, เมฆรวม, รหัสภาพ)', '▾ Scene details')}</button>
              {pair && !pair.ok && <Notice tone="bad">{pair.reasons.join(' · ')}</Notice>}
              {!!pair?.notes.length && (details ? pair.notes.map((x) => <p key={x} className="text-[10px] text-warn">• {x}</p>) : <p className="text-[10px] text-warn">⚠ {L(`ข้อควรระวังในการเทียบ ${pair.notes.length} ข้อ`, `${pair.notes.length} comparison caveat(s)`)} — <button className="underline" onClick={() => setDetails(true)}>{L('ดู', 'show')}</button></p>)}
              {A && B && (checkScene(A, cl[A.id] === 'err' ? null : (cl[A.id] as AoiCloud | null | undefined), qc).reasons.length > 0 || checkScene(B, cl[B.id] === 'err' ? null : (cl[B.id] as AoiCloud | null | undefined), qc).reasons.length > 0) && (
                <Notice tone="warn">{L('ภาพที่เลือกไม่ผ่านเกณฑ์คุณภาพ ระบบจะไม่สรุปผลการเปลี่ยนแปลงจากคู่นี้ ให้เลือกวันอื่น (จุดสีเขียวบนไทม์ไลน์)', 'A selected scene fails the quality thresholds; no change conclusion will be made from this pair — pick another date (green dots)')}</Notice>
              )}
              <div className="flex flex-wrap gap-1.5">
                <Button variant="primary" disabled={!A || !B || !!busy || (pair ? !pair.ok : true)} onClick={run}>{L('เปรียบเทียบ A กับ B', 'Compare A with B')}</Button>
                <Button disabled={!A || !B || (pair ? !pair.ok : true)} onClick={() => A && B && onSwipe(A, B)}>{swipeOn ? L('ปิดเลื่อนเทียบภาพ', 'Close swipe') : L('เลื่อนเทียบภาพบนแผนที่', 'Swipe on map')}</Button>
                <Button disabled={!A || !!busy} onClick={trend}>{L('แนวโน้ม: A เทียบทุกภาพหลังจากนั้น', 'Trend: A vs each later scene')}</Button>
              </div>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- zoomable scene timeline

const DAYMS = 86400e3;
const TH_MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/**
 * Scene dots on a time axis. Zoom with the mouse wheel / pinch-free buttons / double-click, drag to pan,
 * quick ranges ending at the newest scene. Ticks switch from months to weeks to days as you zoom in.
 */
function SceneTimeline({
  items, t0, t1, rows, rowY, A, B, colour, tip, onPick,
}: {
  items: ImageryItem[];
  t0: number;
  t1: number;
  rows: { y: number; label: string }[];
  rowY: Record<string, number>;
  A: ImageryItem | null;
  B: ImageryItem | null;
  colour: (it: ImageryItem) => string;
  tip: (it: ImageryItem) => string;
  onPick: (it: ImageryItem) => void;
}) {
  const lang = useLang((s) => s.lang);
  const L = (th: string, en: string) => (lang === 'th' ? th : en);
  const [view, setView] = useState<[number, number] | null>(null);
  useEffect(() => setView(null), [t0, t1]);
  const v0 = view?.[0] ?? t0, v1 = view?.[1] ?? t1;
  const span = v1 - v0;
  const W = 400, PADL = 22, PADR = 6, IW = W - PADL - PADR;
  const X = (ms: number) => PADL + ((ms - v0) / Math.max(1, span)) * IW;
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; v: [number, number]; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const clampView = (a: number, b: number): [number, number] | null => {
    const minSpan = 3 * DAYMS, full = t1 - t0;
    let w = Math.min(full, Math.max(minSpan, b - a));
    if (w >= full - 1) return null;
    let s = a;
    if (s < t0) s = t0;
    if (s + w > t1) s = t1 - w;
    return [s, s + w];
  };
  const zoomAt = (frac: number, factor: number) => {
    const c = v0 + frac * span;
    const w = span * factor;
    setView(clampView(c - frac * w, c - frac * w + w));
  };
  const fracOf = (clientX: number) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return 0.5;
    const x = ((clientX - r.left) / r.width) * W;
    return Math.min(1, Math.max(0, (x - PADL) / IW));
  };

  // wheel needs a non-passive listener to stop the page from scrolling
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const f = fracOf(e.clientX);
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = ((e.deltaX || e.deltaY) / 400) * span;
        setView(clampView(v0 + d, v1 + d));
      } else zoomAt(f, e.deltaY > 0 ? 1.25 : 0.8);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    // capture only once it turns into a drag, so a plain click still reaches the dot under it
    drag.current = { x: e.clientX, v: [v0, v1], moved: false };
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    const r = svgRef.current?.getBoundingClientRect();
    if (!d || !r) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) > 3) {
      d.moved = true;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    }
    if (!d.moved) return;
    const dt = (-dx / r.width) * (W / IW) * (d.v[1] - d.v[0]);
    setView(clampView(d.v[0] + dt, d.v[1] + dt));
  };
  const onUp = (e: RPointerEvent<SVGSVGElement>) => {
    suppressClick.current = !!drag.current?.moved;
    drag.current = null;
    if ((e.currentTarget as Element).hasPointerCapture?.(e.pointerId)) (e.currentTarget as Element).releasePointerCapture(e.pointerId);
  };

  // ticks: months → weeks → days depending on the visible span
  const days = span / DAYMS;
  const ticks = useMemo(() => {
    const out: { x: number; t: string; major: boolean }[] = [];
    if (days > 75) {
      const d = new Date(v0);
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
      const stepM = days > 400 ? 2 : 1;
      while (d.getTime() <= v1) {
        if (d.getTime() >= v0) out.push({ x: X(d.getTime()), t: lang === 'th' ? `${TH_MON[d.getUTCMonth()]}${String(d.getUTCFullYear() + 543).slice(2)}` : `${d.getUTCMonth() + 1}/${String(d.getUTCFullYear()).slice(2)}`, major: d.getUTCMonth() === 0 });
        d.setUTCMonth(d.getUTCMonth() + stepM);
      }
    } else {
      const step = days > 28 ? 7 : days > 12 ? 2 : 1;
      const d = new Date(v0);
      d.setUTCHours(0, 0, 0, 0);
      if (step === 7) d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Mondays
      while (d.getTime() <= v1) {
        if (d.getTime() >= v0) out.push({ x: X(d.getTime()), t: `${d.getUTCDate()} ${lang === 'th' ? TH_MON[d.getUTCMonth()] : d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`, major: d.getUTCDate() === 1 });
        d.setUTCDate(d.getUTCDate() + step);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v0, v1, lang]);

  const visible = items.filter((it) => {
    const t = new Date(it.datetime).getTime();
    return t >= v0 && t <= v1;
  });
  const r = days < 20 ? 4.6 : days < 60 ? 3.8 : days < 150 ? 3.1 : 2.6;
  const newest = items.length ? Math.max(...items.map((x) => new Date(x.datetime).getTime())) : t1;
  const quick = (d: number) => setView(clampView(Math.min(newest + DAYMS, t1) - d * DAYMS, Math.min(newest + DAYMS, t1)));
  const fmt = (ms: number) => {
    const d = new Date(ms);
    return lang === 'th' ? `${d.getUTCDate()} ${TH_MON[d.getUTCMonth()]} ${String(d.getUTCFullYear() + 543).slice(2)}` : d.toISOString().slice(0, 10);
  };

  return (
    <>
      <div className="mb-1 flex flex-wrap items-center gap-1 px-1 text-[10px]">
        <button className="rounded border border-line px-1.5 text-slate-200 hover:border-cyan-400/50" onClick={() => zoomAt(0.5, 0.5)} title={L('ซูมเข้า', 'Zoom in')}>＋</button>
        <button className="rounded border border-line px-1.5 text-slate-200 hover:border-cyan-400/50 disabled:opacity-40" disabled={!view} onClick={() => zoomAt(0.5, 2)} title={L('ซูมออก', 'Zoom out')}>－</button>
        {[[14, L('2 สัปดาห์', '2 wk')], [30, L('1 เดือน', '1 mo')], [90, L('3 เดือน', '3 mo')]].map(([d, l]) => (
          <button key={d as number} className="rounded border border-line px-1.5 text-slate-300 hover:border-cyan-400/50" onClick={() => quick(d as number)}>{l}</button>
        ))}
        <button className="rounded border border-line px-1.5 text-slate-300 hover:border-cyan-400/50 disabled:opacity-40" disabled={!view} onClick={() => setView(null)}>{L('ทั้งหมด', 'All')}</button>
        <span className="ml-auto font-mono text-muted">{fmt(v0)} – {fmt(v1 - 1)} · {visible.length} {L('ภาพ', 'scenes')}</span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} 76`}
        className={cx('w-full touch-none select-none', view ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in')}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={(e) => zoomAt(fracOf(e.clientX), 0.4)}
      >
        <defs><clipPath id="tl-clip"><rect x={PADL - 6} y={0} width={IW + 12} height={76} /></clipPath></defs>
        {ticks.map((m, i) => (
          <g key={i}>
            <line x1={m.x} x2={m.x} y1={8} y2={58} stroke={m.major ? '#334155' : '#1e293b'} />
            <text x={m.x + 1} y={70} fontSize="6" fill={m.major ? '#94a3b8' : '#64748b'}>{m.t}</text>
          </g>
        ))}
        {rows.map((r0) => <text key={r0.label} x={1} y={r0.y + 2} fontSize="5.5" fill="#64748b">{r0.label}</text>)}
        <g clipPath="url(#tl-clip)">
          {visible.map((it) => {
            const sel = it.id === A?.id ? 'A' : it.id === B?.id ? 'B' : '';
            const x = X(new Date(it.datetime).getTime()), y = rowY[it.collection] ?? 18;
            return (
              <g
                key={it.id}
                onClick={() => {
                  if (suppressClick.current) return;
                  onPick(it);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
                className="cursor-pointer"
              >
                <title>{tip(it)}</title>
                <circle cx={x} cy={y} r={r + 3} fill="transparent" />
                <circle cx={x} cy={y} r={sel ? r + 1.6 : r} fill={colour(it)} stroke={sel ? '#fff' : '#0b1524'} strokeWidth={sel ? 1.2 : 0.5} />
                {sel && <text x={x} y={y - r - 3} fontSize="7" fill="#fff" textAnchor="middle" fontWeight="700">{sel}</text>}
                {days < 20 && !sel && <text x={x} y={y + r + 6} fontSize="4.5" fill="#94a3b8" textAnchor="middle">{new Date(it.datetime).getUTCDate()}</text>}
              </g>
            );
          })}
        </g>
      </svg>
      <p className="px-1 text-[9px] text-muted">{L('หมุนล้อเมาส์หรือดับเบิลคลิกเพื่อซูม · ลากเพื่อเลื่อน · ซูมใกล้จะเห็นวันที่ใต้จุด', 'Wheel or double-click to zoom · drag to pan · zoom in to see day numbers')}</p>
    </>
  );
}

export function QcPanel() {
  const L = useL();
  const { qc, setQc, unit, setUnit } = useQc();
  return (
    <Panel collapsible storeKey="qc" defaultOpen={false} title={L('เกณฑ์คุณภาพภาพและหน่วย', 'Quality thresholds & units')}>
      <div className="space-y-1.5 text-[11px] text-slate-200">
        <div>
          <div className="flex justify-between"><span>{L('ข้ามภาพที่เมฆรวมทั้งภาพเกิน', 'Skip scenes with whole-scene cloud over')}</span><b className="font-mono">{qc.maxSceneCloud}%</b></div>
          <input type="range" min={0} max={100} value={qc.maxSceneCloud} onChange={(e) => setQc({ maxSceneCloud: +e.target.value })} className="w-full" />
          <p className="text-[10px] text-muted">{L('ภาพหนึ่งภาพกว้าง ~110 กม. เมฆรวมสูงแต่พื้นที่ของเราอาจโปร่ง — ระบบตัดสินจากเมฆในพื้นที่ (AOI) เป็นหลัก ค่านี้ใช้แค่ข้ามภาพที่เมฆเกือบเต็มเพื่อประหยัดเวลา', 'A scene is ~110 km wide; it can be cloudy overall yet clear over your area — the AOI cloud decides, this only skips nearly fully clouded scenes to save time')}</p>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <Field label={L('เมฆ+เงาใน AOI ไม่เกิน', 'AOI cloud+shadow ≤')}>
            <Select value={qc.maxAoiCloud} onChange={(e) => setQc({ maxAoiCloud: +e.target.value })} className="!py-1 text-xs">{[5, 10, 20, 30, 50].map((v) => <option key={v} value={v}>{v}%</option>)}</Select>
          </Field>
          <Field label={L('พื้นที่วิเคราะห์ได้อย่างน้อย', 'Analysable ≥')}>
            <Select value={qc.minValidPct} onChange={(e) => setQc({ minValidPct: +e.target.value })} className="!py-1 text-xs">{[50, 70, 80, 90, 95].map((v) => <option key={v} value={v}>{v}%</option>)}</Select>
          </Field>
          <Field label={L('ความละเอียดหยาบสุด', 'Coarsest pixel')}>
            <Select value={qc.maxGsdM} onChange={(e) => setQc({ maxGsdM: +e.target.value })} className="!py-1 text-xs"><option value={10}>10 ม.</option><option value={30}>30 ม.</option></Select>
          </Field>
          <Field label={L('หน่วยพื้นที่หลัก', 'Primary area unit')}>
            <Select value={unit} onChange={(e) => setUnit(e.target.value as 'km2' | 'rai')} className="!py-1 text-xs"><option value="km2">{L('ตร.กม. (ไร่)', 'km² (rai)')}</option><option value="rai">{L('ไร่ (ตร.กม.)', 'rai (km²)')}</option></Select>
          </Field>
        </div>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={qc.allowCrossSensor} onChange={(e) => setQc({ allowCrossSensor: e.target.checked })} />{L('ยอมให้เทียบข้ามเซนเซอร์ (Sentinel-2 ↔ Landsat)', 'Allow cross-sensor (Sentinel-2 ↔ Landsat)')}</label>
        <p className="text-[10px] leading-relaxed text-muted">
          {L(
            'ใช้ทั้งการตรวจอัตโนมัติและการเลือกวันเอง · เมฆรวมมาจากแคตตาล็อก ส่วนเมฆในพื้นที่วัดจากหน้ากากเมฆของภาพ (Sentinel-2 SCL / Landsat QA_PIXEL) แยกเมฆ เงาเมฆ และไม่มีข้อมูล · เกณฑ์เหล่านี้เป็นตัวคัดกรอง ไม่ใช่หลักประกันว่าผลถูกต้องทั้งหมด · เรดาร์เทียบกับภาพปกติไม่ได้',
            'Applies to automatic and manual checks · scene cloud from the catalogue; AOI cloud from the image mask (S2 SCL / Landsat QA_PIXEL), separating cloud, shadow and no data · these are screening thresholds, not a guarantee · radar is never compared with optical',
          )}
        </p>
        <Badge tone="cyan">{L('1 ตร.กม. = 625 ไร่ · 1 ไร่ = 1,600 ตร.ม.', '1 km² = 625 rai · 1 rai = 1,600 m²')}</Badge>
      </div>
    </Panel>
  );
}
