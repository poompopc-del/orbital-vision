// Satellite imagery in three steps: ① choose the area → ② pick images on the timeline →
// ③ choose what to do with them (change analysis, swipe/blink, indices & flood, download/report/watch).
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLang } from '../i18n';
import { useSearchParams } from 'react-router-dom';
import GlobeHost from '../components/GlobeHost';
import AoiPicker from '../components/AoiPicker';
import { Button, Field, Notice, Select, Spinner, cx } from '../components/ui';
import { Cesium, flyToPolygon, getLabelsLayer, showAoi } from '../lib/cesium';
import { useWorkspace } from '../store';
import { areaKm2 } from '../lib/geo';
import { fmtArea } from '../lib/area';
import { useQc } from '../lib/qcStore';
import { aoiFromPolygon, compareScenes, getImage, PURPOSES, REGIONS, SATELLITES, type MonitorAoi, type MonitorRun, type Purpose, type Region, type SensorMode } from '../lib/monitor';
import { buildReportHtml } from '../lib/report';
import type { ImageryItem } from '../lib/stac';
import { ScenePicker, aoiKey, QcPanel, type PickerCtx } from '../components/monitor/ComparePanel';
import RunResult from '../components/monitor/RunResult';
import SwipeView from '../components/imagery/SwipeView';
import { GisCtx } from '../components/gis/GisContext';
import { useGisHost } from '../components/gis/useGisHost';
import { LegendBox } from '../components/gis/LayersPanel';
import SpectralPanel from '../components/gis/SpectralPanel';
import FloodPanel from '../components/gis/FloodPanel';
import SceneDownload from '../components/gis/SceneDownload';
import { imageProvider } from '../components/gis/sceneLayer';
import { useMonitor } from './Monitor';

const useL = () => {
  const lang = useLang((s) => s.lang);
  return (th: string, en: string) => (lang === 'th' ? th : en);
};
const d10 = (s?: string | null) => (s ? s.slice(0, 10) : '—');

type Mode = 'change' | 'view' | 'ndvi' | 'ndbi' | 'flood' | 'export';
const MODE_IDS: Mode[] = ['change', 'view', 'ndvi', 'ndbi', 'flood', 'export'];
/** modes that work with a single image */
const ONE_IMAGE: Mode[] = ['ndvi', 'ndbi', 'flood', 'export'];

function Step({ n, title, summary, open, onToggle, disabled, children }: { n: number; title: string; summary?: ReactNode; open: boolean; onToggle: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <section className={cx('rounded-md border bg-navy-900/90', open ? 'border-cyan-400/40' : 'border-line', disabled && 'opacity-50')}>
      <button type="button" disabled={disabled} onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <span className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold', open ? 'bg-cyan-400 text-ink-950' : 'border border-line text-slate-300')}>{n}</span>
        <span className="text-sm font-semibold text-white">{title}</span>
        <span className="ml-auto min-w-0 truncate text-right text-[11px] text-cyan-300">{summary}</span>
        <span className={cx('text-[10px] text-muted transition-transform', open && 'rotate-90')}>▶</span>
      </button>
      {/* kept mounted while folded so search results survive */}
      {!disabled && <div className={cx('border-t border-line p-3', !open && 'hidden')}>{children}</div>}
    </section>
  );
}

export default function ImageryFlow() {
  const L = useL();
  const lang = useLang((s) => s.lang);
  const { qc, unit } = useQc();
  const { aoi, setAoi } = useWorkspace();
  const { aois, setAois, addRun } = useMonitor();
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const g = useGisHost(viewer);
  const mapRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<1 | 2 | 3>(aoi ? 2 : 1);
  const [watchId, setWatchId] = useState<string | null>(null);
  const [pick, setPick] = useState<PickerCtx | null>(null);
  // ?start=<mode> (from the home page): that mode is opened as soon as the images allow it
  const [params] = useSearchParams();
  const startParam = params.get('start') as Mode | null;
  const wanted = useRef<Mode | null>(startParam && MODE_IDS.includes(startParam) ? startParam : null);
  const [mode, setModeS] = useState<Mode | null>(null);
  const setMode = (m: Mode | null) => {
    wanted.current = m;
    setModeS(m);
  };
  const [sideOpen, setSideOpen] = useState(true);

  const akey = useMemo(() => (aoi ? aoiKey(aoi.geometry) : ''), [aoi?.geometry]);
  const watch = aois.find((a) => a.id === watchId && aoiKey(a.geometry) === akey) ?? aois.find((a) => aoiKey(a.geometry) === akey) ?? null;
  const A = pick?.A ?? null, B = pick?.B ?? null;

  // area changed: show it, reset the picked images and the results drawn for the old area
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    showAoi(viewer, aoi?.geometry ?? null, 'flow-aoi');
    viewer.scene.requestRender();
  }, [viewer, aoi?.geometry]);
  useEffect(() => {
    setPick(null);
    setModeS(null); // the chosen mode (wanted) is kept and reopened for the new area
    g.layers.forEach((l) => g.removeLayer(l.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [akey]);
  // the GIS panels read the scenes from the shared context
  useEffect(() => {
    g.setSceneA(A);
    g.setSceneB(B);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [A?.id, B?.id]);
  // move on to step 3 when the images are enough for the chosen mode (both, or one for single-image modes)
  useEffect(() => {
    const w = wanted.current;
    const enough = A && B ? true : !!(A || B) && !!w && ONE_IMAGE.includes(w);
    if (!enough) return;
    if (step === 2 && (A && B ? true : !!w)) setStep(3);
    if (w && !mode) setModeS(w);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [A?.id, B?.id]);
  // place names / old borders would sit over the images while comparing
  const viewing = mode === 'view' && !!A && !!B;
  useEffect(() => {
    if (!viewer) return;
    const lab = getLabelsLayer(viewer);
    if (lab) lab.show = !viewing;
    const e = viewer.entities.getById('flow-aoi');
    if (e?.polygon) e.polygon.show = new Cesium.ConstantProperty(!viewing);
    viewer.scene.requestRender();
  }, [viewer, viewing]);

  const fromWatch = (id: string) => {
    const a = aois.find((x) => x.id === id);
    if (!a) return;
    setWatchId(a.id);
    setAoi({ geometry: a.geometry, name: a.name, source: 'import' });
    if (viewer && !viewer.isDestroyed()) flyToPolygon(viewer, a.geometry);
    setStep(2);
  };

  return (
    <GisCtx.Provider value={g}>
      <div className="flex h-full flex-col lg:flex-row">
        <aside className={cx('w-full shrink-0 flex-col gap-2 overflow-y-auto border-line p-3 scroll-thin lg:w-[440px] lg:border-r', sideOpen ? 'flex' : 'hidden')}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-white">{L('ภาพดาวเทียม', 'Satellite imagery')}</h2>
              <p className="text-[11px] text-muted">{L('เลือกพื้นที่ → เลือกภาพ → เลือกว่าจะทำอะไรต่อ', 'Choose an area → pick images → choose what to do')}</p>
            </div>
            <button onClick={() => setSideOpen(false)} className="shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-slate-300 hover:text-white">« {L('ซ่อนแผง', 'Hide')}</button>
          </div>

          {/* ① area */}
          <Step n={1} title={L('พื้นที่', 'Area')} summary={aoi ? `${aoi.name.slice(0, 28)} · ${fmtArea(areaKm2(aoi.geometry), unit, lang === 'th')}` : L('ยังไม่ได้เลือก', 'not chosen')} open={step === 1} onToggle={() => setStep(step === 1 && aoi ? 2 : 1)}>
            {aois.length > 0 && (
              <Field label={L('เลือกจากรายการเฝ้าระวัง', 'From the watchlist')}>
                <Select value={watch?.id ?? ''} onChange={(e) => e.target.value && fromWatch(e.target.value)}>
                  <option value="">{L(`— เลือก (${aois.length} พื้นที่) —`, `— choose (${aois.length}) —`)}</option>
                  {aois.map((a, i) => <option key={a.id} value={a.id}>{i + 1}. {a.name}</option>)}
                </Select>
              </Field>
            )}
            <div className="my-2 text-center text-[10px] text-muted">{L('หรือ วาด / ค้นหาสถานที่ / พิมพ์พิกัด / นำเข้าไฟล์', 'or draw / search a place / type coordinates / import a file')}</div>
            <AoiPicker viewer={viewer} compact />
            {aoi && <Button variant="primary" className="mt-2 w-full" onClick={() => setStep(2)}>{L('ถัดไป: เลือกภาพ →', 'Next: pick images →')}</Button>}
          </Step>

          {/* ② images */}
          <Step
            n={2}
            title={L('เลือกภาพ', 'Images')}
            summary={A || B ? `A ${d10(A?.datetime)} · B ${d10(B?.datetime)}` : undefined}
            open={step === 2}
            onToggle={() => setStep(step === 2 ? (A && B ? 3 : 2) : 2)}
            disabled={!aoi}
          >
            {aoi && (
              <div className="space-y-2">
                {wanted.current && <StartHint mode={wanted.current} />}
                <ScenePicker key={akey} geometry={aoi.geometry} panel={false} onPair={setPick} />
                <details className="rounded border border-line text-[11px]">
                  <summary className="cursor-pointer px-2 py-1 text-muted hover:text-white">{L('เกณฑ์คุณภาพภาพ (เมฆ, ความละเอียด)', 'Quality thresholds (cloud, resolution)')}</summary>
                  <div className="p-1"><QcPanel /></div>
                </details>
              </div>
            )}
          </Step>

          {/* ③ what next */}
          <Step n={3} title={L('ทำอะไรต่อ', 'What next')} summary={mode ? MODES(L).find((m) => m.id === mode)?.label : undefined} open={step === 3} onToggle={() => setStep(step === 3 ? 2 : 3)} disabled={!aoi || !(A || B)}>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-2">
              {MODES(L).map((m) => {
                const need = ONE_IMAGE.includes(m.id) ? !!(A || B) : !!(A && B);
                return (
                  <button
                    key={m.id}
                    disabled={!need}
                    onClick={() => setMode(m.id)}
                    className={cx('rounded border p-2 text-left transition disabled:opacity-40', mode === m.id ? 'border-cyan-400 bg-cyan-400/10' : 'border-line hover:border-cyan-400/50')}
                  >
                    <div className="text-sm">{m.icon} <span className="font-semibold text-white">{m.label}</span></div>
                    <div className="mt-0.5 text-[10px] leading-snug text-muted">{m.desc}</div>
                  </button>
                );
              })}
            </div>
            {mode && <div className="mt-3 border-t border-line pt-3">{aoi && pick && <ModeBody mode={mode} pick={pick} watch={watch} onWatch={(a) => { setAois((l) => [...l, a]); setWatchId(a.id); }} addRun={addRun} />}</div>}
          </Step>
        </aside>

        <div ref={mapRef} className="relative min-h-[360px] flex-1">
          <GlobeHost onReady={setViewer} />
          {!sideOpen && (
            <button onClick={() => setSideOpen(true)} className="absolute left-3 top-3 z-20 rounded-md border border-line bg-ink-950/85 px-2 py-1 text-[11px] text-cyan-300 hover:text-white">
              » {L('แผงควบคุม', 'Panel')}
            </button>
          )}
          {viewing && A && B && <SwipeView viewer={viewer} A={A} B={B} containerRef={mapRef} onClose={() => setMode(null)} />}
          {!viewing && (
            <div className="absolute bottom-8 left-3 z-10 max-w-[280px]">
              <LegendBox />
            </div>
          )}
          {!aoi && (
            <div className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-md border border-line bg-ink-950/85 px-3 py-1.5 text-xs text-slate-200">
              {L('เริ่มที่ ① เลือกพื้นที่ทางซ้าย', 'Start with ① choose an area on the left')}
            </div>
          )}
        </div>
      </div>
    </GisCtx.Provider>
  );
}

function StartHint({ mode }: { mode: Mode }) {
  const L = useL();
  const t: Record<Mode, [string, string]> = {
    change: ['เลือกภาพ A (ก่อน) และ B (หลัง) — จุดสีเขียวคือภาพที่ผ่านเกณฑ์เมฆ', 'Pick A (before) and B (after) — green dots pass the cloud check'],
    view: ['เลือกภาพ A และ B ที่ต้องการดูเทียบกัน', 'Pick the A and B images to look at'],
    flood: ['น้ำท่วมมักมีเมฆ: ติ๊ก “Sentinel-1 เรดาร์” แล้วค้นหา จากนั้นใส่วันเหตุการณ์และกด “ก่อน/หลังเหตุการณ์” (ภาพเดียวก็ได้)', 'Floods are cloudy: tick “Sentinel-1 radar”, search, then set the event date and use “Before/after event” (one image also works)'],
    ndvi: ['เลือกภาพเดียวก็ได้ — กด “ภาพล่าสุดที่มี” หรือคลิกจุดสีเขียว', 'One image is enough — use “Latest available” or click a green dot'],
    ndbi: ['เทียบการขยายตัวเมือง: ตั้งช่วงค้นหา 2 ปี แล้วกด “รายปี”', 'Urban growth: search over 2 years, then use “Yearly”'],
    export: ['เลือกภาพที่ต้องการ — กด “ภาพล่าสุดที่มี” เพื่อได้ภาพใหม่ที่สุด', 'Pick the image(s) — “Latest available” gives the newest one'],
  };
  return <p className="rounded border border-cyan-400/30 bg-cyan-400/5 px-2 py-1 text-[10px] text-cyan-200">💡 {L(...t[mode])}</p>;
}

const MODES = (L: (a: string, b: string) => string): { id: Mode; icon: string; label: string; desc: string }[] => [
  { id: 'change', icon: '🔍', label: L('เทียบการเปลี่ยนแปลง', 'Change analysis'), desc: L('ถางป่า สิ่งปลูกสร้าง น้ำ ไฟ — ได้พื้นที่ ไร่/ตร.กม. และพิกัดจุดที่เปลี่ยน', 'Clearing, construction, water, fire — areas in rai/km² and patch locations') },
  { id: 'view', icon: '◐', label: L('เลื่อน / กะพริบดู', 'Swipe / blink'), desc: L('ดูภาพ A กับ B ด้วยตา บนแผนที่แบบไม่มีอะไรบัง', 'Look at A and B on a clear map') },
  { id: 'flood', icon: '🌊', label: L('น้ำท่วม', 'Flood'), desc: L('ขอบเขตน้ำจากภาพหลัง (และก่อน) — เรดาร์มองทะลุเมฆ', 'Water extent from the after (and before) image — radar sees through cloud') },
  { id: 'ndvi', icon: '🌾', label: L('พืชพรรณ (NDVI)', 'Vegetation (NDVI)'), desc: L('ความเขียว/สุขภาพพืช พร้อมสถิติในพื้นที่ (และดัชนีอื่น)', 'Greenness / plant health with area statistics (and other indices)') },
  { id: 'ndbi', icon: '🏙', label: L('การขยายตัวเมือง (NDBI)', 'Urban growth (NDBI)'), desc: L('พื้นที่สิ่งปลูกสร้าง — เลือกภาพห่างกัน 1–2 ปี', 'Built-up surfaces — pick images 1–2 years apart') },
  { id: 'export', icon: '📷', label: L('ภาพ · รายงาน · เฝ้าระวัง', 'Images · report · watch'), desc: L('ดาวน์โหลดภาพ (GeoTIFF/PNG) ออกรายงาน หรือเพิ่มเข้าการตรวจอัตโนมัติ', 'Download images (GeoTIFF/PNG), make a report, or add to automatic checks') },
];

function ModeBody({ mode, pick, watch, onWatch, addRun }: { mode: Mode; pick: PickerCtx; watch: MonitorAoi | null; onWatch: (a: MonitorAoi) => void; addRun: (r: MonitorRun) => void }) {
  const L = useL();
  const lang = useLang((s) => s.lang);
  const { qc, unit } = useQc();
  const { aoi } = useWorkspace();
  const g = useContext(GisCtx);
  const [purpose, setPurpose] = useState<Purpose>(watch?.purpose ?? 'clearing');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [run, setRun] = useState<MonitorRun | null>(null);
  const [freq, setFreq] = useState(7);
  const [region, setRegion] = useState<Region>('TH');
  const [sat, setSat] = useState<SensorMode>('auto');
  const abort = useRef<AbortController | null>(null);
  const { A, B } = pick;
  const target: MonitorAoi | null = !aoi ? null : watch ? { ...watch, purpose } : { ...aoiFromPolygon(aoi.name, aoi.geometry, 'TH', purpose), id: `adhoc_${aoiKey(aoi.geometry)}` };
  // a new pair of images makes the old result stale
  useEffect(() => setRun(null), [A?.id, B?.id]);

  // result overlay on the map
  useEffect(() => {
    if (!run || run.status !== 'ok' || !run.overlayBounds || !g) return;
    let dead = false;
    void getImage(`${run.id}:change`).then(async (url) => {
      if (!url || dead) return;
      const b = run.overlayBounds!;
      const prov = await imageProvider(url, b.west, b.south, b.east, b.north);
      if (dead) return;
      g.putImagery('change-result', L('ผลการเปลี่ยนแปลง', 'Change result'), prov, { alpha: 0.85, legend: { items: (run.legend ?? []).map((l) => ({ color: l.color, label: L(l.labelTh, l.label) })) }, meta: `${d10(run.A?.datetime)} → ${d10(run.B?.datetime)}` });
    });
    return () => {
      dead = true;
      g.removeLayer('change-result');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id]);

  if (!aoi || !target) return null;

  const analyse = async () => {
    if (!A || !B) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setErr('');
    setRun(null);
    try {
      const r = await compareScenes(target, A, B, (m) => setBusy(m), ac.signal, { qc, clA: pick.cloudOf(A), clB: pick.cloudOf(B), mode: 'manual' });
      setRun(r);
      if (watch) addRun(r);
    } catch (e: any) {
      if (e?.name !== 'AbortError') setErr(e?.message ?? String(e));
    } finally {
      setBusy('');
    }
  };

  const report = async () => {
    if (!run) return;
    try {
      const html = await buildReportHtml({
        title: L('รายงานการเปลี่ยนแปลงพื้นที่จากภาพดาวเทียม', 'Satellite Area Change Assessment'),
        lang,
        requirement: L(`ตรวจการเปลี่ยนแปลงพื้นที่ ${target.name} จากภาพ ${d10(run.A?.datetime)} และ ${d10(run.B?.datetime)}`, `Change in ${target.name} between ${d10(run.A?.datetime)} and ${d10(run.B?.datetime)}`),
        items: [{ aoi: target, run }],
        unit,
      });
      const w = window.open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank');
      if (!w) setErr(L('เบราว์เซอร์บล็อกหน้าต่างใหม่ — อนุญาตป๊อปอัปแล้วลองอีกครั้ง', 'Pop-up blocked — allow pop-ups and try again'));
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  };

  if (mode === 'view')
    return (
      <div className="space-y-1 text-[11px] text-slate-300">
        <p>{L('กำลังแสดงภาพ A กับ B บนแผนที่ — ซ่อนชื่อสถานที่และกรอบไว้ให้ดูภาพได้ชัด', 'A and B are on the map — place names and fills are hidden')}</p>
        <ul className="list-disc pl-4 text-[10px] text-muted">
          <li>{L('ลากปุ่ม ◀▶ บนเส้นแบ่งเพื่อเลื่อนเทียบ', 'Drag ◀▶ on the split line')}</li>
          <li>{L('“กะพริบ” สลับภาพให้เอง จุดที่เปลี่ยนจะเห็นชัด', '“Blink” alternates the images so changes stand out')}</li>
        </ul>
        {pick.pair && !pick.pair.ok && <p className="text-[10px] text-warn">{pick.pair.reasons.join(' · ')} — {L('ดูด้วยตาได้ แต่ไม่ใช่การวิเคราะห์', 'fine to look at, not an analysis')}</p>}
      </div>
    );

  if (mode === 'ndvi' || mode === 'ndbi' || mode === 'flood')
    return (
      <div className="space-y-2">
        <p className="text-[10px] text-muted">{L(`ใช้ภาพที่เลือกไว้: A ${d10(A?.datetime)} · B ${d10(B?.datetime)}`, `Uses the picked images: A ${d10(A?.datetime)} · B ${d10(B?.datetime)}`)}</p>
        {mode === 'flood' ? <FloodPanel /> : <SpectralPanel key={mode} initialIndex={mode} />}
      </div>
    );

  if (mode === 'export')
    return (
      <div className="space-y-3 text-[11px]">
        <div>
          <div className="label mb-1">{L('ดาวน์โหลดภาพ', 'Download images')}</div>
          {[['A', A], ['B', B]].map(([k, it]) => it && (
            <div key={k as string} className="mb-1.5 rounded border border-line p-1.5">
              <div className="mb-1 text-slate-200">{k} · {d10((it as ImageryItem).datetime)} · {(it as ImageryItem).collectionLabel}</div>
              <SceneDownload item={it as ImageryItem} compact />
            </div>
          ))}
        </div>
        <div>
          <div className="label mb-1">{L('รายงาน', 'Report')}</div>
          {run ? <Button onClick={report}>{L('เปิดรายงาน (พิมพ์/บันทึกเป็น PDF ได้)', 'Open report (print / save as PDF)')}</Button> : <p className="text-[10px] text-muted">{L('ทำ “เทียบการเปลี่ยนแปลง” ก่อน แล้วกลับมาออกรายงาน', 'Run “Change analysis” first, then make the report')}</p>}
        </div>
        <div>
          <div className="label mb-1">{L('เฝ้าระวังอัตโนมัติ', 'Automatic watch')}</div>
          {watch ? (
            <p className="text-ok">✓ {L(`พื้นที่นี้อยู่ในรายการเฝ้าระวังแล้ว (${watch.name}) — ดูได้ที่แท็บ “รายการเฝ้าระวัง”`, `Already in the watchlist (${watch.name}) — see the “Area watchlist” tab`)}</p>
          ) : (
            <div className="space-y-1.5">
              <div className="grid grid-cols-2 gap-1.5">
                <Field label={L('สิ่งที่เฝ้าดู', 'Watch for')}><Select value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>{PURPOSES.map((p) => <option key={p.id} value={p.id}>{L(p.labelTh, p.label)}</option>)}</Select></Field>
                <Field label={L('รอบตรวจ', 'Cycle')}><Select value={freq} onChange={(e) => setFreq(+e.target.value)}>{[7, 14, 30].map((d) => <option key={d} value={d}>{L(`ทุก ${d} วัน`, `every ${d} days`)}</option>)}</Select></Field>
                <Field label={L('พื้นที่', 'Region')}><Select value={region} onChange={(e) => setRegion(e.target.value as Region)}>{REGIONS.map((r) => <option key={r.id} value={r.id}>{L(r.labelTh, r.label)}</option>)}</Select></Field>
                <Field label={L('ดาวเทียม', 'Satellite')}><Select value={sat} onChange={(e) => setSat(e.target.value as SensorMode)}>{SATELLITES.map((x) => <option key={x.id} value={x.id}>{L(x.th, x.en)}</option>)}</Select></Field>
              </div>
              <Button
                variant="primary"
                className="w-full"
                onClick={() => {
                  const a = aoiFromPolygon(aoi.name, aoi.geometry, region, purpose, freq, sat);
                  onWatch(a);
                  if (run) addRun({ ...run, aoiId: a.id, aoiName: a.name });
                }}
              >
                {L('เพิ่มเข้ารายการเฝ้าระวัง', 'Add to the watchlist')}
              </Button>
            </div>
          )}
        </div>
        {err && <p className="text-[10px] text-bad">{err}</p>}
      </div>
    );

  // change analysis
  return (
    <div className="space-y-2">
      <Field label={L('สิ่งที่ต้องการหา', 'Look for')}>
        <Select value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>{PURPOSES.map((p) => <option key={p.id} value={p.id}>{L(p.labelTh, p.label)}</option>)}</Select>
      </Field>
      <p className="text-[10px] text-muted">{PURPOSES.find((p) => p.id === purpose)?.hint}</p>
      {!pick.pairOk && (
        <Notice tone="warn">
          {pick.pair && !pick.pair.ok ? pick.pair.reasons.join(' · ') : L('ภาพที่เลือกยังไม่ผ่านเกณฑ์คุณภาพ (เมฆ/ยังไม่ได้วัดเมฆ) — เลือกจุดสีเขียวในขั้นที่ 2 เพื่อให้ผลเชื่อถือได้', 'A picked image does not pass the quality thresholds yet (cloud / not measured) — pick green dots in step 2')}
        </Notice>
      )}
      <div className="flex gap-1.5">
        <Button variant="primary" className="flex-1" disabled={!A || !B || !!busy || !pick.pair?.ok} onClick={analyse}>
          {busy ? <Spinner /> : null} {L('วิเคราะห์การเปลี่ยนแปลง A → B', 'Analyse change A → B')}
        </Button>
        {busy && <Button variant="danger" onClick={() => abort.current?.abort()}>{L('หยุด', 'Stop')}</Button>}
      </div>
      {busy && <p className="text-[10px] text-cyan-300">{busy}</p>}
      {err && <p className="text-[10px] text-bad">{err}</p>}
      {run && <RunResult run={run} />}
      {run && !watch && <p className="text-[10px] text-muted">{L('ผลนี้ยังไม่ได้บันทึกในรายการเฝ้าระวัง — ไปที่ “ดาวน์โหลด · รายงาน · เฝ้าระวัง” เพื่อออกรายงานหรือเพิ่มพื้นที่นี้', 'Not saved to the watchlist — use “Download · report · watch” to make a report or add this area')}</p>}
    </div>
  );
}
