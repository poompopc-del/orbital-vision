import { useRef, useState } from 'react';
import { t } from '../../i18n';
import { Button, Notice, Spinner } from '../ui';
import { encodeGeoTiff, renderScene, safeName, saveBlob, savePng, summarySheet, withOverlay, type GeoCanvas, type SheetPanel } from '../../lib/export';
import { areaKm2 } from '../../lib/geo';
import { useWorkspace } from '../../store';
import type { ImageryItem } from '../../lib/stac';
import { sceneLabel } from './sceneLayer';

interface Props {
  title: string;
  before: ImageryItem | null;
  after: ImageryItem;
  result: { imageUrl: string; grid: { west: number; south: number; east: number; north: number } };
  legend: { color: string; label: string }[];
  summaryLines: string[];
}

/** Downloads that include the real images: before / after / result over the after image / summary sheet. */
export default function ResultDownloads({ title, before, after, result, legend, summaryLines }: Props) {
  const { aoi } = useWorkspace();
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const cache = useRef(new Map<string, GeoCanvas>());
  const abort = useRef<AbortController | null>(null);
  if (!aoi) return null;
  const tag = `${safeName(aoi.name)}`;

  const scene = async (it: ImageryItem, ac: AbortController, label: string) => {
    const key = `${it.id}|${JSON.stringify(aoi.geometry)}`;
    const hit = cache.current.get(key);
    if (hit) return hit;
    const g = await renderScene(it, aoi.geometry, { signal: ac.signal, onProgress: (d, n) => setBusy(`${t('Preparing')} ${label} ${d}/${n}`) });
    cache.current.set(key, g);
    return g;
  };

  const run = async (what: 'before' | 'after' | 'overlay' | 'overlay-tif' | 'mask-tif' | 'sheet') => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setErr('');
    try {
      if (what === 'before' && before) saveBlob(encodeGeoTiff(await scene(before, ac, t('before'))), `${tag}_before_${before.datetime.slice(0, 10)}.tif`);
      if (what === 'after') saveBlob(encodeGeoTiff(await scene(after, ac, t('after'))), `${tag}_after_${after.datetime.slice(0, 10)}.tif`);
      if (what === 'overlay' || what === 'overlay-tif') {
        const g = await withOverlay(await scene(after, ac, t('after')), result.imageUrl, result.grid, aoi.geometry);
        if (what === 'overlay') await savePng(g, `${tag}_result_on_after.png`);
        else saveBlob(encodeGeoTiff(g), `${tag}_result_on_after.tif`);
      }
      if (what === 'mask-tif') {
        const img = new Image();
        img.src = result.imageUrl;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d')!.drawImage(img, 0, 0);
        saveBlob(encodeGeoTiff({ canvas: c, ...result.grid }), `${tag}_result_mask.tif`);
      }
      if (what === 'sheet') {
        const a = await scene(after, ac, t('after'));
        const panels: SheetPanel[] = [];
        if (before) panels.push({ img: await scene(before, ac, t('before')), caption: `${t('Before')}: ${sceneLabel(before)}` });
        panels.push({ img: a, caption: `${t('After')}: ${sceneLabel(after)}` });
        panels.push({ img: await withOverlay(a, result.imageUrl, result.grid, aoi.geometry), caption: t('Result over the after image') });
        setBusy(t('Composing summary…'));
        const blob = await summarySheet(`ORBITAL VISION — ${title}`, panels, legend.filter((l) => l.color !== 'rgba(0,0,0,0)'), [
          `AOI: ${aoi.name} · ${areaKm2(aoi.geometry).toFixed(2)} km²`,
          ...summaryLines,
          t('Source: Copernicus Sentinel / USGS Landsat via Microsoft Planetary Computer. Derived from satellite data — not confirmation of events on the ground.'),
        ]);
        saveBlob(blob, `${tag}_summary.png`);
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mt-2 space-y-1.5 rounded border border-cyan-400/30 p-2">
      <div className="label text-cyan-300">⬇ {t('Download with images')}</div>
      <div className="flex flex-wrap gap-1">
        <Button variant="primary" onClick={() => run('sheet')} disabled={!!busy}>{t('Summary sheet (PNG)')}</Button>
        <Button onClick={() => run('overlay')} disabled={!!busy}>{t('Result on image (PNG)')}</Button>
        <Button onClick={() => run('overlay-tif')} disabled={!!busy}>{t('Result on image (GeoTIFF)')}</Button>
        {before && <Button onClick={() => run('before')} disabled={!!busy}>{t('Before image (GeoTIFF)')}</Button>}
        <Button onClick={() => run('after')} disabled={!!busy}>{t('After image (GeoTIFF)')}</Button>
        <Button onClick={() => run('mask-tif')} disabled={!!busy}>{t('Result only (GeoTIFF)')}</Button>
        {busy && <Button variant="danger" onClick={() => abort.current?.abort()}>{t('Cancel')}</Button>}
      </div>
      {busy && <div className="flex items-center gap-2 text-[11px] text-muted"><Spinner /> {busy}</div>}
      <p className="text-[10px] text-muted">{t('The summary sheet puts before, after and the result side by side with dates, legend and source — ready to print or send.')}</p>
      {err && <Notice tone="bad">{err}</Notice>}
    </div>
  );
}
