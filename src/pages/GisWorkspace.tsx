import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n';
import GlobeHost from '../components/GlobeHost';
import AoiPicker from '../components/AoiPicker';
import { Button, cx } from '../components/ui';
import { Cesium, drawOnGlobe, showAoi } from '../lib/cesium';
import { LayerController, type BasemapId } from '../lib/basemaps';
import { lineLengthKm, polygonAreaKm2, areaKm2 } from '../lib/geo';
import { bounds } from '../lib/aoiEdit';
const boundsArr = (g: GeoJSON.Polygon) => { const b = bounds(g); return [b.west, b.south, b.east, b.north]; };
import { fmtLocal, fmtNum } from '../lib/format';
import { fmtArea } from '../lib/area';
import { isTh } from '../lib/classify/i18n';
import { useWorkspace } from '../store';
import type { ImageryItem } from '../lib/stac';
import { GisCtx, type GisApi, type LayerEntry, type LegendSpec, type MapTool, type ReportSection } from '../components/gis/GisContext';
import LayersPanel, { LegendBox } from '../components/gis/LayersPanel';
import DamsPanel from '../components/gis/DamsPanel';
import QueryPanel from '../components/gis/QueryPanel';
import SpectralPanel from '../components/gis/SpectralPanel';
import FloodPanel from '../components/gis/FloodPanel';
import ChangePanel from '../components/gis/ChangePanel';
import TerrainPanel from '../components/gis/TerrainPanel';
import LandCoverPanel from '../components/gis/LandCoverPanel';
import MapStatus from '../components/gis/MapStatus';
import { tl } from '../lib/classify/i18n';
import { sceneLabel } from '../components/gis/sceneLayer';
import AutoScenes from '../components/gis/AutoScenes';
import TaskWizard, { type TaskId } from '../components/gis/TaskWizard';
import { useSearchParams } from 'react-router-dom';

type ToolTab = 'imagery' | 'spectral' | 'landcover' | 'flood' | 'change' | 'terrain' | 'dams';
type Tab = 'start' | 'layers' | 'aoi' | 'analysis' | ToolTab;
/** Top-level sections of the side panel; individual analysis tools live under “Analysis”. */
const SECTIONS: { id: Tab; label: string; th: string }[] = [
  { id: 'start', label: 'Start', th: 'เริ่มต้น' },
  { id: 'layers', label: 'Layers', th: 'ชั้นข้อมูล' },
  { id: 'aoi', label: 'AOI', th: 'พื้นที่ AOI' },
  { id: 'analysis', label: 'Analysis', th: 'วิเคราะห์' },
];
/** Progressive disclosure: pick a kind of analysis first, then only its tools are shown. */
const ANALYSES: { id: ToolTab; label: string; th: string; desc: string; descTh: string; icon: string }[] = [
  { id: 'spectral', label: 'Spectral indices', th: 'ดัชนีเชิงสเปกตรัม', desc: 'Vegetation, water, burn, urban & soil indices; band composites', descTh: 'ดัชนีพืช น้ำ การเผาไหม้ เมืองและดิน · ภาพผสมแบนด์', icon: 'M4 20c4-12 12-12 16 0M4 20h16' },
  { id: 'landcover', label: 'Land cover', th: 'จำแนกสิ่งปกคลุมดิน', desc: 'Multi-index classification with confidence, QA masks, accuracy', descTh: 'จำแนกด้วยหลายดัชนี พร้อมความเชื่อมั่น หน้ากากคุณภาพ และความถูกต้อง', icon: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z' },
  { id: 'change', label: 'Change detection', th: 'ตรวจจับการเปลี่ยนแปลง', desc: 'Index difference, dNBR, radar or land-cover class change', descTh: 'ผลต่างดัชนี dNBR เรดาร์ หรือการเปลี่ยนประเภทสิ่งปกคลุมดิน', icon: 'M4 7h13l-3-3M20 17H7l3 3' },
  { id: 'flood', label: 'Flood & water', th: 'น้ำท่วมและแหล่งน้ำ', desc: 'Water mapping and possible flood, optical or radar', descTh: 'แผนที่แหล่งน้ำและพื้นที่ที่อาจมีน้ำท่วม จากภาพออปติคัลหรือเรดาร์', icon: 'M12 3s6 7 6 11a6 6 0 01-12 0c0-4 6-11 6-11z' },
  { id: 'terrain', label: 'Terrain & hydrology', th: 'ภูมิประเทศและอุทกวิทยา', desc: 'Elevation, slope, hillshade, watershed from a pour point', descTh: 'ความสูง ความลาดชัน แสงเงา และลุ่มน้ำจากจุดระบายน้ำ', icon: 'M2 20l7-12 4 6 3-4 6 10z' },
  { id: 'dams', label: 'Dams & reservoirs', th: 'เขื่อนและอ่างเก็บน้ำ', desc: 'Storage from the Royal Irrigation Department', descTh: 'ปริมาณน้ำในเขื่อนจากกรมชลประทาน', icon: 'M3 20h18M5 20V9l7-5 7 5v11M9 20v-6h6v6' },
  { id: 'imagery', label: 'Identify imagery', th: 'ตรวจภาพที่จุด', desc: 'Click the map to list scenes covering that point', descTh: 'คลิกแผนที่เพื่อดูภาพที่ครอบคลุมจุดนั้น', icon: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-4.5-4.5' },
];
const PANEL_PARAM: Record<string, Tab> = { spectral: 'spectral', landcover: 'landcover', change: 'change', flood: 'flood', terrain: 'terrain', dams: 'dams', imagery: 'imagery', layers: 'layers', aoi: 'aoi', analysis: 'analysis' };

const TOOLS: { id: MapTool | 'draw-rect'; label: string; th: string; icon: string }[] = [
  { id: 'pan', label: 'Pan / select', th: 'เลื่อน / เลือก', icon: 'M5 3l14 7-6 2-2 6z' },
  { id: 'draw-rect', label: 'Draw AOI rectangle', th: 'วาดกรอบพื้นที่ AOI', icon: 'M4 4h4M12 4h4M20 4v4M20 12v4M20 20h-4M12 20H8M4 20v-4M4 12V8' },
  { id: 'query', label: 'Identify imagery at a point', th: 'ตรวจภาพที่จุด', icon: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v5M12 8v.01' },
  { id: 'measure-line', label: 'Measure distance', th: 'วัดระยะทาง', icon: 'M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2' },
  { id: 'measure-area', label: 'Measure area', th: 'วัดพื้นที่', icon: 'M5 19l2-13 11 2 2 9z' },
  { id: 'elevation', label: 'Elevation at a point', th: 'ความสูงที่จุด', icon: 'M2 20l7-12 4 6 3-4 6 10z' },
  { id: 'pour', label: 'Pour point (watershed)', th: 'จุดระบายน้ำ (ลุ่มน้ำ)', icon: 'M12 3s6 7 6 11a6 6 0 01-12 0c0-4 6-11 6-11z' },
];

function Ico({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[17px] w-[17px]" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export default function GisWorkspace() {
  const { aoi, setAoi } = useWorkspace();
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const [controller, setController] = useState<LayerController | null>(null);
  const [basemap, setBasemap] = useState<BasemapId>('hybrid');
  const [params] = useSearchParams();
  const taskParam = params.get('task') as TaskId | null;
  const panelParam = params.get('panel');
  const [tab, setTab] = useState<Tab>(taskParam === 'dams' ? 'dams' : PANEL_PARAM[panelParam ?? ''] ?? 'start');
  useEffect(() => {
    if (taskParam === 'dams') setTab('dams');
    else if (taskParam) setTab('start');
  }, [taskParam]);
  useEffect(() => {
    const p = PANEL_PARAM[panelParam ?? ''];
    if (p) {
      setTab(p);
      setOpen(true);
    }
  }, [panelParam]);
  const [open, setOpen] = useState(true);
  const [tool, setTool] = useState<MapTool>('pan');
  const [layers, setLayers] = useState<LayerEntry[]>([]);
  const layersRef = useRef<LayerEntry[]>([]);
  const handlers = useRef(new Map<MapTool, Set<(lon: number, lat: number) => void>>());
  const [sceneA, setSceneA] = useState<ImageryItem | null>(null);
  const [sceneB, setSceneB] = useState<ImageryItem | null>(null);
  const [report, setReport] = useState<ReportSection[]>([]);
  const [measure, setMeasure] = useState<string>('');
  const [split, setSplit] = useState(0.5);
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const actions = useRef<Record<string, (opts?: any) => void>>({});
  const registerAction = useRef((name: string, fn: (opts?: any) => void) => {
    actions.current[name] = fn;
    return () => {
      if (actions.current[name] === fn) delete actions.current[name];
    };
  }).current;

  const sync = () => setLayers([...layersRef.current]);

  useEffect(() => {
    if (!viewer) return;
    const c = new LayerController(viewer);
    setController(c);
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(100.6, 14.5, 2.2e6) });
  }, [viewer]);
  useEffect(() => {
    if (controller) void controller.setBasemap(basemap);
  }, [controller, basemap]);
  useEffect(() => {
    if (viewer) showAoi(viewer, aoi?.geometry ?? null, 'gis-aoi');
  }, [viewer, aoi]);
  useEffect(() => {
    if (viewer) viewer.scene.splitPosition = split;
  }, [viewer, split]);

  // ---------- layer registry ----------
  const removeLayer = useCallback(
    (id: string) => {
      const l = layersRef.current.find((x) => x.id === id);
      if (!l || !viewer || viewer.isDestroyed()) return;
      if (l.layer) viewer.imageryLayers.remove(l.layer, true);
      if (l.dataSource) viewer.dataSources.remove(l.dataSource, true);
      layersRef.current = layersRef.current.filter((x) => x.id !== id);
      sync();
    },
    [viewer],
  );

  const api: GisApi = useMemo(
    () => ({
      viewer,
      controller,
      layers,
      putImagery: (id: string, name: string, provider: Cesium.ImageryProvider, opts: { alpha?: number; legend?: LegendSpec; meta?: string } = {}) => {
        if (!viewer || viewer.isDestroyed()) return null;
        removeLayer(id);
        const layer = viewer.imageryLayers.addImageryProvider(provider);
        layer.alpha = opts.alpha ?? 1;
        controller?.raiseOverlays();
        layersRef.current = [...layersRef.current, { id, name, group: 'analysis', layer, show: true, alpha: layer.alpha, legend: opts.legend, meta: opts.meta }];
        sync();
        return layer;
      },
      putDataSource: (id: string, name: string, ds: Cesium.DataSource, opts: { legend?: LegendSpec; meta?: string } = {}) => {
        if (!viewer || viewer.isDestroyed()) return;
        removeLayer(id);
        void viewer.dataSources.add(ds);
        layersRef.current = [...layersRef.current, { id, name, group: 'vector', dataSource: ds, show: true, alpha: 1, legend: opts.legend, meta: opts.meta }];
        sync();
      },
      removeLayer,
      setLayer: (id: string, patch: Partial<Pick<LayerEntry, 'show' | 'alpha'>>) => {
        const l = layersRef.current.find((x) => x.id === id);
        if (!l) return;
        if (patch.show !== undefined) {
          l.show = patch.show;
          if (l.layer) l.layer.show = patch.show;
          if (l.dataSource) l.dataSource.show = patch.show;
        }
        if (patch.alpha !== undefined && l.layer) {
          l.alpha = patch.alpha;
          l.layer.alpha = patch.alpha;
        }
        sync();
      },
      moveLayer: (id: string, dir: 1 | -1) => {
        const l = layersRef.current.find((x) => x.id === id);
        if (!l?.layer || !viewer) return;
        if (dir > 0) viewer.imageryLayers.raise(l.layer);
        else viewer.imageryLayers.lower(l.layer);
        controller?.raiseOverlays();
        const arr = [...layersRef.current];
        const i = arr.indexOf(l), j = Math.max(0, Math.min(arr.length - 1, i + dir));
        [arr[i], arr[j]] = [arr[j], arr[i]];
        layersRef.current = arr;
        sync();
      },
      tool,
      setTool,
      onMapClick: (tl: MapTool, fn: (lon: number, lat: number) => void) => {
        const set = handlers.current.get(tl) ?? new Set();
        set.add(fn);
        handlers.current.set(tl, set);
        return () => set.delete(fn);
      },
      sceneA,
      sceneB,
      setSceneA,
      setSceneB,
      resetKey,
      registerAction,
      runAction: (name: string, opts?: any) => actions.current[name]?.(opts),
      report,
      putReport: (s: ReportSection) => setReport((r) => [...r.filter((x) => x.id !== s.id), s]),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewer, controller, layers, tool, sceneA, sceneB, report, removeLayer, resetKey],
  );
  // stable reference for panels' effect deps
  const onMapClickStable = useRef(api.onMapClick);
  api.onMapClick = onMapClickStable.current;

  // ---------- map clicks ----------
  const toolRef = useRef(tool);
  toolRef.current = tool;
  useEffect(() => {
    if (!viewer) return;
    const h = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    const pick = (pos: Cesium.Cartesian2) => {
      const ray = viewer.camera.getPickRay(pos);
      const c = (ray && viewer.scene.globe.pick(ray, viewer.scene)) || viewer.camera.pickEllipsoid(pos, viewer.scene.globe.ellipsoid);
      if (!c) return null;
      const k = Cesium.Cartographic.fromCartesian(c);
      return { lon: Cesium.Math.toDegrees(k.longitude), lat: Cesium.Math.toDegrees(k.latitude) };
    };
    h.setInputAction((e: any) => {
      const tl = toolRef.current;
      if (tl === 'pan' || tl.startsWith('measure')) return;
      const p = pick(e.position);
      if (p) handlers.current.get(tl)?.forEach((fn) => fn(p.lon, p.lat));
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    let raf = 0;
    h.setInputAction((e: any) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setCursor(pick(e.endPosition)));
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    return () => h.destroy();
  }, [viewer]);

  const chooseTool = async (id: MapTool | 'draw-rect') => {
    if (!viewer) return;
    setMeasure('');
    if (id === 'draw-rect') {
      setTool('pan');
      setTab('aoi');
      setOpen(true);
      const pts = await drawOnGlobe(viewer, 'rectangle').promise;
      if (pts) setAoi({ geometry: { type: 'Polygon', coordinates: [pts] }, name: t('Drawn rectangle'), source: 'drawn' });
      return;
    }
    setTool(id);
    if (id === 'query') { setTab('imagery'); setOpen(true); }
    if (id === 'elevation' || id === 'pour') { setTab('terrain'); setOpen(true); }
    if (id === 'measure-line' || id === 'measure-area') {
      const old = viewer.entities.getById('gis-measure');
      if (old) viewer.entities.remove(old);
      const pts = await drawOnGlobe(viewer, id === 'measure-line' ? 'line' : 'polygon').promise;
      setTool('pan');
      if (!pts) return;
      viewer.entities.add({ id: 'gis-measure', polyline: { positions: Cesium.Cartesian3.fromDegreesArray(pts.flat()), width: 2.5, material: Cesium.Color.fromCssColorString('#f5b84b'), clampToGround: true } });
      setMeasure(id === 'measure-line' ? `${fmtNum(lineLengthKm(pts), 3)} ${tl('km', 'กม.')}` : fmtArea(polygonAreaKm2(pts.slice(0, -1)), 'km2', isTh()));
    }
  };

  // ---------- reset the map to its original state ----------
  const resetMap = (alsoAoi: boolean) => {
    if (!viewer) return;
    // remove every analysis / imported layer (dam pins are kept — toggle them in Layers)
    layersRef.current
      .filter((l) => l.id !== 'dams')
      .forEach((l) => {
        if (l.layer) viewer.imageryLayers.remove(l.layer, true);
        if (l.dataSource) viewer.dataSources.remove(l.dataSource, true);
      });
    layersRef.current = layersRef.current.filter((l) => l.id === 'dams');
    sync();
    ['gis-measure', 'query-pt'].forEach((id) => {
      const e = viewer.entities.getById(id);
      if (e) viewer.entities.remove(e);
    });
    // terrain look back to normal
    viewer.scene.globe.material = undefined as any;
    viewer.scene.globe.enableLighting = false;
    viewer.scene.light = new Cesium.SunLight();
    const sc: any = viewer.scene;
    if ('verticalExaggeration' in sc) sc.verticalExaggeration = 1;
    viewer.scene.splitPosition = 0.5;
    setSplit(0.5);
    setMeasure('');
    setTool('pan');
    setReport([]);
    setBasemap('hybrid');
    if (alsoAoi) {
      setAoi(null);
      setSceneA(null);
      setSceneB(null);
    }
    setResetKey((k) => k + 1);
    viewer.camera.flyTo({ destination: alsoAoi || !aoi ? Cesium.Cartesian3.fromDegrees(100.6, 14.5, 2.2e6) : Cesium.Rectangle.fromDegrees(...(boundsArr(aoi.geometry) as [number, number, number, number])), duration: 1.2 });
  };
  const [confirmReset, setConfirmReset] = useState(false);

  // ---------- report ----------
  const exportReport = () => {
    if (!viewer) return;
    viewer.render();
    let img = '';
    try {
      img = viewer.scene.canvas.toDataURL('image/png');
    } catch {
      /* tainted canvas — skip snapshot */
    }
    const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>ORBITAL VISION report</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:24px auto;color:#111;padding:0 16px}h1{font-size:20px}h2{font-size:15px;margin-top:22px;border-bottom:1px solid #ccc}li{margin:2px 0;font-size:13px}img{max-width:100%;border:1px solid #ccc}small{color:#666}</style></head><body>
<h1>ORBITAL VISION — GIS analysis report</h1>
<small>${esc(fmtLocal(new Date()))} (Asia/Bangkok)</small>
${img ? `<h2>Map</h2><img src="${img}" alt="map snapshot">` : ''}
<h2>Area of interest</h2>
<ul>${aoi ? `<li>${esc(aoi.name)} — ${areaKm2(aoi.geometry).toFixed(3)} km²</li><li><code>${esc(JSON.stringify(aoi.geometry))}</code></li>` : '<li>None</li>'}</ul>
<h2>Scenes</h2><ul><li>A: ${esc(sceneLabel(sceneA))} ${sceneA ? `<code>${esc(sceneA.id)}</code>` : ''}</li><li>B: ${esc(sceneLabel(sceneB))} ${sceneB ? `<code>${esc(sceneB.id)}</code>` : ''}</li></ul>
<h2>Layers shown</h2><ul>${layers.filter((l) => l.show).map((l) => `<li><b>${esc(l.name)}</b>${l.meta ? ` — ${esc(l.meta)}` : ''}</li>`).join('') || '<li>None</li>'}</ul>
${report.map((s) => `<h2>${esc(s.title)}</h2><ul>${s.lines.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`).join('')}
<h2>Data sources</h2><ul><li>Satellite scenes &amp; band math: Microsoft Planetary Computer (Copernicus Sentinel, USGS Landsat)</li><li>Terrain: Cesium World Terrain</li><li>Dams: Royal Irrigation Department public API; locations © OpenStreetMap contributors</li><li>Basemaps: Esri / Bing / OpenStreetMap (see map credits)</li></ul>
<p><small>Results are derived from satellite data with user-set parameters. They are estimates and do not confirm events on the ground.</small></p>
</body></html>`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    a.download = `orbital-vision-report-${new Date().toISOString().slice(0, 10)}.html`;
    a.click();
  };

  const swipeOn = layers.some((l) => l.id === 'swipe-a');

  const inTool = ANALYSES.some((x) => x.id === tab);
  const curAnalysis = ANALYSES.find((x) => x.id === tab);
  const sectionOf = (x: Tab): Tab => (ANALYSES.some((a) => a.id === x) ? 'analysis' : x);

  return (
    <GisCtx.Provider value={api}>
      <div className="relative flex h-full overflow-hidden">
        {/* side panel (slides; the map keeps the rest of the screen) */}
        <aside
          aria-hidden={!open}
          className={cx(
            'absolute inset-y-0 left-0 z-20 flex w-[min(360px,100%)] shrink-0 flex-col border-r border-line bg-ink-900 transition-[transform,margin] duration-200 ease-out md:relative',
            open ? 'translate-x-0' : '-translate-x-full md:-ml-[360px]',
          )}
        >
          <div className="border-b border-line px-3 pb-2 pt-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400">GIS · {t('Workspace')}</div>
                <h1 className="truncate text-sm font-semibold text-white">{curAnalysis ? tl(curAnalysis.label, curAnalysis.th) : t('Hydrology & imagery analysis')}</h1>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button onClick={exportReport} title={tl('Download an HTML report of the map, layers and results', 'ดาวน์โหลดรายงาน HTML ของแผนที่ ชั้นข้อมูล และผลวิเคราะห์')}>{t('Report')}</Button>
                <button className="ov-tool md:hidden" onClick={() => setOpen(false)} aria-label={t('Hide panel')}>✕</button>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-0.5 rounded bg-ink-950 p-0.5" role="tablist">
              {SECTIONS.map((x) => {
                const on = sectionOf(tab) === x.id;
                return (
                  <button key={x.id} role="tab" aria-selected={on} onClick={() => setTab(x.id)} className={cx('rounded px-2 py-1 text-[11px] transition-colors duration-150', on ? 'bg-navy-800 text-cyan-300 shadow-panel' : 'text-muted hover:text-white')}>
                    {tl(x.label, x.th)}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3 scroll-thin">
            <div className={tab === 'start' ? 'ov-enter' : 'hidden'}>
              <TaskWizard initialTask={taskParam} goTab={(x) => setTab(x as Tab)} />
            </div>
            {tab === 'analysis' && (
              <div className="ov-enter space-y-1.5">
                <p className="text-[11px] text-muted">{tl('Choose the kind of analysis — only its tools are shown.', 'เลือกประเภทการวิเคราะห์ ระบบจะแสดงเฉพาะเครื่องมือที่เกี่ยวข้อง')}</p>
                {ANALYSES.map((x) => (
                  <button key={x.id} onClick={() => setTab(x.id)} className="group flex w-full items-start gap-2.5 rounded-md border border-line bg-navy-900 px-2.5 py-2 text-left transition-colors duration-150 hover:border-cyan-400/40 hover:bg-navy-850">
                    <span className="mt-0.5 text-cyan-400"><Ico d={x.icon} /></span>
                    <span className="min-w-0">
                      <span className="block text-[13px] text-slate-100 group-hover:text-white">{tl(x.label, x.th)}</span>
                      <span className="block text-[11px] leading-snug text-muted">{tl(x.desc, x.descTh)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {inTool && (
              <button onClick={() => setTab('analysis')} className="mb-2 flex items-center gap-1 text-[11px] text-muted transition-colors hover:text-cyan-300">
                ← {tl('All analysis tools', 'เครื่องมือวิเคราะห์ทั้งหมด')}
              </button>
            )}
            {(tab === 'spectral' || tab === 'flood' || tab === 'change' || tab === 'imagery' || tab === 'landcover') && (
              <details open className="mb-3 rounded border border-line p-2">
                <summary className="label cursor-pointer">{t('Images used for analysis')}</summary>
                <div className="mt-2"><AutoScenes /></div>
              </details>
            )}
            <div className={tab === 'layers' ? 'ov-enter' : 'hidden'}><LayersPanel basemap={basemap} setBasemap={setBasemap} /></div>
            <div className={tab === 'aoi' ? 'ov-enter' : 'hidden'}>
              <AoiPicker viewer={viewer} />
              <p className="mt-2 text-[10px] text-muted">{t('The same AOI geometry is used by every tool and every page (Imagery Explorer, Coverage Planner, Pass view).')}</p>
            </div>
            <div className={tab === 'dams' ? 'ov-enter' : 'hidden'}><DamsPanel /></div>
            <div className={tab === 'imagery' ? 'ov-enter' : 'hidden'}><QueryPanel /></div>
            <div className={tab === 'spectral' ? 'ov-enter' : 'hidden'}><SpectralPanel /></div>
            <div className={tab === 'landcover' ? 'ov-enter' : 'hidden'}><LandCoverPanel /></div>
            <div className={tab === 'flood' ? 'ov-enter' : 'hidden'}><FloodPanel /></div>
            <div className={tab === 'change' ? 'ov-enter' : 'hidden'}><ChangePanel /></div>
            <div className={tab === 'terrain' ? 'ov-enter' : 'hidden'}><TerrainPanel /></div>
          </div>
        </aside>

        {/* map canvas */}
        <div className="relative min-w-0 flex-1">
          <GlobeHost onReady={setViewer} options={{ baseLayers: false }} />

          {/* floating toolbar */}
          <div className="ov-float absolute left-3 top-3 z-10 flex flex-col gap-0.5 p-1" role="toolbar" aria-label={tl('Map tools', 'เครื่องมือแผนที่')} aria-orientation="vertical">
            <button className="ov-tool" onClick={() => setOpen(!open)} title={open ? t('Hide panel') : t('Show panel')} aria-label={open ? t('Hide panel') : t('Show panel')} aria-pressed={open}>
              <Ico d="M3 4h18v16H3zM9 4v16" />
            </button>
            <div className="mx-1.5 my-0.5 h-px bg-white/10" />
            {TOOLS.map((tl0) => (
              <button key={tl0.id} className="ov-tool" title={tl(tl0.label, tl0.th)} aria-label={tl(tl0.label, tl0.th)} aria-pressed={tool === tl0.id} onClick={() => chooseTool(tl0.id)}>
                <Ico d={tl0.icon} />
              </button>
            ))}
            <div className="mx-1.5 my-0.5 h-px bg-white/10" />
            <button
              className="ov-tool"
              title={t('Quick NDVI for AOI')}
              aria-label={t('Quick NDVI for AOI')}
              onClick={() => {
                setTab('spectral');
                setOpen(true);
                actions.current.ndvi?.();
              }}
            >
              <Ico d="M5 19c0-8 6-14 15-14-1 9-6 15-14 15M5 19l7-7" />
            </button>
            <div className="relative">
              <button className="ov-tool" title={t('Reset map to the original view')} aria-label={t('Reset map to the original view')} aria-pressed={confirmReset} onClick={() => setConfirmReset(!confirmReset)}>
                <Ico d="M4 4v6h6M4.6 15a8 8 0 101.9-8.3L4 10" />
              </button>
              {confirmReset && (
                <div className="ov-enter absolute left-10 top-0 z-50 w-60 space-y-1.5 rounded-md border border-line bg-navy-850 p-2.5 shadow-float">
                  <div className="text-xs font-semibold text-white">{t('Reset map')}</div>
                  <p className="text-[10px] leading-snug text-muted">{t('Removes all analysis results, imported layers, measurements and terrain shading, and returns to the Hybrid basemap.')}</p>
                  <Button variant="primary" className="w-full" onClick={() => { resetMap(false); setConfirmReset(false); }}>{t('Clear results (keep AOI)')}</Button>
                  <Button variant="danger" className="w-full" onClick={() => { resetMap(true); setConfirmReset(false); }}>{t('Clear everything incl. AOI')}</Button>
                  <Button className="w-full" onClick={() => setConfirmReset(false)}>{t('Cancel')}</Button>
                </div>
              )}
            </div>
          </div>

          {/* context chips */}
          <div className="pointer-events-none absolute left-16 top-3 z-10 flex flex-wrap gap-1.5">
            {tool !== 'pan' && <span className="ov-float ov-enter px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-cyan-300">{tl(TOOLS.find((x) => x.id === tool)?.label ?? '', TOOLS.find((x) => x.id === tool)?.th ?? '')}</span>}
            {aoi && <span className="ov-float px-2 py-0.5 font-mono text-[10px] text-slate-200">AOI {fmtArea(areaKm2(aoi.geometry), 'km2', isTh())}</span>}
            {measure && <span className="ov-float ov-enter px-2 py-0.5 font-mono text-[10px] text-warn">{measure}</span>}
          </div>

          <MapStatus viewer={viewer} cursor={cursor} layers={layers.filter((l) => l.show).length} />
          <div className="absolute bottom-9 right-3 z-10">
            <LegendBox />
          </div>
          {swipeOn && (
            <>
              <div className="pointer-events-none absolute inset-y-0 z-10 w-px bg-white/80" style={{ left: `${split * 100}%` }} />
              <input type="range" min={0} max={1} step={0.001} value={split} onChange={(e) => setSplit(+e.target.value)} className="absolute bottom-12 left-1/2 z-20 w-1/2 -translate-x-1/2" aria-label={t('Swipe divider')} />
            </>
          )}
        </div>
      </div>
    </GisCtx.Provider>
  );
}
