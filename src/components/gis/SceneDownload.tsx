import { useRef, useState } from 'react';
import { t } from '../../i18n';
import { Button, Notice, Spinner } from '../ui';
import { bboxPolygonOf, encodeGeoTiff, ORIGINAL_ASSETS, renderScene, safeName, saveBlob, savePng, signedAssetUrl } from '../../lib/export';
import { sensorOf } from '../../lib/spectral';
import { useWorkspace } from '../../store';
import type { ImageryItem } from '../../lib/stac';

/** Download the real picture of a scene: clipped to the AOI (GeoTIFF / PNG) or the original full-scene files. */
export default function SceneDownload({ item, compact }: { item: ImageryItem; compact?: boolean }) {
  const { aoi } = useWorkspace();
  const [open, setOpen] = useState(!compact);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [links, setLinks] = useState<Record<string, string>>({});
  const abort = useRef<AbortController | null>(null);
  const k = sensorOf(item);
  const assets = (ORIGINAL_ASSETS[k] ?? []).filter((a) => item.assets[a.key]?.href);
  const base = `${safeName(item.collectionLabel)}_${item.datetime.slice(0, 10)}_${safeName(aoi?.name ?? 'scene')}${k === 's1' ? '_VVdB' : '_truecolor'}`;

  const make = async (fmt: 'tif' | 'png', whole: boolean) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setErr('');
    setBusy(t('Preparing image…'));
    try {
      const poly = whole || !aoi ? bboxPolygonOf(item) : aoi.geometry;
      const g = await renderScene(item, poly, { signal: ac.signal, onProgress: (d, n) => setBusy(`${t('Preparing image…')} ${d}/${n}`) });
      const name = whole || !aoi ? base.replace(safeName(aoi?.name ?? 'scene'), 'fullscene') : base;
      if (fmt === 'tif') saveBlob(encodeGeoTiff(g), `${name}.tif`);
      else await savePng(g, `${name}.png`);
    } catch (e: any) {
      if (e.name !== 'AbortError') setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const sign = async (key: string) => {
    setErr('');
    try {
      const url = await signedAssetUrl(item.assets[key].href);
      setLinks((l) => ({ ...l, [key]: url }));
      window.open(url, '_blank', 'noopener');
    } catch (e: any) {
      setErr(e.message);
    }
  };

  if (!open) return <Button onClick={() => setOpen(true)}>⬇ {t('Download image')}</Button>;

  return (
    <div className="space-y-1.5 rounded border border-line p-2">
      <div className="flex items-center justify-between">
        <span className="label">⬇ {t('Download image')}</span>
        {compact && <button onClick={() => setOpen(false)} className="text-muted hover:text-white">✕</button>}
      </div>
      <div className="text-[11px] text-slate-300">{aoi ? `${t('Clipped to AOI')}: ${aoi.name}` : t('No AOI — the whole scene will be exported at reduced resolution')}</div>
      <div className="flex flex-wrap gap-1">
        <Button variant="primary" onClick={() => make('tif', false)} disabled={!!busy}>GeoTIFF</Button>
        <Button onClick={() => make('png', false)} disabled={!!busy}>PNG</Button>
        {aoi && <Button onClick={() => make('png', true)} disabled={!!busy}>{t('Whole scene (PNG, reduced)')}</Button>}
        {busy && <Button variant="danger" onClick={() => abort.current?.abort()}>{t('Cancel')}</Button>}
      </div>
      {busy && <div className="flex items-center gap-2 text-[11px] text-muted"><Spinner /> {busy}</div>}
      <p className="text-[10px] leading-snug text-muted">
        {k === 's1' ? t('Sentinel-1 is exported as VV backscatter in dB (dark = water / smooth surfaces).') : t('True-colour image rendered from the original bands (red, green, blue).')}{' '}
        {t('GeoTIFF is georeferenced (EPSG:4326) and opens in QGIS / ArcGIS / Google Earth Pro; resolution up to 2048 px across.')}
      </p>
      {assets.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[11px] text-cyan-300">{t('Original full-scene files (Cloud-Optimized GeoTIFF)')}</summary>
          <p className="mt-1 text-[10px] text-warn">{t('Full scenes are large (≈100 × 100 km, tens to hundreds of MB per band). Links are signed by Microsoft Planetary Computer and expire after about an hour.')}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {assets.map((a) => (
              <Button key={a.key} onClick={() => sign(a.key)} title={links[a.key] ? t('Opened') : ''}>
                {links[a.key] ? '✓ ' : ''}{t(a.label)}
              </Button>
            ))}
          </div>
        </details>
      )}
      {err && <Notice tone="bad">{err}</Notice>}
    </div>
  );
}
