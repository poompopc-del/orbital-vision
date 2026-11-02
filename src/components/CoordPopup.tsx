// Right-click on any map: show the coordinates of that spot (decimal, DMS, UTM) with copy buttons.
import { useEffect, useState } from 'react';
import { Cesium, drawingActive } from '../lib/cesium';
import { lonLatToUtm } from '../lib/projection';
import { t } from '../i18n';

const dms = (v: number, pos: string, neg: string) => {
  const a = Math.abs(v);
  const d = Math.floor(a);
  const mf = (a - d) * 60;
  const m = Math.floor(mf);
  const s = (mf - m) * 60;
  return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(2).padStart(5, '0')}″${v >= 0 ? pos : neg}`;
};

interface Hit {
  x: number;
  y: number;
  lat: number;
  lon: number;
  h: number | null;
}

export default function CoordPopup({ viewer }: { viewer: Cesium.Viewer | null }) {
  const [hit, setHit] = useState<Hit | null>(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (!viewer) return;
    const canvas = viewer.scene.canvas;
    const noMenu = (e: MouseEvent) => e.preventDefault();
    canvas.addEventListener('contextmenu', noMenu);
    const h = new Cesium.ScreenSpaceEventHandler(canvas);
    h.setInputAction((e: any) => {
      if (drawingActive) return; // right-click finishes a polygon while drawing
      const ray = viewer.camera.getPickRay(e.position);
      const c = (ray && viewer.scene.globe.pick(ray, viewer.scene)) || viewer.camera.pickEllipsoid(e.position, viewer.scene.globe.ellipsoid);
      if (!c) return setHit(null);
      const k = Cesium.Cartographic.fromCartesian(c);
      const terrainOn = !(viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider);
      setCopied('');
      setHit({ x: e.position.x, y: e.position.y, lat: Cesium.Math.toDegrees(k.latitude), lon: Cesium.Math.toDegrees(k.longitude), h: terrainOn ? k.height : null });
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    // any left click or camera move closes it
    h.setInputAction(() => setHit(null), Cesium.ScreenSpaceEventType.LEFT_DOWN);
    h.setInputAction(() => setHit(null), Cesium.ScreenSpaceEventType.WHEEL);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setHit(null);
    window.addEventListener('keydown', onKey);
    return () => {
      canvas.removeEventListener('contextmenu', noMenu);
      window.removeEventListener('keydown', onKey);
      if (!h.isDestroyed()) h.destroy();
    };
  }, [viewer]);

  if (!hit) return null;
  const utm = lonLatToUtm(hit.lon, hit.lat);
  const rows: [string, string][] = [
    ['Lat, Lon', `${hit.lat.toFixed(6)}, ${hit.lon.toFixed(6)}`],
    ['DMS', `${dms(hit.lat, 'N', 'S')} ${dms(hit.lon, 'E', 'W')}`],
    [`UTM ${utm.zone}${utm.north ? 'N' : 'S'}`, `${utm.e.toFixed(0)} E  ${utm.n.toFixed(0)} N`],
  ];
  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setCopied('');
    }
  };
  // keep the box inside the map
  const parent = viewer?.scene.canvas.getBoundingClientRect();
  const left = Math.min(hit.x + 8, (parent?.width ?? 9999) - 280);
  const top = Math.min(hit.y + 8, (parent?.height ?? 9999) - 140);

  return (
    <div
      className="absolute z-40 w-[272px] rounded-md border border-line bg-ink-900/95 text-xs shadow-panel"
      style={{ left: Math.max(4, left), top: Math.max(4, top) }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5">
        <span className="label">{t('Coordinates')} · WGS84</span>
        <button className="text-muted hover:text-white" onClick={() => setHit(null)} aria-label={t('Close')}>✕</button>
      </div>
      <div className="px-2.5 py-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center gap-2 py-0.5">
            <span className="w-16 shrink-0 font-mono text-[10px] text-muted">{k}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white" title={v}>{v}</span>
            <button className="shrink-0 text-[10px] text-cyan-300 hover:text-white" onClick={() => copy(k, v)}>
              {copied === k ? t('Copied') : t('Copy')}
            </button>
          </div>
        ))}
        {hit.h != null && <div className="pt-0.5 font-mono text-[10px] text-muted">{t('Terrain height')} ≈ {hit.h.toFixed(0)} m (WGS84)</div>}
      </div>
    </div>
  );
}
