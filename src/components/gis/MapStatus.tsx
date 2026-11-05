import { useEffect, useState } from 'react';
import { Cesium } from '../../lib/cesium';
import { tl } from '../../lib/classify/i18n';

/** Nice round scale-bar length (m) not longer than `max`. */
function niceLength(max: number) {
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [5, 2, 1]) if (m * p <= max) return m * p;
  return p;
}

/**
 * Map status strip: cursor coordinates, coordinate system, scale bar, north arrow and layer count.
 * Updates on camera movement only (no per-frame work), so it does not slow the globe down.
 */
export default function MapStatus({ viewer, cursor, layers }: { viewer: Cesium.Viewer | null; cursor: { lat: number; lon: number } | null; layers: number }) {
  const [scale, setScale] = useState<{ px: number; label: string } | null>(null);
  const [heading, setHeading] = useState(0);

  useEffect(() => {
    if (!viewer) return;
    const cam = viewer.camera;
    const update = () => {
      if (viewer.isDestroyed()) return;
      setHeading(Cesium.Math.toDegrees(cam.heading));
      const c = viewer.scene.canvas;
      const y = c.clientHeight - 30;
      const x0 = c.clientWidth / 2 - 60, x1 = c.clientWidth / 2 + 60;
      const ell = viewer.scene.globe.ellipsoid;
      const a = cam.pickEllipsoid(new Cesium.Cartesian2(x0, y), ell);
      const b = cam.pickEllipsoid(new Cesium.Cartesian2(x1, y), ell);
      if (!a || !b) return setScale(null);
      const g = new Cesium.EllipsoidGeodesic(Cesium.Cartographic.fromCartesian(a), Cesium.Cartographic.fromCartesian(b));
      const mPerPx = g.surfaceDistance / (x1 - x0);
      if (!Number.isFinite(mPerPx) || mPerPx <= 0) return setScale(null);
      const len = niceLength(mPerPx * 100);
      setScale({ px: len / mPerPx, label: len >= 1000 ? `${len / 1000} ${tl('km', 'กม.')}` : `${len} ${tl('m', 'ม.')}` });
    };
    cam.percentageChanged = 0.05;
    const off = cam.changed.addEventListener(update);
    const t = setTimeout(update, 600);
    return () => {
      off();
      clearTimeout(t);
    };
  }, [viewer]);

  return (
    <>
      <button
        type="button"
        className="ov-float absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center"
        title={tl('North up', 'หันทิศเหนือขึ้น')}
        aria-label={tl('North arrow — click to face north', 'ลูกศรทิศเหนือ · คลิกเพื่อหันทิศเหนือขึ้น')}
        onClick={() => viewer && !viewer.isDestroyed() && viewer.camera.flyTo({ destination: viewer.camera.positionWC.clone(), orientation: { heading: 0, pitch: viewer.camera.pitch, roll: 0 }, duration: 0.6 })}
      >
        <svg viewBox="0 0 24 24" className="h-6 w-6 transition-transform duration-200" style={{ transform: `rotate(${-heading}deg)` }} aria-hidden>
          <path d="M12 3l4 9h-8z" fill="#e5594f" />
          <path d="M12 21l-4-9h8z" fill="#8b969c" />
          <text x="12" y="2.8" textAnchor="middle" fontSize="4" fill="#e3e7e9" fontFamily="IBM Plex Mono, monospace">N</text>
        </svg>
      </button>
      <div className="ov-float pointer-events-none absolute bottom-7 left-3 z-10 flex items-center gap-3 px-2 py-1 font-mono text-[10px] text-slate-300">
        <span className="min-w-[150px]">{cursor ? `${cursor.lat.toFixed(5)}°, ${cursor.lon.toFixed(5)}°` : tl('move over the map', 'เลื่อนเมาส์บนแผนที่')}</span>
        <span className="hidden text-muted sm:inline" title="WGS 84 geographic coordinates">WGS 84 · EPSG:4326</span>
        {scale && (
          <span className="flex items-center gap-1.5">
            <span className="block h-1.5 border-x border-b border-slate-300" style={{ width: `${Math.round(scale.px)}px` }} />
            {scale.label}
          </span>
        )}
        <span className="hidden text-muted md:inline">{layers} {tl('layers on', 'ชั้นข้อมูลที่เปิด')}</span>
      </div>
    </>
  );
}
