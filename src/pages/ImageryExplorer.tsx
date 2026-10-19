import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n';
import { Link } from 'react-router-dom';
import GlobeHost from '../components/GlobeHost';
import AoiPicker from '../components/AoiPicker';
import ImageryCard from '../components/ImageryCard';
import { Badge, Button, Field, Input, Notice, Panel, Spinner } from '../components/ui';
import { Cesium, CYAN, showAoi } from '../lib/cesium';
import { searchArchive, STAC_COLLECTIONS, type ImageryItem, type StacCollectionId } from '../lib/stac';
import { useWorkspace } from '../store';
import { isoDay } from '../lib/format';
import { PROVIDERS } from '../data/providers';
import { logAudit, saveRequest, uid } from '../lib/repo';

export default function ImageryExplorer() {
  const { aoi, lastResults, setLastResults, compare, toggleCompare } = useWorkspace();
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const [cols, setCols] = useState<StacCollectionId[]>(['sentinel-2-l2a', 'landsat-c2-l2']);
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 90 * 86400000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const [maxCloud, setMaxCloud] = useState(30);
  const [minCov, setMinCov] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const results = lastResults;

  const shown = useMemo(() => results.filter((r) => (r.coveragePct ?? 100) >= minCov), [results, minCov]);

  useEffect(() => {
    if (viewer) showAoi(viewer, aoi?.geometry ?? null);
  }, [viewer, aoi]);

  // footprints of results
  useEffect(() => {
    if (!viewer) return;
    viewer.entities.values.filter((e) => String(e.id).startsWith('fp-')).forEach((e) => viewer.entities.remove(e));
    shown.slice(0, 80).forEach((r) => {
      const ring = r.geometry.type === 'Polygon' ? r.geometry.coordinates[0] : r.geometry.coordinates[0][0];
      const isF = r.id === focus;
      viewer.entities.add({
        id: `fp-${r.id}`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(ring.flatMap((c) => [c[0], c[1]])),
          width: isF ? 2.5 : 1,
          material: isF ? Cesium.Color.WHITE : CYAN.withAlpha(0.35),
        },
      });
    });
  }, [viewer, shown, focus]);

  const run = async () => {
    if (!aoi) return setErr('Select an area of interest first.');
    if (!cols.length) return setErr('Select at least one collection.');
    setErr('');
    setBusy(true);
    try {
      const r = await searchArchive({ aoi: aoi.geometry, collections: cols, from, to, maxCloud });
      setLastResults(r);
      void logAudit('archive.search', { collections: cols, from, to, maxCloud, results: r.length });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveItem = async (it: ImageryItem) => {
    const now = new Date().toISOString();
    await saveRequest({
      id: uid(),
      title: `${it.collectionLabel} · ${it.datetime.slice(0, 10)}`,
      kind: 'archive',
      providerId: it.providerId,
      sensor: STAC_COLLECTIONS.find((c) => c.id === it.collection)?.sensor ?? '',
      aoi: aoi?.geometry ?? null,
      params: { stacItem: it.id, collection: it.collection, datetime: it.datetime, selfHref: it.selfHref, coveragePct: it.coveragePct },
      status: 'results_available',
      history: [{ at: now, status: 'results_available', source: 'platform', note: 'Saved from archive search (public open data — free download from source)' }],
      createdAt: now,
      updatedAt: now,
    });
    setSaved(it.id);
    setTimeout(() => setSaved(''), 2500);
  };

  const commercial = PROVIDERS.filter((p) => p.access === 'commercial' && p.archive);

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-line bg-ink-900 p-3 scroll-thin lg:w-[440px] lg:border-r">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400">{t('B · Imagery Explorer')}</div>
          <h1 className="text-base font-semibold text-white">{t('Search existing archives')}</h1>
        </div>
        <Panel title={t('1 · Location')}>
          <AoiPicker viewer={viewer} compact />
        </Panel>
        <Panel title={t('2 · Archive query')}>
          <div className="space-y-2.5">
            <div className="flex flex-wrap gap-1.5">
              {STAC_COLLECTIONS.map((c) => {
                const on = cols.includes(c.id);
                return (
                  <Button key={c.id} variant={on ? 'active' : 'ghost'} onClick={() => setCols(on ? cols.filter((x) => x !== c.id) : [...cols, c.id])}>
                    {c.label}
                  </Button>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('From')}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label={t('To')}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            </div>
            {cols.some((c) => STAC_COLLECTIONS.find((x) => x.id === c)?.optical) && (
              <Field label={`${t('Max cloud cover')} · ${maxCloud}%`} hint={t('Applies to optical collections only')}>
                <input type="range" min={0} max={100} value={maxCloud} onChange={(e) => setMaxCloud(+e.target.value)} className="w-full" />
              </Field>
            )}
            <Button variant="primary" className="w-full" onClick={run} disabled={busy}>
              {busy ? <><Spinner /> {t('Searching archives…')}</> : t('Search archives')}
            </Button>
            {err && <Notice tone="bad">{err}</Notice>}
          </div>
        </Panel>

        <Panel
          title={`3 · ${t('Results')}${results.length ? ` (${shown.length})` : ''}`}
          right={results.length > 0 && (
            <label className="flex items-center gap-1 font-mono text-[10px] text-muted">{t('min AOI')} <select value={minCov} onChange={(e) => setMinCov(+e.target.value)} className="rounded border border-line bg-ink-900 px-1">
                {[0, 25, 50, 75, 95].map((v) => <option key={v} value={v}>{v}%</option>)}
              </select>
            </label>
          )}
        >
          <div className="space-y-2">
            {!results.length && !busy && <p className="text-xs text-muted">{t('Run a search to list genuine catalogue records from the public Earth Search STAC API.')}</p>}
            {compare.length > 0 && (
              <div className="flex items-center justify-between rounded border border-cyan-400/30 px-2 py-1.5 text-xs">
                <span className="text-slate-300">{compare.length}/2 selected for comparison</span>
                <Link to="/analysis"><Button variant="primary">{t('Open analysis')}</Button></Link>
              </div>
            )}
            {saved && <Notice>{t('Saved to Orders & Projects as an archive record.')}</Notice>}
            {shown.map((r) => (
              <ImageryCard
                key={r.id}
                item={r}
                active={focus === r.id}
                inCompare={compare.some((c) => c.id === r.id)}
                onFocus={() => setFocus(r.id)}
                onCompare={() => toggleCompare(r)}
                onSave={() => saveItem(r)}
              />
            ))}
          </div>
        </Panel>

        <Panel title={t('Commercial archives — not integrated')}>
          <p className="mb-2 text-xs text-muted">{t('These providers hold commercial archives but no API credentials are configured, so their catalogues are not searched here. Use the official channel.')} </p>
          <div className="space-y-1">
            {commercial.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2 border-b border-white/5 py-1 text-xs last:border-0">
                <span className="text-slate-200">{p.shortName}</span>
                <span className="flex items-center gap-1.5">
                  <Badge>{t('Manual')}</Badge>
                  <a href={p.portal ?? p.website} target="_blank" rel="noreferrer" className="text-cyan-300 hover:underline">{t('Official site ↗')}</a>
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </aside>
      <div className="relative min-h-[320px] flex-1">
        <GlobeHost onReady={setViewer} />
        <div className="pointer-events-none absolute left-3 top-3 flex gap-1.5">
          <Badge tone="cyan">{t('Footprints · Earth Search STAC')}</Badge>
        </div>
      </div>
    </div>
  );
}
