import { useEffect, useRef } from 'react';
import { Cesium } from '../lib/cesium';
import { propagateSubPoint, type SatRecord } from '../lib/orbit';
import { SENSOR_COLOR } from '../data/providers';

/**
 * Renders satellites as point primitives on a viewer, re-propagated on the Cesium clock (SGP4).
 * Calls onTick with the simulation time (throttled) and onPick when a point is clicked.
 */
export function useSatPoints(
  viewer: Cesium.Viewer | null,
  sats: SatRecord[],
  selectedId: string | null,
  opts: { onPick?: (id: string) => void; onTick?: (t: Date) => void } = {},
) {
  const coll = useRef<Cesium.PointPrimitiveCollection | null>(null);
  const map = useRef(new Map<string, Cesium.PointPrimitive>());
  const cb = useRef(opts);
  cb.current = opts;

  useEffect(() => {
    if (!viewer) return;
    const c = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    coll.current = c;
    const h = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    h.setInputAction((e: any) => {
      const picked = viewer.scene.pick(e.position);
      if (picked && picked.primitive instanceof Cesium.PointPrimitive && typeof picked.id === 'string') cb.current.onPick?.(picked.id);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return () => {
      h.destroy();
      if (!viewer.isDestroyed()) viewer.scene.primitives.remove(c);
      coll.current = null;
      map.current.clear();
    };
  }, [viewer]);

  useEffect(() => {
    const c = coll.current;
    if (!viewer || !c) return;
    c.removeAll();
    map.current.clear();
    const t = Cesium.JulianDate.toDate(viewer.clock.currentTime);
    for (const s of sats) {
      const p = propagateSubPoint(s, t);
      if (!p) continue;
      const sel = s.noradId === selectedId;
      map.current.set(
        s.noradId,
        c.add({
          id: s.noradId,
          position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.heightKm * 1000),
          pixelSize: sel ? 10 : 6,
          color: Cesium.Color.fromCssColorString(SENSOR_COLOR[s.mission?.sensor ?? 'unknown']),
          outlineColor: sel ? Cesium.Color.WHITE : Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: sel ? 2 : 1,
          scaleByDistance: new Cesium.NearFarScalar(1.5e6, 1.4, 4e7, 0.7),
        }),
      );
    }
  }, [viewer, sats, selectedId]);

  useEffect(() => {
    if (!viewer) return;
    let last = 0;
    const byId = new Map<string, SatRecord>(sats.map((s) => [s.noradId, s] as [string, SatRecord]));
    return viewer.clock.onTick.addEventListener((clock) => {
      const now = performance.now();
      if (now - last < 250) return;
      last = now;
      const t = Cesium.JulianDate.toDate(clock.currentTime);
      map.current.forEach((pt, id) => {
        const s = byId.get(id);
        const p = s && propagateSubPoint(s, t);
        if (p) pt.position = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.heightKm * 1000);
      });
      cb.current.onTick?.(t);
    });
  }, [viewer, sats]);
}

/** Set the viewer clock to "now" running at `multiplier`× speed. */
export function setLiveClock(viewer: Cesium.Viewer, multiplier = 1) {
  const now = new Date();
  const c = viewer.clock;
  c.startTime = Cesium.JulianDate.fromDate(new Date(now.getTime() - 3 * 3600e3));
  c.stopTime = Cesium.JulianDate.fromDate(new Date(now.getTime() + 24 * 3600e3));
  c.currentTime = Cesium.JulianDate.fromDate(now);
  c.clockRange = Cesium.ClockRange.UNBOUNDED;
  c.multiplier = multiplier;
  c.shouldAnimate = true;
}
