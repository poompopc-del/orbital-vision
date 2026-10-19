import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n';
import GlobeHost from '../components/GlobeHost';
import AoiPicker from '../components/AoiPicker';
import { Badge, Button, Select, cx } from '../components/ui';
import { Cesium, drawOnGlobe, showAoi } from '../lib/cesium';
import { LayerController, type BasemapId } from '../lib/basemaps';
import { lineLengthKm, polygonAreaKm2, areaKm2 } from '../lib/geo';
import { bounds } from '../lib/aoiEdit';
const boundsArr = (g: GeoJSON.Polygon) => { const b = bounds(g); return [b.west, b.south, b.east, b.north]; };
import { fmtLocal, fmtNum } from '../lib/format';
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
import { sceneLabel } from '../components/gis/sceneLayer';

type Tab = 'layers' | 'aoi' | 'dams' | 'imagery' | 'spectral' | 'flood' | 'change' | 'terrain';
const TABS: { id: Tab; label: string }[] = [
  { id: 'layers', label: 'Layers' },
  { id: 'aoi', label: 'AOI' },
  { id: 'dams', label: 'Dams' },
  { id: 'imagery', label: 'Imagery' },
  { id: 'spectral', label: 'Spectral' },
  { id: 'flood', label: 'Flood' },
  { id: 'change', label: 'Change' },
  { id: 'terrain', label: 'Terrain' },
];

const TOOLS: { id: MapTool | 'draw-rect'; label: string; icon: string }[] = [
  { id: 'pan', label: 'Select / pan', icon: '✋' },
  { id: 'draw-rect', label: 'Draw AOI rectangle', icon: '▭' },
  { id: 'query', label: 'Identify imagery at a point', icon: '🔎' },
  { id: 'elevation', label: 'Elevation at a point', icon: '⛰' },
  { id: 'pour', label: 'Pour point (watershed)', icon: '💧' },
  { id: 'measure-line', label: 'Measure distance', icon: '📏' },
  { id: 'measure-area', label: 'Measure area', icon: '⬚' },
];

export default function GisWorkspace() {
  const { aoi, setAoi, lastResults } = useWorkspace();
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const [controller, setController] = useState<LayerController | null>(null);
  const [basemap, setBasemap] = useState<BasemapId>('hybrid');
  const [tab, setTab] = useState<Tab>('layers');
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
  const actions = useRef<Record<string, () => void>>({});
  const registerAction = useRef((name: string, fn: () => void) => {
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
      setMeasure(id === 'measure-line' ? `${fmtNum(lineLengthKm(pts), 3)} km` : `${fmtNum(polygonAreaKm2(pts.slice(0, -1)), 3)} km²`);
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
  const pcResults = lastResults.filter((r) => r.source === 'planetary-computer');

  return (
    <GisCtx.Provider value={api}>
      <div className="relative flex h-full">
        {/* toolbar */}
        <div className="z-20 flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-ink-950 py-2">
          {TOOLS.map((tl) => (
            <button
              key={tl.id}
              title={t(tl.label)}
              onClick={() => chooseTool(tl.id)}
              className={cx('flex h-8 w-8 items-center justify-center rounded text-sm', tool === tl.id ? 'bg-cyan-400/15 text-cyan-300 shadow-glow' : 'text-slate-300 hover:bg-navy-800')}
            >
              {tl.icon}
            </button>
          ))}
          <button
            title={t('Quick NDVI for AOI')}
            onClick={() => {
              setTab('spectral');
              setOpen(true);
              actions.current.ndvi?.();
            }}
            className="flex h-8 w-8 items-center justify-center rounded text-sm text-slate-300 hover:bg-navy-800"
          >
            🌿
          </button>
          <div className="relative">
            <button
              title={t('Reset map to the original view')}
              onClick={() => setConfirmReset(!confirmReset)}
              className={cx('flex h-8 w-8 items-center justify-center rounded text-base', confirmReset ? 'bg-warn/20 text-warn' : 'text-slate-300 hover:bg-navy-800')}
            >
              ↺
            </button>
            {confirmReset && (
              <div className="absolute left-10 top-0 z-50 w-56 space-y-1.5 rounded border border-line bg-navy-850 p-2.5 shadow-xl">
                <div className="text-xs font-semibold text-white">{t('Reset map')}</div>
                <p className="text-[10px] leading-snug text-muted">{t('Removes all analysis results, imported layers, measurements and terrain shading, and returns to the Hybrid basemap.')}</p>
                <Button variant="primary" className="w-full" onClick={() => { resetMap(false); setConfirmReset(false); }}>{t('Clear results (keep AOI)')}</Button>
                <Button variant="danger" className="w-full" onClick={() => { resetMap(true); setConfirmReset(false); }}>{t('Clear everything incl. AOI')}</Button>
                <Button className="w-full" onClick={() => setConfirmReset(false)}>{t('Cancel')}</Button>
              </div>
            )}
          </div>
          <div className="my-1 h-px w-6 bg-line" />
          <button title={open ? t('Hide panel') : t('Show panel')} onClick={() => setOpen(!open)} className="flex h-8 w-8 items-center justify-center rounded text-slate-300 hover:bg-navy-800">
            {open ? '⟨' : '⟩'}
          </button>
        </div>

        {/* side panel */}
        <aside className={cx('z-10 flex w-[360px] shrink-0 flex-col border-r border-line bg-ink-900', !open && 'hidden')}>
          <div className="border-b border-line p-2.5">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400">GIS · {t('Workspace')}</div>
                <h1 className="text-sm font-semibold text-white">{t('Hydrology & imagery analysis')}</h1>
              </div>
              <Button onClick={exportReport}>{t('Report')}</Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {TABS.map((x) => (
                <button key={x.id} onClick={() => setTab(x.id)} className={cx('rounded px-2 py-1 text-[11px]', tab === x.id ? 'bg-cyan-400/15 text-cyan-300' : 'text-muted hover:text-white')}>
                  {t(x.label)}
                </button>
              ))}
            </div>
            {(tab === 'spectral' || tab === 'flood' || tab === 'change' || tab === 'imagery') && (
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                {(['A', 'B'] as const).map((w) => (
                  <Select
                    key={w}
                    value={(w === 'A' ? sceneA : sceneB)?.id ?? ''}
                    onChange={(e) => (w === 'A' ? setSceneA : setSceneB)(pcResults.find((r) => r.id === e.target.value) ?? null)}
                    title={w === 'A' ? t('Scene A (before)') : t('Scene B (after)')}
                  >
                    <option value="">{w}: {t('choose scene')}</option>
                    {pcResults.map((r) => <option key={r.id} value={r.id}>{w}: {sceneLabel(r)}</option>)}
                  </Select>
                ))}
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3 scroll-thin">
            <div className={tab === 'layers' ? '' : 'hidden'}><LayersPanel basemap={basemap} setBasemap={setBasemap} /></div>
            <div className={tab === 'aoi' ? '' : 'hidden'}>
              <AoiPicker viewer={viewer} />
              <p className="mt-2 text-[10px] text-muted">{t('The same AOI geometry is used by every tool and every page (Imagery Explorer, Coverage Planner, Pass view).')}</p>
            </div>
            <div className={tab === 'dams' ? '' : 'hidden'}><DamsPanel /></div>
            <div className={tab === 'imagery' ? '' : 'hidden'}><QueryPanel /></div>
            <div className={tab === 'spectral' ? '' : 'hidden'}><SpectralPanel /></div>
            <div className={tab === 'flood' ? '' : 'hidden'}><FloodPanel /></div>
            <div className={tab === 'change' ? '' : 'hidden'}><ChangePanel /></div>
            <div className={tab === 'terrain' ? '' : 'hidden'}><TerrainPanel /></div>
          </div>
        </aside>

        {/* map */}
        <div className="relative min-w-0 flex-1">
          <GlobeHost onReady={setViewer} options={{ baseLayers: false }} />
          <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-wrap gap-1.5">
            <Badge tone="cyan">{t(TOOLS.find((x) => x.id === tool)?.label ?? '')}</Badge>
            {aoi && <Badge>AOI {fmtNum(areaKm2(aoi.geometry), 2)} km²</Badge>}
            {measure && <Badge tone="warn">{measure}</Badge>}
          </div>
          {cursor && <div className="pointer-events-none absolute bottom-2 left-3 z-10 rounded bg-ink-950/80 px-2 py-0.5 font-mono text-[10px] text-slate-300">{cursor.lat.toFixed(5)}, {cursor.lon.toFixed(5)}</div>}
          <div className="absolute bottom-8 right-3 z-10">
            <LegendBox />
          </div>
          {swipeOn && (
            <>
              <div className="pointer-events-none absolute inset-y-0 z-10 w-px bg-white/80" style={{ left: `${split * 100}%` }} />
              <input type="range" min={0} max={1} step={0.001} value={split} onChange={(e) => setSplit(+e.target.value)} className="absolute bottom-10 left-1/2 z-20 w-1/2 -translate-x-1/2" aria-label={t('Swipe divider')} />
            </>
          )}
        </div>
      </div>
    </GisCtx.Provider>
  );
}
