// Drag-to-edit an AOI on the globe. Rectangles keep their shape (dragging a corner moves the two
// adjacent edges); polygons move single vertices. The edited geometry is real GeoJSON.
import { Cesium, CYAN } from './cesium';

export function isRectangle(g: GeoJSON.Polygon): boolean {
  const r = g.coordinates[0];
  if (r.length !== 5) return false;
  const xs = new Set(r.slice(0, 4).map((c) => c[0].toFixed(9)));
  const ys = new Set(r.slice(0, 4).map((c) => c[1].toFixed(9)));
  return xs.size === 2 && ys.size === 2;
}

export function bounds(g: GeoJSON.Polygon) {
  const xs = g.coordinates[0].map((c) => c[0]);
  const ys = g.coordinates[0].map((c) => c[1]);
  return { west: Math.min(...xs), east: Math.max(...xs), south: Math.min(...ys), north: Math.max(...ys) };
}

const rectRing = (w: number, s: number, e: number, n: number) => [[w, s], [e, s], [e, n], [w, n], [w, s]];

/** Start editing; returns a stop function. onChange fires on every drag end with the new polygon. */
export function editAoi(viewer: Cesium.Viewer, geometry: GeoJSON.Polygon, onChange: (g: GeoJSON.Polygon) => void): () => void {
  const rect = isRectangle(geometry);
  let ring = geometry.coordinates[0].slice(0, -1).map((c) => [c[0], c[1]]);
  const handles: Cesium.Entity[] = [];
  const outline = viewer.entities.add({
    id: `aoi-edit-${Date.now()}`,
    polyline: {
      positions: new Cesium.CallbackProperty(() => Cesium.Cartesian3.fromDegreesArray([...ring, ring[0]].flat()), false),
      width: 2,
      material: new Cesium.PolylineDashMaterialProperty({ color: CYAN, dashLength: 10 }),
      arcType: Cesium.ArcType.GEODESIC,
      clampToGround: true,
    },
  });
  const mkHandles = () => {
    handles.forEach((h) => viewer.entities.remove(h));
    handles.length = 0;
    ring.forEach((_, i) =>
      handles.push(
        viewer.entities.add({
          position: new Cesium.CallbackProperty(() => Cesium.Cartesian3.fromDegrees(ring[i][0], ring[i][1]), false) as any,
          point: { pixelSize: 11, color: Cesium.Color.WHITE, outlineColor: CYAN, outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY },
          properties: { aoiHandle: i },
        }),
      ),
    );
  };
  mkHandles();

  const h = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  let dragging: number | null = null;
  const ctl = viewer.scene.screenSpaceCameraController;
  const pick = (pos: Cesium.Cartesian2) => {
    const ray = viewer.camera.getPickRay(pos);
    const c = ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined;
    return c ?? viewer.camera.pickEllipsoid(pos, viewer.scene.globe.ellipsoid) ?? null;
  };
  h.setInputAction((e: any) => {
    const picked = viewer.scene.pick(e.position);
    const idx = picked?.id?.properties?.aoiHandle?.getValue?.();
    if (typeof idx === 'number') {
      dragging = idx;
      ctl.enableInputs = false;
    }
  }, Cesium.ScreenSpaceEventType.LEFT_DOWN);
  h.setInputAction((e: any) => {
    if (dragging == null) return;
    const c = pick(e.endPosition);
    if (!c) return;
    const k = Cesium.Cartographic.fromCartesian(c);
    const lon = Cesium.Math.toDegrees(k.longitude), lat = Cesium.Math.toDegrees(k.latitude);
    if (rect) {
      // corners 0:SW 1:SE 2:NE 3:NW — move the two edges that meet at the dragged corner
      const b = { w: ring[0][0], s: ring[0][1], e: ring[2][0], n: ring[2][1] };
      if (dragging === 0 || dragging === 3) b.w = lon; else b.e = lon;
      if (dragging === 0 || dragging === 1) b.s = lat; else b.n = lat;
      ring = rectRing(Math.min(b.w, b.e), Math.min(b.s, b.n), Math.max(b.w, b.e), Math.max(b.s, b.n)).slice(0, 4);
    } else {
      ring[dragging] = [lon, lat];
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  h.setInputAction(() => {
    if (dragging == null) return;
    dragging = null;
    ctl.enableInputs = true;
    onChange({ type: 'Polygon', coordinates: [[...ring.map((c) => [c[0], c[1]]), [ring[0][0], ring[0][1]]]] });
  }, Cesium.ScreenSpaceEventType.LEFT_UP);

  return () => {
    h.destroy();
    ctl.enableInputs = true;
    if (!viewer.isDestroyed()) {
      handles.forEach((x) => viewer.entities.remove(x));
      viewer.entities.remove(outline);
    }
  };
}

// ---------------------------------------------------------------- favourites

export interface FavAoi {
  id: string;
  name: string;
  description: string;
  geometry: GeoJSON.Polygon;
  savedAt: string;
}

const FAV_KEY = 'ov.aoi.favourites.v1';

export function readFavourites(): FavAoi[] {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
  } catch {
    return [];
  }
}
export function writeFavourites(list: FavAoi[]) {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}
