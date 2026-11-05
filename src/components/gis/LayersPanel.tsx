import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { Button, Notice, cx } from '../ui';
import { tl } from '../../lib/classify/i18n';
import { BASEMAPS, OVERLAYS, type BasemapId, type OverlayId } from '../../lib/basemaps';
import { Cesium } from '../../lib/cesium';
import { useGis, type LayerEntry } from './GisContext';

type Cat = 'imagery' | 'spectral' | 'landcover' | 'change' | 'water' | 'terrain' | 'vector' | 'imported';
const CATS: { id: Cat; en: string; th: string }[] = [
  { id: 'imagery', en: 'Satellite imagery', th: 'ภาพถ่ายดาวเทียม' },
  { id: 'spectral', en: 'Spectral indices', th: 'ดัชนีเชิงสเปกตรัม' },
  { id: 'landcover', en: 'Land cover', th: 'สิ่งปกคลุมดิน' },
  { id: 'change', en: 'Change detection', th: 'การเปลี่ยนแปลง' },
  { id: 'water', en: 'Flood & water', th: 'น้ำท่วมและแหล่งน้ำ' },
  { id: 'terrain', en: 'Terrain & hydrology', th: 'ภูมิประเทศและอุทกวิทยา' },
  { id: 'vector', en: 'Vector layers', th: 'ชั้นข้อมูลเวกเตอร์' },
  { id: 'imported', en: 'Imported data', th: 'ข้อมูลที่นำเข้า' },
];
export function layerCategory(id: string, group: string): Cat {
  if (id.startsWith('geojson-')) return 'imported';
  if (id.startsWith('lc-')) return 'landcover';
  if (id.startsWith('spectral')) return 'spectral';
  if (id.startsWith('change') || id.startsWith('swipe-')) return 'change';
  if (id.startsWith('flood') || id === 'osm-waterways') return 'water';
  if (id === 'hydro' || id.startsWith('terrain') || id === 'dams') return 'terrain';
  if (id === 'latest' || id.startsWith('query-scene') || id.startsWith('scene')) return 'imagery';
  return group === 'vector' ? 'vector' : 'imagery';
}

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
        {CATS.map((cat) => {
          const items = [...g.layers].reverse().filter((l) => layerCategory(l.id, l.group) === cat.id);
          if (!items.length) return null;
          return (
            <div key={cat.id} className="mb-2">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-muted">
                <span>{tl(cat.en, cat.th)}</span>
                <span className="font-mono">{items.length}</span>
              </div>
              <ul className="space-y-1">
                {items.map((l) => <LayerRow key={l.id} l={l} />)}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LayerRow({ l }: { l: LayerEntry }) {
  const g = useGis();
  const [info, setInfo] = useState(false);
  const [ask, setAsk] = useState(false);
  return (
    <li className={cx('rounded border border-line px-2 py-1.5 transition-opacity duration-200', !l.show && 'opacity-60')}>
      <div className="flex items-center gap-1.5">
        <input type="checkbox" checked={l.show} onChange={(e) => g.setLayer(l.id, { show: e.target.checked })} aria-label={tl('Show layer', 'แสดงชั้นข้อมูล')} />
        <span className="min-w-0 flex-1 truncate text-xs text-slate-200" title={l.name}>{l.name}</span>
        <button title={tl('Layer information and legend', 'ข้อมูลและคำอธิบายสัญลักษณ์ของชั้นข้อมูล')} aria-expanded={info} onClick={() => setInfo(!info)} className={cx('px-0.5 text-[11px] hover:text-white', info ? 'text-cyan-300' : 'text-muted')}>ⓘ</button>
        {l.layer && (
          <>
            <button title={t('Move up')} onClick={() => g.moveLayer(l.id, 1)} className="text-muted hover:text-white">▲</button>
            <button title={t('Move down')} onClick={() => g.moveLayer(l.id, -1)} className="text-muted hover:text-white">▼</button>
          </>
        )}
        <button title={t('Remove')} onClick={() => setAsk(true)} className="text-muted hover:text-bad">✕</button>
      </div>
      {ask && (
        <div className="ov-enter mt-1 flex items-center gap-1.5 text-[11px]">
          <span className="flex-1 text-warn">{tl('Remove this layer from the map?', 'ลบชั้นข้อมูลนี้ออกจากแผนที่?')}</span>
          <Button variant="danger" onClick={() => g.removeLayer(l.id)}>{tl('Remove', 'ลบ')}</Button>
          <Button onClick={() => setAsk(false)}>{tl('Keep', 'เก็บไว้')}</Button>
        </div>
      )}
      {l.layer && (
        <div className="mt-1 flex items-center gap-2">
          <input type="range" min={0.05} max={1} step={0.05} value={l.alpha} onChange={(e) => g.setLayer(l.id, { alpha: +e.target.value })} className="w-full" aria-label={tl('Opacity', 'ความทึบ')} />
          <span className="w-8 text-right font-mono text-[10px] text-muted">{Math.round(l.alpha * 100)}%</span>
        </div>
      )}
      <div className="ov-collapse" data-open={info}>
        <div>
          {l.meta && <div className="mt-1 break-words font-mono text-[10px] text-muted">{l.meta}</div>}
          {l.legend?.items?.map((it) => (
            <div key={it.label} className="flex items-center gap-1.5 text-[10px] text-slate-300"><span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: it.color }} />{it.label}</div>
          ))}
          {l.legend?.ramp && <div className="mt-1 h-2 rounded" style={{ background: l.legend.ramp }} />}
          {l.legend?.note && <div className="mt-0.5 text-[10px] leading-snug text-muted">{l.legend.note}</div>}
        </div>
      </div>
    </li>
  );
}

export function LegendBox() {
  const g = useGis();
  const shown = g.layers.filter((l) => l.show && l.legend);
  if (!shown.length) return null;
  return (
    <div className="max-h-[45vh] w-[260px] overflow-y-auto rounded-md border border-line bg-ink-950/90 p-2.5 text-[11px] shadow-xl scroll-thin">
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
