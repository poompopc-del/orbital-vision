import { useRef, useState } from 'react';
import { t } from '../i18n';
import { useWorkspace } from '../store';
import { aoiFromFile, areaKm2, bboxPolygon, geocode, pointAoi, type GeocodeHit } from '../lib/geo';
import { Cesium, drawOnGlobe, flyToPolygon, type DrawMode } from '../lib/cesium';
import { logAudit } from '../lib/repo';
import { Button, Input, Spinner, cx } from './ui';

export default function AoiPicker({ viewer, compact }: { viewer?: Cesium.Viewer | null; compact?: boolean }) {
  const { aoi, setAoi } = useWorkspace();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<GeocodeHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [drawing, setDrawing] = useState<DrawMode | null>(null);
  const cancelRef = useRef<() => void>();
  const fileRef = useRef<HTMLInputElement>(null);

  const apply = (geometry: GeoJSON.Polygon, name: string, source: 'drawn' | 'search' | 'coordinates' | 'import') => {
    setAoi({ geometry, name, source });
    if (viewer && !viewer.isDestroyed()) flyToPolygon(viewer, geometry);
    void logAudit('aoi.set', { name, source, areaKm2: Math.round(areaKm2(geometry)) });
  };

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setErr('');
    try {
      const r = await geocode(q);
      setHits(r);
      if (!r.length) setErr('No match');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const pick = (h: GeocodeHit) => {
    setHits([]);
    const isPoint = !h.bbox || (h.bbox[2] - h.bbox[0] < 0.01 && h.bbox[3] - h.bbox[1] < 0.01);
    const geom = isPoint ? pointAoi(h.lon, h.lat, 10) : bboxPolygon(...(h.bbox as [number, number, number, number]));
    apply(geom, h.label.split(',').slice(0, 2).join(','), isPoint && !h.bbox ? 'coordinates' : 'search');
  };

  const startDraw = async (mode: DrawMode) => {
    if (!viewer) return;
    cancelRef.current?.();
    setDrawing(mode);
    const d = drawOnGlobe(viewer, mode);
    cancelRef.current = d.cancel;
    const pts = await d.promise;
    setDrawing(null);
    if (!pts) return;
    if (mode === 'point') apply(pointAoi(pts[0][0], pts[0][1], 10), `POI ${pts[0][1].toFixed(4)}, ${pts[0][0].toFixed(4)}`, 'drawn');
    else apply({ type: 'Polygon', coordinates: [pts] }, mode === 'rectangle' ? 'Drawn rectangle' : 'Drawn polygon', 'drawn');
  };

  const onFile = async (f?: File) => {
    if (!f) return;
    setErr('');
    try {
      apply(await aoiFromFile(f), f.name, 'import');
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div className="space-y-2">
      <div className="relative flex gap-1.5">
        <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder={t('Place, country, or lat, lon')} />
        <Button onClick={search} disabled={busy}>{busy ? <Spinner /> : t('Go')}</Button>
        {hits.length > 0 && (
          <ul className="absolute left-0 right-0 top-9 z-40 max-h-64 overflow-auto rounded border border-line bg-navy-850 shadow-xl scroll-thin">
            {hits.map((h, i) => (
              <li key={i}>
                <button onClick={() => pick(h)} className="block w-full px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-navy-700">
                  {h.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {viewer !== undefined && (
        <div className="grid grid-cols-3 gap-1.5">
          {(['point', 'rectangle', 'polygon'] as DrawMode[]).map((m) => (
            <Button key={m} variant={drawing === m ? 'active' : 'ghost'} onClick={() => startDraw(m)} disabled={!viewer} className="capitalize">
              {m === 'point' ? t('POI') : t(m)}
            </Button>
          ))}
        </div>
      )}
      {drawing && (
        <p className="text-[11px] text-cyan-300">
          {drawing === 'point' ? t('Click the globe.') : drawing === 'rectangle' ? t('Click two corners.') : t('Click vertices; double-click or right-click to finish.')} {t('Esc cancels.')}
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <Button onClick={() => fileRef.current?.click()} className="flex-1">{t('Import GeoJSON / KML')}</Button>
        {aoi && <Button variant="danger" onClick={() => setAoi(null)}>{t('Clear')}</Button>}
        <input ref={fileRef} type="file" accept=".geojson,.json,.kml" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
      </div>
      {err && <p className="text-[11px] text-bad">{err}</p>}
      {aoi && (
        <div className={cx('rounded border border-cyan-400/30 bg-cyan-400/5 px-2.5 py-2', compact && 'py-1.5')}>
          <div className="label text-cyan-300">{t('Area of interest')}</div>
          <div className="truncate text-xs text-white">{aoi.name}</div>
          <div className="font-mono text-[10px] text-muted">
            {areaKm2(aoi.geometry).toLocaleString(undefined, { maximumFractionDigits: 1 })} km² · {aoi.source}
          </div>
        </div>
      )}
    </div>
  );
}
