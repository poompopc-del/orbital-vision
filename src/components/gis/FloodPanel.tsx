import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { Button, Field, Input, KV, Notice, Select, Spinner } from '../ui';
import { fetchRaster, gridFor, classify, type Classified, type Raster } from '../../lib/change';
import { indexExpression, INDICES, sarDbExpression, SAR_WATER_DEFAULT_DB, sensorOf } from '../../lib/spectral';
import { areaKm2, downloadJson } from '../../lib/geo';
import { fmtNum } from '../../lib/format';
import { useWorkspace } from '../../store';
import { useGis } from './GisContext';
import { imageProvider, sceneLabel } from './sceneLayer';
import ResultDownloads from './ResultDownloads';
import { compareWarnings } from './compareChecks';
import { maskCloudsInPlace } from '../../lib/cloudmask';
import type { ImageryItem } from '../../lib/stac';

type Method = 'mndwi' | 'ndwi' | 'sar';

const COLORS = {
  perm: [27, 58, 138, 220] as [number, number, number, number],
  flood: [30, 144, 255, 230] as [number, number, number, number],
  receded: [245, 184, 75, 220] as [number, number, number, number],
  water: [30, 144, 255, 230] as [number, number, number, number],
};

export default function FloodPanel() {
  const g = useGis();
  const { aoi } = useWorkspace();
  const [methodState, setMethod] = useState<Method>('mndwi');
  const [thrState, setThr] = useState(0);
  const method = methodState;
  const thr = thrState;
  const [usePre, setUsePre] = useState(true);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [res, setRes] = useState<(Classified & { mode: 'single' | 'pair'; post: ImageryItem; pre: ImageryItem | null; method: Method; thr: number; legendItems: { color: string; label: string }[] }) | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!g.resetKey) return;
    setRes(null);
    setErr('');
  }, [g.resetKey]);

  const postState = g.sceneB ?? g.sceneA;
  const preState = usePre && g.sceneB ? g.sceneA : null;
  const post = postState;
  const pre = preState;

  const setM = (m: Method) => {
    setMethod(m);
    setThr(m === 'sar' ? SAR_WATER_DEFAULT_DB : 0);
  };

  const run = async (o?: { pre?: ImageryItem | null; post?: ImageryItem; method?: Method }) => {
    const method = o?.method ?? methodState;
    const thr = o?.method ? (o.method === 'sar' ? SAR_WATER_DEFAULT_DB : 0) : thrState;
    const post = o?.post ?? postState;
    const pre = o && 'pre' in o ? o.pre ?? null : preState;
    if (o?.method) {
      setMethod(o.method);
      setThr(thr);
    }
    if (o && 'pre' in o) setUsePre(!!o.pre);
    const validFor = (it: ImageryItem | null) => {
      if (!it) return t('Select a scene first');
      const k = sensorOf(it);
      if (method === 'sar' && k !== 's1') return t('SAR water detection needs a Sentinel-1 RTC scene');
      if (method !== 'sar' && k !== 's2' && k !== 'landsat') return t('Optical water indices need Sentinel-2 or Landsat');
      return null;
    };
    const exprFor = (it: ImageryItem) => (method === 'sar' ? sarDbExpression('vv') : indexExpression(it, INDICES.find((i) => i.id === method)!));
    const range: [number, number] = method === 'sar' ? [-30, 5] : [-1, 1];
    const isWater = (v: number) => (method === 'sar' ? v < thr : v > thr);
    if (!aoi || !post) return;
    const e1 = validFor(post) ?? (pre ? validFor(pre) : null);
    if (e1) return setErr(e1);
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setErr('');
    setRes(null);
    try {
      const grid = gridFor(aoi.geometry);
      const load = async (it: ImageryItem, label: string): Promise<Raster> => {
        setBusy(`${t('Reading')} ${label}…`);
        const r = await fetchRaster(it, exprFor(it), range, grid, ac.signal, (d, n) => setBusy(`${t('Reading')} ${label} ${d}/${n}`));
        // cloud, cloud edges, thin cloud and cloud shadow (which mimics water) → no data
        await maskCloudsInPlace(it, r, ac.signal);
        return r;
      };
      const rb = await load(post, t('after'));
      const ra = pre ? await load(pre, t('before')) : null;
      setBusy(t('Classifying…'));
      const out = ra
        ? classify(aoi.geometry, ra, rb, (va, vb) => (isWater(va) && isWater(vb) ? 1 : !isWater(va) && isWater(vb) ? 2 : isWater(va) && !isWater(vb) ? 3 : 4), [
            { id: 1, label: 'Permanent / pre-existing water', rgba: COLORS.perm },
            { id: 2, label: 'New water (possible flood)', rgba: COLORS.flood },
            { id: 3, label: 'Water before, not after (check)', rgba: COLORS.receded },
            { id: 4, label: 'Dry', rgba: [0, 0, 0, 0] },
          ])
        : classify(aoi.geometry, rb, null, (v) => (isWater(v) ? 1 : 4), [
            { id: 1, label: 'Water detected', rgba: COLORS.water },
            { id: 4, label: 'Not water', rgba: [0, 0, 0, 0] },
          ]);
      const prov = await imageProvider(out.imageUrl, out.grid.west, out.grid.south, out.grid.east, out.grid.north);
      const methodLabel = method === 'sar' ? `Sentinel-1 VV < ${thr} dB` : `${method.toUpperCase()} > ${thr}`;
      g.putImagery('flood', `${t('Flood map')} · ${methodLabel}`, prov, {
        meta: `${pre ? `${sceneLabel(pre)} → ` : ''}${sceneLabel(post)}`,
        legend: {
          items: pre
            ? [
                { color: 'rgb(27,58,138)', label: t('Permanent / pre-existing water') },
                { color: 'rgb(30,144,255)', label: t('New water (possible flood)') },
                { color: 'rgb(245,184,75)', label: t('Water before, not after (check)') },
                { color: 'rgb(128,128,128)', label: t('No data / cloud / low confidence') },
              ]
            : [
                { color: 'rgb(30,144,255)', label: t('Water detected') },
                { color: 'rgb(128,128,128)', label: t('No data / cloud / low confidence') },
              ],
          note: t('Classification from satellite data with a user-set threshold — not confirmation of flooding.'),
        },
      });
      setRes({ ...out, mode: pre ? 'pair' : 'single', post, pre, method, thr, legendItems: (pre ? [
        { color: 'rgb(27,58,138)', label: t('Permanent / pre-existing water') },
        { color: 'rgb(30,144,255)', label: t('New water (possible flood)') },
        { color: 'rgb(245,184,75)', label: t('Water before, not after (check)') },
      ] : [{ color: 'rgb(30,144,255)', label: t('Water detected') }]).concat([{ color: 'rgb(128,128,128)', label: t('No data / cloud / low confidence') }]) });
      g.putReport({
        id: 'flood',
        title: `Flood / water mapping — ${methodLabel}`,
        lines: [
          `Method: ${method === 'sar' ? 'Sentinel-1 RTC VV backscatter threshold (dB)' : `${method.toUpperCase()} threshold`}; ${pre ? 'before/after comparison' : 'single date'}`,
          pre ? `Before: ${pre.id} (${pre.datetime})` : '',
          `After: ${post.id} (${post.datetime})`,
          ...Object.entries(out.areasKm2).map(([k, v]) => `Class ${k}: ${v.toFixed(3)} km²`),
          `No data / cloud: ${out.noDataKm2.toFixed(3)} km² of ${out.aoiKm2.toFixed(3)} km²`,
          'Pixel grid: 8-bit web-mercator tiles of server-side band math (Planetary Computer)',
        ].filter(Boolean),
      });
    } catch (e: any) {
      if (e.name !== 'AbortError') setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => g.registerAction('flood', (o) => void runRef.current(o)), [g.registerAction]);

  const area = (id: number) => res?.areasKm2[id] ?? 0;
  const warn = pre && post ? compareWarnings(pre, post) : [];

  return (
    <div className="space-y-2.5">
      <Notice>{t('Uses scene B as “after” and scene A as “before” (optional). The AOI limits the analysis.')}</Notice>
      <div className="text-[11px] text-slate-300">
        <div>{t('After')}: {sceneLabel(post)}</div>
        <div>{t('Before')}: {usePre ? sceneLabel(pre) : t('not used')}</div>
      </div>
      <div className="grid grid-cols-3 gap-1">
        <Button variant={method === 'mndwi' ? 'active' : 'ghost'} onClick={() => setM('mndwi')}>MNDWI</Button>
        <Button variant={method === 'ndwi' ? 'active' : 'ghost'} onClick={() => setM('ndwi')}>NDWI</Button>
        <Button variant={method === 'sar' ? 'active' : 'ghost'} onClick={() => setM('sar')}>SAR VV</Button>
      </div>
      <p className="text-[10px] leading-snug text-muted">
        {method === 'sar'
          ? t('SAR workflow: water returns little backscatter. Pixels with VV below the threshold (dB) are classed as water. Wind, rain cells, radar shadow and smooth tarmac can mislead. Optical indices are not applied to SAR.')
          : t('Optical workflow: pixels above the index threshold are classed as water; clouds, cloud edges, thin cloud and cloud shadows (Sentinel-2 SCL / Landsat QA_PIXEL plus a buffer) are removed as no data. Built-up areas and shadows can still be misclassified.')}
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        <Field label={method === 'sar' ? t('Threshold (dB)') : t('Threshold')}>
          <Input type="number" step={method === 'sar' ? 0.5 : 0.02} value={thr} onChange={(e) => setThr(+e.target.value)} />
        </Field>
        <Field label={t('Comparison')}>
          <Select value={usePre ? 'pair' : 'single'} onChange={(e) => setUsePre(e.target.value === 'pair')}>
            <option value="pair">{t('Before / after')}</option>
            <option value="single">{t('Single date')}</option>
          </Select>
        </Field>
      </div>
      {warn.length > 0 && <Notice tone="warn">{warn.map((w) => <div key={w}>• {t(w)}</div>)}</Notice>}
      <div className="flex gap-1.5">
        <Button variant="primary" onClick={() => run()} disabled={!aoi || !post || !!busy}>{t('Map water')}</Button>
        {busy && <Button variant="danger" onClick={() => abort.current?.abort()}>{t('Cancel')}</Button>}
      </div>
      {!aoi && <p className="text-[11px] text-muted">{t('Draw a rectangle AOI first.')}</p>}
      {busy && <div className="flex items-center gap-2 text-xs text-muted"><Spinner /> {busy}</div>}
      {err && <Notice tone="bad">{err}</Notice>}
      {res && (
        <div className="rounded border border-line p-2">
          <dl>
            {res.mode === 'pair' ? (
              <>
                <KV k={t('New water (possible flood)')} v={`${fmtNum(area(2), 3)} km²`} mono />
                <KV k={t('Permanent / pre-existing water')} v={`${fmtNum(area(1), 3)} km²`} mono />
                <KV k={t('Water before, not after')} v={`${fmtNum(area(3), 3)} km²`} mono />
              </>
            ) : (
              <KV k={t('Water detected')} v={`${fmtNum(area(1), 3)} km²`} mono />
            )}
            <KV k={t('No data / cloud')} v={`${fmtNum(res.noDataKm2, 3)} km² (${fmtNum((100 * res.noDataKm2) / Math.max(res.aoiKm2, 1e-9), 1)} %)`} mono />
            <KV k={t('AOI analysed')} v={`${fmtNum(res.aoiKm2, 3)} km² (${t('polygon')} ${fmtNum(areaKm2(aoi!.geometry), 3)} km²)`} mono />
            <KV k={t('Pixel size')} v={`≈ ${fmtNum(((40075016.7 * Math.cos(((res.grid.north + res.grid.south) / 2) * (Math.PI / 180))) / (256 * 2 ** res.grid.z)), 1)} m (zoom ${res.grid.z})`} mono />
          </dl>
          <div className="mt-2 flex flex-wrap gap-1">
            <Button
              onClick={() =>
                downloadJson('flood-extent-summary.geojson', {
                  type: 'Feature',
                  geometry: aoi!.geometry,
                  properties: {
                    method: res.method === 'sar' ? 'S1 RTC VV dB threshold' : `${res.method.toUpperCase()} threshold`,
                    threshold: res.thr,
                    before: res.pre?.id ?? null,
                    after: res.post.id,
                    areasKm2: res.areasKm2,
                    noDataKm2: res.noDataKm2,
                    aoiKm2: res.aoiKm2,
                    rasterBounds: [res.grid.west, res.grid.south, res.grid.east, res.grid.north],
                    note: 'Classification from satellite data; not confirmation of flooding.',
                  },
                })
              }
            >
              {t('Export GeoJSON summary')}
            </Button>
          </div>
          <ResultDownloads
            title={`${t('Flood map')} · ${res.method === 'sar' ? `Sentinel-1 VV < ${res.thr} dB` : `${res.method.toUpperCase()} > ${res.thr}`}`}
            before={res.pre}
            after={res.post}
            result={res}
            legend={res.legendItems}
            summaryLines={[
              res.mode === 'pair'
                ? `${t('New water (possible flood)')}: ${fmtNum(area(2), 2)} km² · ${t('Permanent / pre-existing water')}: ${fmtNum(area(1), 2)} km²`
                : `${t('Water detected')}: ${fmtNum(area(1), 2)} km²`,
              `${t('No data / cloud')}: ${fmtNum(res.noDataKm2, 2)} km²`,
            ]}
          />
        </div>
      )}
    </div>
  );
}
