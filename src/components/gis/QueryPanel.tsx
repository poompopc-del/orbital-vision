import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { t } from '../../i18n';
import { Badge, Button, Field, Input, Notice, Spinner } from '../ui';
import { Cesium } from '../../lib/cesium';
import { pointAoi } from '../../lib/geo';
import { addSceneLayer, searchArchive, STAC_COLLECTIONS, type ImageryItem, type StacCollectionId } from '../../lib/stac';
import { PROVIDERS } from '../../data/providers';
import { fmtLatLon, fmtNum, fmtUtc, isoDay } from '../../lib/format';
import { useWorkspace } from '../../store';
import { useGis } from './GisContext';

export default function QueryPanel() {
  const g = useGis();
  const { setAoi, setLastResults } = useWorkspace();
  const [pt, setPt] = useState<{ lon: number; lat: number } | null>(null);
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 120 * 86400e3)));
  const [to, setTo] = useState(isoDay(new Date()));
  const [cloud, setCloud] = useState(40);
  const [cols, setCols] = useState<StacCollectionId[]>(['sentinel-2-l2a', 'landsat-c2-l2', 'sentinel-1-rtc']);
  const [items, setItems] = useState<ImageryItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);

  useEffect(
    () =>
      g.onMapClick('query', (lon, lat) => {
        setPt({ lon, lat });
        void run(lon, lat);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [g.onMapClick, from, to, cloud, cols.join()],
  );

  const run = async (lon: number, lat: number) => {
    setBusy(true);
    setErr('');
    setItems(null);
    const v = g.viewer;
    if (v) {
      const old = v.entities.getById('query-pt');
      if (old) v.entities.remove(old);
      v.entities.add({ id: 'query-pt', position: Cesium.Cartesian3.fromDegrees(lon, lat), point: { pixelSize: 10, color: Cesium.Color.fromCssColorString('#f5b84b'), outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    }
    try {
      const r = await searchArchive({ aoi: pointAoi(lon, lat, 0.5), collections: cols, from, to, maxCloud: cloud, limit: 30 });
      setItems(r);
      setLastResults(r);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const view = async (it: ImageryItem) => {
    if (!g.viewer) return;
    if (viewing === it.id) {
      g.removeLayer('query-scene');
      setViewing(null);
      return;
    }
    try {
      g.removeLayer('query-scene');
      const l = await addSceneLayer(g.viewer, it);
      if (!l) throw new Error(t('No full-resolution tiles for this scene'));
      // hand the layer to the layer manager
      const prov = l.imageryProvider;
      g.viewer.imageryLayers.remove(l, false);
      g.putImagery('query-scene', `${it.collectionLabel} ${it.datetime.slice(0, 10)}`, prov, { meta: `${it.id} · ${t('real image (rendered tiles)')}` });
      setViewing(it.id);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  useEffect(() => {
    if (!g.resetKey) return;
    setViewing(null);
    setPt(null);
  }, [g.resetKey]);

  const commercial = PROVIDERS.filter((p) => p.access === 'commercial');

  return (
    <div className="space-y-2.5">
      <Notice>{t('Choose the “Identify imagery” tool on the map toolbar, then click any location.')}</Notice>
      <div className="grid grid-cols-2 gap-1.5">
        <Field label={t('From')}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t('To')}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <Field label={`${t('Max cloud cover')} · ${cloud}%`}>
        <input type="range" min={0} max={100} value={cloud} onChange={(e) => setCloud(+e.target.value)} className="w-full" />
      </Field>
      <div className="flex flex-wrap gap-1">
        {STAC_COLLECTIONS.filter((c) => c.id !== 'sentinel-1-grd').map((c) => {
          const on = cols.includes(c.id);
          return <Button key={c.id} variant={on ? 'active' : 'ghost'} onClick={() => setCols(on ? cols.filter((x) => x !== c.id) : [...cols, c.id])}>{c.label}</Button>;
        })}
      </div>
      {pt && (
        <div className="flex items-center justify-between rounded border border-line px-2 py-1.5 text-xs">
          <span className="font-mono text-slate-200">{fmtLatLon(pt.lat, pt.lon)}</span>
          <Button onClick={() => setAoi({ geometry: pointAoi(pt.lon, pt.lat, 5), name: `Point ${pt.lat.toFixed(4)}, ${pt.lon.toFixed(4)}`, source: 'coordinates' })}>{t('Use as AOI (5 km)')}</Button>
        </div>
      )}
      {busy && <div className="flex items-center gap-2 text-xs text-muted"><Spinner /> {t('Searching archives…')}</div>}
      {err && <Notice tone="bad">{err}</Notice>}

      {items && (
        <div>
          <div className="label mb-1">{t('Archive — available now')} ({items.length})</div>
          {items.length === 0 && <p className="text-[11px] text-muted">{t('No open-data scenes at this point for the chosen dates and cloud limit.')}</p>}
          <ul className="max-h-[42vh] space-y-1.5 overflow-y-auto scroll-thin">
            {items.map((it) => (
              <li key={it.id} className="rounded border border-line p-1.5">
                <div className="flex gap-2">
                  {it.thumbnail ? <img src={it.thumbnail} alt="" className="h-14 w-14 shrink-0 rounded object-cover" loading="lazy" /> : <div className="h-14 w-14 shrink-0 rounded bg-ink-950" />}
                  <div className="min-w-0 flex-1 text-[11px]">
                    <div className="flex flex-wrap gap-1">
                      <Badge tone="cyan">{it.collectionLabel}</Badge>
                      <Badge>{STAC_COLLECTIONS.find((c) => c.id === it.collection)?.optical ? t('Optical') : 'SAR'}</Badge>
                      <Badge tone="ok">{t('Archive · free')}</Badge>
                    </div>
                    <div className="mt-0.5 font-mono text-slate-200">{fmtUtc(it.datetime)}</div>
                    <div className="text-muted">
                      {it.platform} · {it.gsd}
                      {it.cloudCover != null && ` · ${t('Cloud')} ${fmtNum(it.cloudCover, 0)}%`}
                      {it.viewAngle != null && ` · ${fmtNum(it.viewAngle, 1)}°`}
                    </div>
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {it.tilejson && <Button variant={viewing === it.id ? 'active' : 'ghost'} onClick={() => view(it)}>{viewing === it.id ? t('Hide image') : `🌍 ${t('View real image')}`}</Button>}
                  <Button variant={g.sceneA?.id === it.id ? 'active' : 'ghost'} onClick={() => g.setSceneA(it)}>{t('Use as scene A')}</Button>
                  <Button variant={g.sceneB?.id === it.id ? 'active' : 'ghost'} onClick={() => g.setSceneB(it)}>{t('Use as scene B')}</Button>
                  {it.selfHref && <a href={it.selfHref} target="_blank" rel="noreferrer"><Button>STAC ↗</Button></a>}
                </div>
              </li>
            ))}
          </ul>
          <div className="label mb-1 mt-3">{t('New acquisition — needs provider check')}</div>
          <p className="text-[11px] text-muted">
            {commercial.filter((p) => p.tasking).map((p) => p.shortName).join(', ')} — {t('availability, licence and price must be confirmed with the provider.')}{' '}
            <Link to="/acquire" className="text-cyan-300 underline">{t('Prepare a request')}</Link>
          </p>
        </div>
      )}
    </div>
  );
}
