import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { Link } from 'react-router-dom';
import GlobeHost from '../components/GlobeHost';
import { Badge, Button, KV, Notice, Panel, cx } from '../components/ui';
import { Cesium, CYAN_SOFT, drawOnGlobe, flyToBbox, showAoi } from '../lib/cesium';
import { useWorkspace } from '../store';
import { downloadJson, lineLengthKm, polygonAreaKm2 } from '../lib/geo';
import { fmtNum, fmtUtc } from '../lib/format';
import { addSceneLayer, type ImageryItem } from '../lib/stac';

const COLL_COLOR: Record<string, string> = { 'sentinel-2-l2a': '#22d3ee', 'landsat-c2-l2': '#4f8dff', 'sentinel-1-grd': '#f5b84b' };

function Timeline({ items, picked, onPick }: { items: ImageryItem[]; picked: string[]; onPick: (i: ImageryItem) => void }) {
  if (!items.length) return <p className="text-xs text-muted">{t('No archive results yet — run a search in Imagery Explorer to populate the AOI timeline.')}</p>;
  const ts = items.map((i) => new Date(i.datetime).getTime());
  const min = Math.min(...ts), max = Math.max(...ts);
  const span = Math.max(1, max - min);
  const rows = [...new Set(items.map((i) => i.collection))];
  return (
    <div>
      <svg viewBox="0 0 600 90" className="w-full" preserveAspectRatio="none">
        {rows.map((r, ri) => (
          <g key={r}>
            <line x1={0} x2={600} y1={20 + ri * 24} y2={20 + ri * 24} stroke="rgba(148,178,214,0.15)" />
            {items.filter((i) => i.collection === r).map((i) => {
              const x = 6 + ((new Date(i.datetime).getTime() - min) / span) * 588;
              const on = picked.includes(i.id);
              return (
                <circle
                  key={i.id}
                  cx={x}
                  cy={20 + ri * 24}
                  r={on ? 6 : 3.5}
                  fill={COLL_COLOR[r] ?? '#7ce7f7'}
                  stroke={on ? '#fff' : 'none'}
                  className="cursor-pointer"
                  onClick={() => onPick(i)}
                >
                  <title>{`${i.collectionLabel} · ${fmtUtc(i.datetime)}${i.cloudCover != null ? ` · cloud ${i.cloudCover.toFixed(0)}%` : ''}`}</title>
                </circle>
              );
            })}
          </g>
        ))}
      </svg>
      <div className="flex justify-between font-mono text-[10px] text-muted">
        <span>{fmtUtc(new Date(min))}</span>
        <span className="flex gap-3">
          {rows.map((r) => (
            <span key={r} className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: COLL_COLOR[r] }} />{items.find((i) => i.collection === r)?.collectionLabel}</span>
          ))}
        </span>
        <span>{fmtUtc(new Date(max))}</span>
      </div>
    </div>
  );
}

export default function ImageAnalysis() {
  const { compare, toggleCompare, clearCompare, lastResults, aoi } = useWorkspace();
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const [split, setSplit] = useState(0.5);
  const [layerErr, setLayerErr] = useState<string[]>([]);
  const [measure, setMeasure] = useState<{ kind: 'line' | 'polygon'; value: string } | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const layers = useRef<Cesium.ImageryLayer[]>([]);
  const [a, b] = compare;

  useEffect(() => {
    if (viewer) showAoi(viewer, aoi?.geometry ?? null);
  }, [viewer, aoi]);

  // preview overlays (genuine thumbnails placed on the item bounding box)
  useEffect(() => {
    if (!viewer) return;
    let cancelled = false;
    layers.current.forEach((l) => viewer.imageryLayers.remove(l, true));
    layers.current = [];
    setLayerErr([]);
    const items = [a, b].filter(Boolean) as ImageryItem[];
    items.forEach(async (it, idx) => {
      if (!it.thumbnail && !it.tilejson) {
        setLayerErr((e) => [...e, `${it.id}: no preview asset`]);
        return;
      }
      try {
        // full-resolution tiles when the scene has them; otherwise the preview image on the item bbox
        let layer = it.tilejson ? await addSceneLayer(viewer, it).catch(() => null) : null;
        if (cancelled || viewer.isDestroyed()) {
          if (layer && !viewer.isDestroyed()) viewer.imageryLayers.remove(layer, true);
          return;
        }
        if (!layer) {
          if (!it.thumbnail) throw new Error('no preview');
          const [w, s, e, n] = it.bbox;
          const prov = await Cesium.SingleTileImageryProvider.fromUrl(it.thumbnail, { rectangle: Cesium.Rectangle.fromDegrees(w, s, e, n) });
          if (cancelled || viewer.isDestroyed()) return;
          layer = viewer.imageryLayers.addImageryProvider(prov);
        }
        layer.alpha = 0.95;
        if (items.length === 2) layer.splitDirection = idx === 0 ? Cesium.SplitDirection.LEFT : Cesium.SplitDirection.RIGHT;
        layers.current.push(layer);
      } catch {
        setLayerErr((e) => [...e, `${it.id}: preview could not be loaded as a texture (CORS or network)`]);
      }
    });
    if (items[0]) flyToBbox(viewer, ...items[0].bbox);
    return () => {
      cancelled = true;
    };
  }, [viewer, a?.id, b?.id]);

  useEffect(() => {
    if (viewer) viewer.scene.splitPosition = split;
  }, [viewer, split]);

  const runMeasure = async (kind: 'line' | 'polygon') => {
    if (!viewer) return;
    setMeasuring(true);
    const old = viewer.entities.getById('measure');
    if (old) viewer.entities.remove(old);
    const pts = await drawOnGlobe(viewer, kind).promise;
    setMeasuring(false);
    if (!pts) return;
    viewer.entities.add({
      id: 'measure',
      polyline: { positions: Cesium.Cartesian3.fromDegreesArray(pts.flatMap((p) => p)), width: 2, material: CYAN_SOFT, arcType: Cesium.ArcType.GEODESIC },
    });
    if (kind === 'line') setMeasure({ kind, value: `${fmtNum(lineLengthKm(pts), 3)} km (geodesic)` });
    else setMeasure({ kind, value: `${fmtNum(polygonAreaKm2(pts.slice(0, -1)), 3)} km²` });
  };

  const bandAssets = (it?: ImageryItem) =>
    it ? Object.entries(it.assets).filter(([, v]) => (v.type || '').includes('tiff')).map(([k]) => k) : [];

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <div className="relative min-h-[360px] flex-1">
        <GlobeHost onReady={setViewer} />
        {compare.length === 2 && (
          <>
            <div className="pointer-events-none absolute inset-y-0 z-10 w-px bg-white/80" style={{ left: `${split * 100}%` }} />
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={split}
              onChange={(e) => setSplit(+e.target.value)}
              className="absolute bottom-6 left-1/2 z-20 w-2/3 -translate-x-1/2"
              aria-label={t('Swipe divider')}
            />
            <div className="pointer-events-none absolute left-3 top-3 z-10"><Badge tone="cyan">◀ {a.collectionLabel} · {a.datetime.slice(0, 10)}</Badge></div>
            <div className="pointer-events-none absolute right-3 top-3 z-10"><Badge tone="cyan">{b.collectionLabel} · {b.datetime.slice(0, 10)} ▶</Badge></div>
          </>
        )}
        <div className="pointer-events-none absolute bottom-14 left-3 z-10 max-w-sm">
          {compare.some((c) => c.tilejson) ? (
            <Badge tone="ok">{t('Real full-resolution image (rendered tiles, Microsoft Planetary Computer)')}</Badge>
          ) : (
            <Badge tone="warn">{t('Preview overlay — JPEG thumbnail placed on item bbox, approximate georeference, not radiometric data')}</Badge>
          )}
        </div>
      </div>

      <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-line bg-ink-900 p-3 scroll-thin lg:w-[400px] lg:border-l">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400">{t('G · Image Analysis')}</div>
          <h1 className="text-base font-semibold text-white">{t('Compare & measure')}</h1>
        </div>

        <Panel title={`${t('Comparison')} (${compare.length}/2)`} right={compare.length > 0 && <button onClick={clearCompare} className="text-[11px] text-muted hover:text-white">{t('Clear')}</button>}>
          {compare.length === 0 && (
            <p className="text-xs text-muted">{t('Pick two scenes from the timeline below or in')} <Link to="/imagery" className="text-cyan-300 underline">{t('Imagery Explorer')}</Link>{t('. Different dates or providers can be compared.')} </p>
          )}
          <div className="space-y-2">
            {compare.map((it, i) => (
              <div key={it.id} className="rounded border border-line p-2">
                <div className="mb-1 flex items-center justify-between">
                  <Badge tone="cyan">{i === 0 ? t('Left') : t('Right')} · {it.collectionLabel}</Badge>
                  <button onClick={() => toggleCompare(it)} className="text-[11px] text-muted hover:text-white">{t('Remove')}</button>
                </div>
                <dl>
                  <KV k={t('Scene')} v={it.id} mono />
                  <KV k={t('Acquired')} v={fmtUtc(it.datetime)} mono />
                  <KV k={t('Platform')} v={it.platform} />
                  <KV k="GSD" v={it.gsd} />
                  <KV k={t('Cloud')} v={it.cloudCover != null ? `${fmtNum(it.cloudCover, 1)}%` : 'n/a'} />
                  <KV k={t('Sun elevation')} v={it.sunElevation != null ? `${fmtNum(it.sunElevation, 1)}°` : 'n/a'} />
                  <KV k={t('Processing')} v={it.level} />
                  <KV k={t('AOI coverage')} v={it.coveragePct != null ? `${fmtNum(it.coveragePct, 0)}%` : 'n/a'} />
                  <KV k={t('Band assets (COG)')} v={bandAssets(it).join(', ') || 'n/a'} />
                </dl>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  <Button onClick={() => downloadJson(`${it.id}-metadata.json`, { id: it.id, collection: it.collection, datetime: it.datetime, bbox: it.bbox, geometry: it.geometry, assets: it.assets, stac: it.selfHref })}>{t('Export metadata')} </Button>
                  {it.assets.visual?.href && <a href={it.assets.visual.href} target="_blank" rel="noreferrer"><Button>{t('Visual COG ↗')}</Button></a>}
                </div>
              </div>
            ))}
          </div>
          {layerErr.length > 0 && <div className="mt-2"><Notice tone="warn">{layerErr.join(' · ')}</Notice></div>}
        </Panel>

        <Panel title={t('AOI acquisition timeline')}>
          <Timeline items={lastResults} picked={compare.map((c) => c.id)} onPick={toggleCompare} />
        </Panel>

        <Panel title={t('Measure')}>
          <div className="grid grid-cols-2 gap-1.5">
            <Button onClick={() => runMeasure('line')} disabled={!viewer || measuring}>{t('Distance')}</Button>
            <Button onClick={() => runMeasure('polygon')} disabled={!viewer || measuring}>{t('Area')}</Button>
          </div>
          {measuring && <p className="mt-1.5 text-[11px] text-cyan-300">{t('Click points; double-click or right-click to finish.')}</p>}
          {measure && <div className="mt-2 font-mono text-sm text-white">{measure.value}</div>}
        </Panel>

        <Panel title={t('Display & pixel tools')}>
          <div className="space-y-1.5 text-xs">
            {[
              ['Natural colour (RGB)', 'Full-resolution rendered tiles (Planetary Computer)', true],
              ['False colour composites', 'Needs per-band COG reading (nir, swir) — not integrated yet', false],
              ['SAR display (dB stretch)', 'Needs GRD COG access (requester-pays bucket) — not integrated yet', false],
              ['Pixel values', 'Unavailable on JPEG previews; requires COG band integration', false],
            ].map(([k, v, ok]) => (
              <div key={k as string} className={cx('flex items-start justify-between gap-2 border-b border-white/5 pb-1.5 last:border-0')}>
                <span className="text-slate-200">{t(k as string)}</span>
                <span className="max-w-[200px] text-right text-[11px] text-muted">{ok ? <Badge tone="ok">{t('Available')}</Badge> : <Badge>{t('Planned')}</Badge>} {t(v as string)}</span>
              </div>
            ))}
          </div>
        </Panel>
      </aside>
    </div>
  );
}
