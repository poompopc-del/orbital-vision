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
import type { GisApi, LayerEntry } from '../components/gis/GisContext';
import SpectralPanel from '../components/gis/SpectralPanel';
import FloodPanel from '../components/gis/FloodPanel';
import SceneDownload from '../components/gis/SceneDownload';
import { imageProvider } from '../components/gis/sceneLayer';
import { outlineDataUrl } from '../lib/outline';
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
    showAoi(viewer, aoi?.geometry ?? null, 'flow-aoi', aoi?.center);
    viewer.scene.requestRender();
  }, [viewer, aoi?.geometry, aoi?.center?.join(',')]);
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
              <p className="text-[11px] text-muted">{L('เลือกพื้นที่ → เลือกภาพ → เลือกการวิเคราะห์', 'Choose an area → pick images → choose an analysis')}</p>
            </div>
            <button onClick={() => setSideOpen(false)} className="shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-slate-300 hover:text-white">« {L('ซ่อนแผง', 'Hide panel')}</button>
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
            <AoiPicker
              viewer={viewer}
              compact
              onMany={async (places) => {
                const { placePolygon } = await import('../lib/coordImport');
                const now = Date.now().toString(36);
                const added = places.map((p, i) => ({ ...aoiFromPolygon(p.name, placePolygon(p, 2), 'TH', 'clearing', 7, 'auto'), id: `aoi_${now}_f${i.toString(36)}` }));
                setAois((l) => [...l, ...added]);
                if (added[0]) {
                  setWatchId(added[0].id);
                  setAoi({ geometry: added[0].geometry, name: added[0].name, source: 'import' });
                  setStep(2);
                }
              }}
            />
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
          <Step n={3} title={L('เลือกการวิเคราะห์', 'Analysis')} summary={mode ? MODES(L).find((m) => m.id === mode)?.label : undefined} open={step === 3} onToggle={() => setStep(step === 3 ? 2 : 3)} disabled={!aoi || !(A || B)}>
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
                    <div className="flex items-start gap-1 text-sm">
                      <span>{m.icon} <span className="font-semibold text-white">{m.label}</span></span>
                      {layersOfMode(g.layers, m.id).length > 0 && <span className="ml-auto shrink-0 rounded bg-ok/15 px-1 text-[9px] font-normal text-ok" title={L('ผลของโหมดนี้แสดงอยู่บนแผนที่', 'This mode’s result is on the map')}>● {L('แสดงอยู่', 'on map')}</span>}
                    </div>
                    <div className="mt-0.5 text-[10px] leading-snug text-muted">{m.desc}</div>
                  </button>
                );
              })}
            </div>
            {mode && (() => {
              const others = g.layers.filter((l) => l.show && modeOfLayer(l) && modeOfLayer(l) !== mode && !(mode === 'ndvi' || mode === 'ndbi' ? modeOfLayer(l) === 'ndvi' || modeOfLayer(l) === 'ndbi' : false) && !(mode === 'view' && modeOfLayer(l) === 'change'));
              if (!others.length) return null;
              return (
                <div className="mt-2 flex items-center gap-2 rounded border border-warn/40 bg-warn/5 px-2 py-1.5 text-[10px] text-warn">
                  <span className="flex-1">{L(`ผลจากงานก่อนหน้ายังซ้อนอยู่บนแผนที่: ${others.map((l) => modeName(L, l)).join(', ')}`, `Earlier results are still on the map: ${others.map((l) => modeName(L, l)).join(', ')}`)}</span>
                  <button className="shrink-0 rounded border border-warn/50 px-1.5 py-0.5 hover:bg-warn/10" onClick={() => others.forEach((l) => g.setLayer(l.id, { show: false }))}>{L('ซ่อน', 'Hide')}</button>
                  <button className="shrink-0 rounded border border-warn/50 px-1.5 py-0.5 hover:bg-warn/10" onClick={() => others.forEach((l) => g.removeLayer(l.id))}>{L('ลบ', 'Remove')}</button>
                </div>
              );
            })()}
            {mode && <div className="mt-3 border-t border-line pt-3">{aoi && pick && <ModeBody mode={mode} pick={pick} watch={watch} onWatch={(a) => { setAois((l) => [...l, a]); setWatchId(a.id); }} addRun={addRun} onMode={setMode} />}</div>}
          </Step>
        </aside>

        <div ref={mapRef} className="relative min-h-[360px] flex-1">
          <GlobeHost onReady={setViewer} />
          {!sideOpen && (
            <button onClick={() => setSideOpen(true)} className="absolute left-3 top-3 z-20 rounded-md border border-line bg-ink-950/85 px-2 py-1 text-[11px] text-cyan-300 hover:text-white">
              » {L('แผงควบคุม', 'Panel')}
            </button>
          )}
          {viewing && A && B && <SwipeView viewer={viewer} A={A} B={B} containerRef={mapRef} onClose={() => setMode(null)} g={g} />}
          {!viewing && <OnMap g={g} />}
          {!aoi && (
            <div className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-md border border-line bg-ink-950/85 px-3 py-1.5 text-xs text-slate-200">
              {L('เริ่มจาก ① เลือกพื้นที่ทางซ้าย', 'Start with ① choose an area on the left')}
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
  { id: 'change', icon: '🔍', label: L('ตรวจจับการเปลี่ยนแปลง', 'Change detection'), desc: L('ถางป่า สิ่งปลูกสร้าง น้ำ ไฟ · ได้พื้นที่ (ไร่/ตร.กม.) และพิกัดจุดที่เปลี่ยน', 'Clearing, construction, water, fire — areas in rai/km² and patch locations') },
  { id: 'view', icon: '◐', label: L('เลื่อนเทียบ / สลับภาพ', 'Swipe / blink'), desc: L('ดูภาพ A กับ B ด้วยตา · เปิด/ปิดผลตรวจจับซ้อนบนภาพได้', 'Inspect A and B visually · toggle the change result over them') },
  { id: 'flood', icon: '🌊', label: L('น้ำท่วม', 'Flood'), desc: L('ขอบเขตน้ำจากภาพหลัง (และภาพก่อน) · เรดาร์มองทะลุเมฆ', 'Water extent from the after (and before) image — radar sees through cloud') },
  { id: 'ndvi', icon: '🌾', label: L('พืชพรรณ (NDVI)', 'Vegetation (NDVI)'), desc: L('ความเขียวและสุขภาพพืช พร้อมสถิติของพื้นที่ (และดัชนีอื่น)', 'Greenness / plant health with area statistics (and other indices)') },
  { id: 'ndbi', icon: '🏙', label: L('การขยายตัวของเมือง (NDBI)', 'Urban growth (NDBI)'), desc: L('พื้นที่สิ่งปลูกสร้าง · เลือกภาพที่ห่างกัน 1–2 ปี', 'Built-up surfaces — pick images 1–2 years apart') },
  { id: 'export', icon: '📷', label: L('ภาพ · รายงาน · เฝ้าระวัง', 'Images · report · watch'), desc: L('ดาวน์โหลดภาพ (GeoTIFF/PNG) ออกรายงาน หรือเพิ่มเข้าการตรวจอัตโนมัติ', 'Download images (GeoTIFF/PNG), make a report, or add to automatic checks') },
];

function ModeBody({ mode, pick, watch, onWatch, addRun, onMode }: { mode: Mode; pick: PickerCtx; watch: MonitorAoi | null; onWatch: (a: MonitorAoi) => void; addRun: (r: MonitorRun) => void; onMode: (m: Mode) => void }) {
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
      const meta = `${d10(run.A?.datetime)} → ${d10(run.B?.datetime)}`;
      g.putImagery('change-result', L('ผลการเปลี่ยนแปลง', 'Change result'), prov, { alpha: 0.85, legend: { items: (run.legend ?? []).map((l) => ({ color: l.color, label: L(l.labelTh, l.label) })) }, meta });
      // numbered spots (vector): what the result table lists, clickable / navigable in the swipe view
      if (run.hotspots?.length) {
        const ds = new Cesium.CustomDataSource('change-spots');
        for (const h of run.hotspots) {
          const col = Cesium.Color.fromCssColorString(run.legend?.find((x) => x.id === h.cls)?.color ?? '#ef4444');
          ds.entities.add({
            id: `spot-${h.n}`,
            position: Cesium.Cartesian3.fromDegrees(h.lon, h.lat),
            point: { pixelSize: 7, color: col, outlineColor: Cesium.Color.WHITE, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
            label: {
              text: `${h.n}`, font: '600 12px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -14), disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            properties: { n: h.n, lengthKm: h.shape === 'linear' ? h.lengthKm ?? null : null, km2: h.areaKm2 ?? h.areaHa / 100 },
          });
        }
        g.putDataSource('change-spots', L('หมายเลขจุดที่เปลี่ยน', 'Change spot numbers'), ds, { meta });
      }
      // outline version (kept hidden; the swipe view switches fill ↔ outline)
      const edge = await outlineDataUrl(url).catch(() => null);
      if (!edge || dead) return;
      const eprov = await imageProvider(edge, b.west, b.south, b.east, b.north);
      if (dead) return;
      g.putImagery('change-outline', L('ขอบเขตการเปลี่ยนแปลง (เส้นขอบ)', 'Change outline'), eprov, { alpha: 1, meta });
      g.setLayer('change-outline', { show: false });
    });
    return () => {
      dead = true;
      ['change-result', 'change-outline', 'change-spots'].forEach((id) => g.removeLayer(id));
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
    // open the tab inside the click, before any await, so the browser does not treat it as a pop-up
    const w = window.open('', '_blank');
    if (w) w.document.write(`<p style="font:16px sans-serif;padding:24px">${L('กำลังสร้างรายงาน…', 'Building the report…')}</p>`);
    try {
      const html = await buildReportHtml({
        title: L('รายงานการเปลี่ยนแปลงพื้นที่จากภาพดาวเทียม', 'Satellite Area Change Assessment'),
        lang,
        requirement: L(`ตรวจการเปลี่ยนแปลงพื้นที่ ${target.name} จากภาพ ${d10(run.A?.datetime)} และ ${d10(run.B?.datetime)}`, `Change in ${target.name} between ${d10(run.A?.datetime)} and ${d10(run.B?.datetime)}`),
        items: [{ aoi: target, run }],
        unit,
      });
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      if (w) w.location.href = url;
      else if (!window.open(url, '_blank')) setErr(L('เบราว์เซอร์บล็อกหน้าต่างใหม่ — อนุญาตป๊อปอัปแล้วลองอีกครั้ง', 'Pop-up blocked — allow pop-ups and try again'));
    } catch (e: any) {
      w?.close();
      setErr(e?.message ?? String(e));
    }
  };

  if (mode === 'view')
    return (
      <div className="space-y-1 text-[11px] text-slate-300">
        <p>{L('แสดงภาพ A กับ B บนแผนที่แล้ว · ซ่อนชื่อสถานที่และพื้นสีไว้ให้ดูภาพได้ชัด', 'A and B are on the map — place names and fills are hidden')}</p>
        <ul className="list-disc pl-4 text-[10px] text-muted">
          <li>{L('ลากปุ่ม ◀▶ บนเส้นแบ่งเพื่อเลื่อนเทียบ', 'Drag ◀▶ on the split line')}</li>
          <li>{L('“กะพริบ” สลับภาพให้เอง จุดที่เปลี่ยนจะเห็นชัด', '“Blink” alternates the images so changes stand out')}</li>
          <li>{run?.status === 'ok'
            ? L('ผลตรวจจับการเปลี่ยนแปลงซ้อนอยู่บนภาพ · เปิด/ปิด สลับเติมสี/เส้นขอบ และกด ◀ ▶ ไล่ดูทีละจุดได้ที่แถบล่าง', 'The change result is drawn over the images · toggle it, switch fill/outline and step through spots with ◀ ▶ in the bottom bar')
            : L('ทำ “ตรวจจับการเปลี่ยนแปลง” ก่อน ผลจะซ้อนบนภาพที่เลื่อนเทียบ และเปิด/ปิดได้', 'Run “Change detection” first and its result appears over the swipe, with a toggle')}</li>
        </ul>
        {pick.pair && !pick.pair.ok && <p className="text-[10px] text-warn">{pick.pair.reasons.join(' · ')} — {L('ใช้ดูด้วยตาได้ แต่ไม่ใช่การวิเคราะห์', 'fine for visual inspection, not an analysis')}</p>}
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
          {run ? <Button onClick={report}>{L('เปิดรายงาน (พิมพ์ / บันทึกเป็น PDF)', 'Open report (print / save as PDF)')}</Button> : <p className="text-[10px] text-muted">{L('ทำ “ตรวจจับการเปลี่ยนแปลง” ก่อน แล้วค่อยออกรายงาน', 'Run “Change detection” first, then make the report')}</p>}
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
      <p className="text-[10px] text-muted">{(() => { const pp = PURPOSES.find((p) => p.id === purpose); return pp ? L(pp.hintTh, pp.hint) : null; })()}</p>
      {!pick.pairOk && (
        <Notice tone="warn">
          {pick.pair && !pick.pair.ok ? pick.pair.reasons.join(' · ') : L('ภาพที่เลือกมีเมฆในกรอบเกินเกณฑ์ (หรือยังไม่ได้วัดเมฆ) · ยังวิเคราะห์ได้ แต่ตรวจเฉพาะส่วนที่โปร่ง และความเชื่อมั่นจะลดลง · ถ้าเรื่องที่สนใจอยู่ส่วนเดียวของกรอบ ย่อกรอบให้เหลือแค่ตรงนั้นในขั้นที่ 1 จะได้ผลดีกว่า', 'A selected image is cloudier than the thresholds in the area (or not measured yet) · it can still be analysed, on the clear part only and with lower confidence · if what matters is in one part of the box, shrink the box to it in step 1')}
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
      {run?.status === 'ok' && (
        <Button className="w-full" onClick={() => onMode('view')}>
          ◐ {L('เลื่อนเทียบภาพ A/B พร้อมผลนี้', 'Swipe A/B with this result')}
        </Button>
      )}
      {run && (
        <Button variant="primary" className="w-full" onClick={report}>
          📄 {L('ออกรายงานผลนี้ (พิมพ์ / บันทึกเป็น PDF)', 'Create report (print / save as PDF)')}
        </Button>
      )}
      {run && !watch && <p className="text-[10px] text-muted">{L('ผลนี้ยังไม่อยู่ในรายการเฝ้าระวัง · เพิ่มพื้นที่นี้ได้ที่ “ภาพ · รายงาน · เฝ้าระวัง”', 'Not in the watchlist — add this area under “Images · report · watch”')}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- what is on the map

/** Which step-3 mode put a layer on the map. */
function modeOfLayer(l: LayerEntry): Mode | null {
  if (l.id.startsWith('change-')) return 'change';
  if (l.id === 'flood' || l.id.startsWith('flood')) return 'flood';
  if (l.id.startsWith('spectral')) return /^NDBI/i.test(l.name) ? 'ndbi' : 'ndvi';
  return null;
}
const layersOfMode = (ls: LayerEntry[], m: Mode) => ls.filter((l) => modeOfLayer(l) === m);
function modeName(L: (a: string, b: string) => string, l: LayerEntry) {
  const m = modeOfLayer(l);
  return m ? MODES(L).find((x) => x.id === m)!.label : l.name;
}

/** Results on the map: show/hide, opacity, remove, legend per layer, clear all — so work does not pile up. */
function OnMap({ g }: { g: GisApi }) {
  const L = useL();
  const [open, setOpen] = useState(true);
  const [legendOf, setLegendOf] = useState<string | null>(null);
  const ls = g.layers;
  if (!ls.length) return null;
  const newest = ls[ls.length - 1]?.id;
  const shownLegend = legendOf ?? newest;
  return (
    <div className="absolute bottom-8 left-3 z-10 w-[min(300px,calc(100%-24px))] rounded-md border border-line bg-ink-950/90 text-[11px] text-slate-200 shadow-xl">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button onClick={() => setOpen(!open)} className="flex flex-1 items-center gap-1.5 text-left">
          <span className={cx('inline-block text-[10px] text-muted transition-transform', open && 'rotate-90')}>▶</span>
          <span className="font-semibold">{L('สิ่งที่แสดงบนแผนที่', 'On the map')}</span>
          <span className="rounded bg-cyan-400/15 px-1 font-mono text-[10px] text-cyan-300">{ls.filter((l) => l.show).length}/{ls.length}</span>
        </button>
        {open && <button className="text-[10px] text-muted hover:text-bad" onClick={() => ls.forEach((l) => g.removeLayer(l.id))}>{L('ล้างทั้งหมด', 'Clear all')}</button>}
      </div>
      {open && (
        <ul className="max-h-[45vh] overflow-y-auto border-t border-line scroll-thin">
          {[...ls].reverse().map((l) => {
            const m = modeOfLayer(l);
            const icon = m ? MODES(L).find((x) => x.id === m)!.icon : '▦';
            return (
              <li key={l.id} className="border-b border-white/5 px-2 py-1.5 last:border-0">
                <div className="flex items-center gap-1.5">
                  <button onClick={() => g.setLayer(l.id, { show: !l.show })} className={cx('w-5 shrink-0 text-center', l.show ? 'text-cyan-300' : 'text-muted')} title={l.show ? L('ซ่อน', 'Hide') : L('แสดง', 'Show')}>{l.show ? '👁' : '◌'}</button>
                  <button className={cx('min-w-0 flex-1 truncate text-left', !l.show && 'text-muted line-through')} onClick={() => setLegendOf(shownLegend === l.id ? '' : l.id)} title={l.name}>
                    {icon} {m ? `${modeName(L, l)} · ` : ''}{l.name}
                  </button>
                  <button onClick={() => g.removeLayer(l.id)} className="shrink-0 text-muted hover:text-bad" title={L('ลบออกจากแผนที่', 'Remove from the map')}>✕</button>
                </div>
                {l.layer && l.show && (
                  <label className="mt-0.5 flex items-center gap-1 pl-6 text-[9px] text-muted">
                    {L('ความทึบ', 'Opacity')}
                    <input type="range" min={0.1} max={1} step={0.05} value={l.alpha} onChange={(e) => g.setLayer(l.id, { alpha: +e.target.value })} className="h-1 flex-1" />
                  </label>
                )}
                {shownLegend === l.id && l.show && l.legend && (
                  <div className="mt-1 pl-6">
                    {l.legend.ramp && (
                      <>
                        <div className="h-2 rounded" style={{ background: l.legend.ramp }} />
                        {l.legend.range && <div className="flex justify-between font-mono text-[9px] text-muted"><span>{l.legend.range[0]}</span><span>{l.legend.unit ?? ''}</span><span>{l.legend.range[1]}</span></div>}
                      </>
                    )}
                    {l.legend.items?.map((it) => (
                      <div key={it.label} className="flex items-center gap-1.5 text-[10px] text-slate-300"><span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: it.color }} />{it.label}</div>
                    ))}
                    {l.legend.note && <p className="mt-0.5 text-[9px] text-muted">{l.legend.note}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
