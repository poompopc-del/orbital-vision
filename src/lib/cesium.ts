import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined;
if (ionToken) Cesium.Ion.defaultAccessToken = ionToken;
export const hasIon = !!ionToken;

export { Cesium };

export const CYAN = Cesium.Color.fromCssColorString('#22d3ee');
export const CYAN_SOFT = Cesium.Color.fromCssColorString('#7ce7f7');

export interface ViewerOptions {
  timeline?: boolean;
  animation?: boolean;
  /** false = start without any imagery (the caller manages basemaps) */
  baseLayers?: boolean;
}

export function createViewer(el: HTMLElement, opts: ViewerOptions = {}): Cesium.Viewer {
  const viewer = new Cesium.Viewer(el, {
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    timeline: opts.timeline ?? false,
    animation: opts.animation ?? false,
    shouldAnimate: true,
    scene3DOnly: false,
    contextOptions: { webgl: { preserveDrawingBuffer: false } },
  });
  const scene = viewer.scene;
  scene.backgroundColor = Cesium.Color.fromCssColorString('#07090c');
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b1524');
  scene.globe.showGroundAtmosphere = true;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
  scene.fog.enabled = true;
  (scene as any).highDynamicRange = false;
  viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  if (opts.baseLayers !== false) void addBaseLayers(viewer);
  return viewer;
}

export interface BaseLayerInfo {
  base: string;
  labels: Cesium.ImageryLayer | null;
}

async function addBaseLayers(viewer: Cesium.Viewer): Promise<BaseLayerInfo> {
  let base = '';
  try {
    if (ionToken) {
      viewer.imageryLayers.add(Cesium.ImageryLayer.fromWorldImagery({}), 0);
      base = 'Cesium ion · Bing Maps Aerial';
    } else {
      const p = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
        'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
      );
      if (viewer.isDestroyed()) return { base, labels: null };
      viewer.imageryLayers.addImageryProvider(p, 0);
      base = 'Esri World Imagery';
    }
  } catch {
    if (viewer.isDestroyed()) return { base, labels: null };
    viewer.imageryLayers.addImageryProvider(new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }), 0);
    base = 'OpenStreetMap';
  }
  let labels: Cesium.ImageryLayer | null = null;
  try {
    const ref = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer',
    );
    if (!viewer.isDestroyed()) {
      labels = viewer.imageryLayers.addImageryProvider(ref);
      labels.alpha = 0.85;
    }
  } catch {
    /* labels overlay is optional */
  }
  (viewer as any).__ovBase = { base, labels };
  return { base, labels };
}

export function getLabelsLayer(viewer: Cesium.Viewer): Cesium.ImageryLayer | null {
  return (viewer as any).__ovBase?.labels ?? null;
}
export function getBaseName(viewer: Cesium.Viewer): string {
  return (viewer as any).__ovBase?.base ?? '';
}

export async function setTerrain(viewer: Cesium.Viewer, on: boolean) {
  if (on && ionToken) {
    // vertex normals are needed for hillshade / slope / aspect shading
    viewer.scene.setTerrain(Cesium.Terrain.fromWorldTerrain({ requestVertexNormals: true }));
  } else {
    viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
  }
}

export function flyToBbox(viewer: Cesium.Viewer, w: number, s: number, e: number, n: number, duration = 1.6) {
  const pad = Math.max(e - w, n - s) * 0.4 + 0.02;
  viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(w - pad, s - pad, e + pad, n + pad), duration });
}

export function flyToPolygon(viewer: Cesium.Viewer, g: GeoJSON.Polygon) {
  const xs = g.coordinates[0].map((c) => c[0]);
  const ys = g.coordinates[0].map((c) => c[1]);
  flyToBbox(viewer, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

/** Draw / replace the AOI entity on a viewer. */
export function showAoi(viewer: Cesium.Viewer, g: GeoJSON.Polygon | null, id = 'ov-aoi') {
  const prev = viewer.entities.getById(id);
  if (prev) viewer.entities.remove(prev);
  const prevLine = viewer.entities.getById(`${id}-line`);
  if (prevLine) viewer.entities.remove(prevLine);
  if (!g) return;
  const flat = g.coordinates[0].flatMap((c) => [c[0], c[1]]);
  viewer.entities.add({
    id,
    polygon: {
      hierarchy: Cesium.Cartesian3.fromDegreesArray(flat),
      material: CYAN.withAlpha(0.16),
      height: 0,
    },
  });
  viewer.entities.add({
    id: `${id}-line`,
    polyline: { positions: Cesium.Cartesian3.fromDegreesArray(flat), width: 2, material: CYAN, arcType: Cesium.ArcType.GEODESIC },
  });
}

export type DrawMode = 'point' | 'rectangle' | 'polygon' | 'line';

/**
 * Interactive drawing on the ellipsoid. Resolves with lon/lat vertices.
 * Polygon / line: click to add vertices, double-click or right-click to finish. Esc cancels.
 */
export function drawOnGlobe(viewer: Cesium.Viewer, mode: DrawMode): { promise: Promise<[number, number][] | null>; cancel: () => void } {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  const pts: Cesium.Cartesian3[] = [];
  let hover: Cesium.Cartesian3 | null = null;
  let resolveFn: (v: [number, number][] | null) => void = () => {};
  const promise = new Promise<[number, number][] | null>((r) => (resolveFn = r));

  const pick = (pos: Cesium.Cartesian2) => viewer.camera.pickEllipsoid(pos, viewer.scene.globe.ellipsoid) ?? null;
  const toLL = (c: Cesium.Cartesian3): [number, number] => {
    const k = Cesium.Cartographic.fromCartesian(c);
    return [Cesium.Math.toDegrees(k.longitude), Cesium.Math.toDegrees(k.latitude)];
  };

  const temp = viewer.entities.add({
    id: `ov-draw-${Date.now()}`,
    polyline: {
      positions: new Cesium.CallbackProperty(() => {
        if (mode === 'rectangle' && pts.length === 1 && hover) {
          const [a, b] = [toLL(pts[0]), toLL(hover)];
          return Cesium.Cartesian3.fromDegreesArray([a[0], a[1], b[0], a[1], b[0], b[1], a[0], b[1], a[0], a[1]]);
        }
        const arr = hover ? [...pts, hover] : [...pts];
        if (mode === 'polygon' && arr.length > 2) arr.push(arr[0]);
        return arr;
      }, false),
      width: 2,
      material: CYAN_SOFT,
      arcType: Cesium.ArcType.GEODESIC,
    },
  });

  const finish = (val: [number, number][] | null) => {
    handler.destroy();
    window.removeEventListener('keydown', onKey);
    if (!viewer.isDestroyed()) viewer.entities.remove(temp);
    viewer.scene.canvas.style.cursor = '';
    resolveFn(val);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') finish(null);
  };
  window.addEventListener('keydown', onKey);
  viewer.scene.canvas.style.cursor = 'crosshair';

  handler.setInputAction((e: any) => {
    hover = pick(e.endPosition);
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction((e: any) => {
    const c = pick(e.position);
    if (!c) return;
    if (mode === 'point') return finish([toLL(c)]);
    pts.push(c);
    if (mode === 'rectangle' && pts.length === 2) {
      const [a, b] = [toLL(pts[0]), toLL(pts[1])];
      const w = Math.min(a[0], b[0]), e2 = Math.max(a[0], b[0]), s = Math.min(a[1], b[1]), n = Math.max(a[1], b[1]);
      finish([[w, s], [e2, s], [e2, n], [w, n], [w, s]]);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  const complete = () => {
    // a double-click also fires two single clicks — drop near-duplicate trailing vertices
    for (let i = pts.length - 1; i > 0; i--) {
      if (Cesium.Cartesian3.distance(pts[i], pts[i - 1]) < 50) pts.splice(i, 1);
    }
    if (mode === 'polygon' && pts.length >= 3) {
      const ring = pts.map(toLL);
      ring.push(ring[0]);
      finish(ring);
    } else if (mode === 'line' && pts.length >= 2) finish(pts.map(toLL));
  };
  handler.setInputAction(complete, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  handler.setInputAction(complete, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

  return { promise, cancel: () => finish(null) };
}

export function julian(d: Date) {
  return Cesium.JulianDate.fromDate(d);
}
