// A GisApi host for pages other than the GIS workspace, so the GIS panels (indices, flood…) can be
// reused on any globe. Same behaviour as the workspace's own registry, without its toolbar.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cesium } from '../../lib/cesium';
import { LayerController } from '../../lib/basemaps';
import type { ImageryItem } from '../../lib/stac';
import type { GisApi, LayerEntry, LegendSpec, MapTool, ReportSection } from './GisContext';

export function useGisHost(viewer: Cesium.Viewer | null): GisApi {
  const [controller, setController] = useState<LayerController | null>(null);
  const [layers, setLayers] = useState<LayerEntry[]>([]);
  const layersRef = useRef<LayerEntry[]>([]);
  const handlers = useRef(new Map<MapTool, Set<(lon: number, lat: number) => void>>());
  const [tool, setTool] = useState<MapTool>('pan');
  const [sceneA, setSceneA] = useState<ImageryItem | null>(null);
  const [sceneB, setSceneB] = useState<ImageryItem | null>(null);
  const [report, setReport] = useState<ReportSection[]>([]);
  const actions = useRef<Record<string, (opts?: any) => void>>({});
  const registerAction = useRef((name: string, fn: (opts?: any) => void) => {
    actions.current[name] = fn;
    return () => {
      if (actions.current[name] === fn) delete actions.current[name];
    };
  }).current;
  const onMapClick = useRef((tl: MapTool, fn: (lon: number, lat: number) => void) => {
    const set = handlers.current.get(tl) ?? new Set();
    set.add(fn);
    handlers.current.set(tl, set);
    return () => set.delete(fn);
  }).current;
  const sync = () => setLayers([...layersRef.current]);

  useEffect(() => {
    setController(viewer ? new LayerController(viewer) : null);
  }, [viewer]);

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

  // map clicks for panels that ask for a point
  const toolRef = useRef(tool);
  toolRef.current = tool;
  useEffect(() => {
    if (!viewer) return;
    const h = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    h.setInputAction((e: any) => {
      const tl = toolRef.current;
      if (tl === 'pan' || tl.startsWith('measure')) return;
      const ray = viewer.camera.getPickRay(e.position);
      const c = (ray && viewer.scene.globe.pick(ray, viewer.scene)) || viewer.camera.pickEllipsoid(e.position, viewer.scene.globe.ellipsoid);
      if (!c) return;
      const k = Cesium.Cartographic.fromCartesian(c);
      handlers.current.get(tl)?.forEach((fn) => fn(Cesium.Math.toDegrees(k.longitude), Cesium.Math.toDegrees(k.latitude)));
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return () => h.destroy();
  }, [viewer]);

  return useMemo<GisApi>(
    () => ({
      viewer,
      controller,
      layers,
      putImagery: (id: string, name: string, provider: Cesium.ImageryProvider, opts: { alpha?: number; legend?: LegendSpec; meta?: string } = {}) => {
        if (!viewer || viewer.isDestroyed()) return null;
        removeLayer(id);
        const layer = viewer.imageryLayers.addImageryProvider(provider);
        layer.alpha = opts.alpha ?? 1;
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
        sync();
      },
      tool,
      setTool,
      onMapClick,
      sceneA,
      sceneB,
      setSceneA,
      setSceneB,
      resetKey: 0,
      registerAction,
      runAction: (name: string, opts?: any) => actions.current[name]?.(opts),
      report,
      putReport: (s: ReportSection) => setReport((r) => [...r.filter((x) => x.id !== s.id), s]),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewer, controller, layers, tool, sceneA, sceneB, report, removeLayer],
  );
}

/** Remove every analysis layer this host added (used when the area changes). */
export function clearGisLayers(g: GisApi) {
  g.layers.forEach((l) => g.removeLayer(l.id));
}
