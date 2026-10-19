import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { Badge, Button, Notice } from '../ui';
import { BASEMAPS, OVERLAYS, type BasemapId, type OverlayId } from '../../lib/basemaps';
import { Cesium } from '../../lib/cesium';
import { useGis } from './GisContext';

export default function LayersPanel({ basemap, setBasemap }: { basemap: BasemapId; setBasemap: (b: BasemapId) => void }) {
  const g = useGis();
  const [ov, setOv] = useState<Record<OverlayId, { on: boolean; alpha: number }>>({ roads: { on: false, alpha: 1 }, labels: { on: true, alpha: 0.9 } });
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  // the Hybrid basemap switches both reference overlays on
  useEffect(() => {
    if (basemap === 'hybrid') setOv((o) => ({ roads: { ...o.roads, on: true }, labels: { ...o.labels, on: true } }));
  }, [basemap]);

  const toggleOverlay = async (id: OverlayId, on: boolean) => {
    setOv((o) => ({ ...o, [id]: { ...o[id], on } }));
    await g.controller?.setOverlay(id, on, ov[id].alpha);
  };

  const importGeoJson = async (f?: File) => {
    if (!f || !g.viewer) return;
    setErr('');
    try {
      const text = await f.text();
      const json = JSON.parse(text);
      const ds = await Cesium.GeoJsonDataSource.load(json, {
        stroke: Cesium.Color.fromCssColorString('#ffb347'),
        fill: Cesium.Color.fromCssColorString('#ffb347').withAlpha(0.15),
        strokeWidth: 2,
        clampToGround: true,
      });
      const n = ds.entities.values.length;
      g.putDataSource(`geojson-${f.name}`, f.name, ds, { meta: `${n} features · user file`, legend: { items: [{ color: '#ffb347', label: f.name }] } });
      void g.viewer.flyTo(ds);
    } catch (e: any) {
      setErr(`${t('Could not read GeoJSON')}: ${e.message}`);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="label mb-1.5">{t('Basemap')}</div>
        <div className="grid grid-cols-2 gap-1">
          {BASEMAPS.map((b) => (
            <Button key={b.id} variant={basemap === b.id ? 'active' : 'ghost'} onClick={() => setBasemap(b.id)} title={b.note}>
              {t(b.label)}
            </Button>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-muted">{BASEMAPS.find((b) => b.id === basemap)?.note}</p>
      </div>

      <div>
        <div className="label mb-1.5">{t('Reference overlays')}</div>
        {OVERLAYS.map((o) => (
          <div key={o.id} className="mb-1.5">
            <label className="flex items-center gap-2 text-xs text-slate-200">
              <input type="checkbox" checked={ov[o.id].on} onChange={(e) => toggleOverlay(o.id, e.target.checked)} />
              {t(o.label)}
            </label>
            {ov[o.id].on && (
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={ov[o.id].alpha}
                onChange={(e) => {
                  const a = +e.target.value;
                  setOv((x) => ({ ...x, [o.id]: { ...x[o.id], alpha: a } }));
                  g.controller?.setOverlayAlpha(o.id, a);
                }}
                className="ml-5 w-[calc(100%-20px)]"
              />
            )}
            <p className="ml-5 text-[10px] leading-snug text-muted">{t(o.note)}</p>
          </div>
        ))}
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="label">{t('Layer manager')}</span>
          <Button onClick={() => fileRef.current?.click()}>+ GeoJSON</Button>
          <input ref={fileRef} type="file" accept=".geojson,.json" className="hidden" onChange={(e) => importGeoJson(e.target.files?.[0])} />
        </div>
        {err && <Notice tone="bad">{err}</Notice>}
        {g.layers.length === 0 && <p className="text-[11px] text-muted">{t('Analysis results, imported GeoJSON and derived layers appear here.')}</p>}
        <ul className="space-y-1">
          {[...g.layers].reverse().map((l) => (
            <li key={l.id} className="rounded border border-line px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <input type="checkbox" checked={l.show} onChange={(e) => g.setLayer(l.id, { show: e.target.checked })} />
                <span className="min-w-0 flex-1 truncate text-xs text-slate-200" title={l.name}>{l.name}</span>
                <Badge>{t(l.group)}</Badge>
                {l.layer && (
                  <>
                    <button title={t('Move up')} onClick={() => g.moveLayer(l.id, 1)} className="text-muted hover:text-white">▲</button>
                    <button title={t('Move down')} onClick={() => g.moveLayer(l.id, -1)} className="text-muted hover:text-white">▼</button>
                  </>
                )}
                <button title={t('Remove')} onClick={() => g.removeLayer(l.id)} className="text-muted hover:text-bad">✕</button>
              </div>
              {l.meta && <div className="mt-0.5 truncate font-mono text-[10px] text-muted" title={l.meta}>{l.meta}</div>}
              {l.layer && (
                <input type="range" min={0.05} max={1} step={0.05} value={l.alpha} onChange={(e) => g.setLayer(l.id, { alpha: +e.target.value })} className="mt-1 w-full" />
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function LegendBox() {
  const g = useGis();
  const shown = g.layers.filter((l) => l.show && l.legend);
  if (!shown.length) return null;
  return (
    <div className="max-h-[45vh] w-[260px] overflow-y-auto rounded-md border border-line bg-ink-950/90 p-2.5 text-[11px] shadow-xl backdrop-blur scroll-thin">
      <div className="label mb-1">{t('Legend')}</div>
      {shown.map((l) => (
        <div key={l.id} className="mb-2 last:mb-0">
          <div className="truncate text-slate-200">{l.name}</div>
          {l.legend!.ramp && (
            <>
              <div className="mt-0.5 h-2.5 rounded" style={{ background: l.legend!.ramp }} />
              {l.legend!.range && (
                <div className="flex justify-between font-mono text-[10px] text-muted">
                  <span>{l.legend!.range[0]}</span>
                  <span>{l.legend!.unit ?? ''}</span>
                  <span>{l.legend!.range[1]}</span>
                </div>
              )}
            </>
          )}
          {l.legend!.items?.map((it) => (
            <div key={it.label} className="flex items-center gap-1.5 text-slate-300">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: it.color }} />
              {it.label}
            </div>
          ))}
          {l.legend!.note && <div className="mt-0.5 text-[10px] leading-snug text-muted">{l.legend!.note}</div>}
        </div>
      ))}
    </div>
  );
}
