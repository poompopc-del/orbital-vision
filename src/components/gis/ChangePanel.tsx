import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { Button, Field, Input, KV, Notice, Select, Spinner } from '../ui';
import { classify, fetchRaster, gridFor, type Classified } from '../../lib/change';
import { compositeTileUrl, DEFAULT_STRETCH, indexAvailability, indexExpression, indexSummary, indexTileUrl, INDICES, refl, S2_CLEAR_EXPR, sarDbExpression, sensorOf } from '../../lib/spectral';
import { Cesium } from '../../lib/cesium';
import { downloadJson } from '../../lib/geo';
import { fmtNum } from '../../lib/format';
import { useWorkspace } from '../../store';
import type { ImageryItem } from '../../lib/stac';
import { useGis } from './GisContext';
import { imageProvider, pcProvider, sceneLabel } from './sceneLayer';
import { compareWarnings } from './compareChecks';

type Kind = 'ndvi' | 'ndwi' | 'mndwi' | 'dnbr' | 'sar' | 'general';

const KINDS: { id: Kind; label: string }[] = [
  { id: 'ndvi', label: 'NDVI change (vegetation)' },
  { id: 'ndwi', label: 'NDWI change (water)' },
  { id: 'mndwi', label: 'MNDWI change (water)' },
  { id: 'dnbr', label: 'dNBR burn severity' },
  { id: 'sar', label: 'SAR VV backscatter change (dB)' },
  { id: 'general', label: 'General brightness difference' },
];

// Key & Benson (2006), FIREMON landscape assessment — dNBR severity classes (unitless, ×1 scale)
const DNBR_CLASSES = [
  { id: 1, max: 0.1, label: 'Unburned / regrowth (< 0.10)', rgba: [0, 0, 0, 0] as [number, number, number, number] },
  { id: 2, max: 0.27, label: 'Low severity (0.10–0.27)', rgba: [255, 230, 120, 200] as [number, number, number, number] },
  { id: 3, max: 0.44, label: 'Moderate-low (0.27–0.44)', rgba: [255, 170, 60, 210] as [number, number, number, number] },
  { id: 4, max: 0.66, label: 'Moderate-high (0.44–0.66)', rgba: [235, 90, 40, 220] as [number, number, number, number] },
  { id: 5, max: Infinity, label: 'High severity (> 0.66)', rgba: [150, 20, 90, 230] as [number, number, number, number] },
];

export default function ChangePanel() {
  const g = useGis();
  const { aoi, lastResults } = useWorkspace();
  const [kind, setKind] = useState<Kind>('ndvi');
  const [thr, setThr] = useState(0.15);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [res, setRes] = useState<Classified | null>(null);
  const [swipe, setSwipe] = useState(false);
  const [series, setSeries] = useState<{ date: string; value: number; id: string; clear: boolean }[] | null>(null);
  const abort = useRef<AbortController | null>(null);
  const A = g.sceneA, B = g.sceneB;
  useEffect(() => {
    if (!g.resetKey) return;
    setRes(null);
    setSeries(null);
    setSwipe(false);
    setErr('');
  }, [g.resetKey]);

  const exprFor = (it: ImageryItem): { expr: string; range: [number, number] } => {
    if (kind === 'sar') return { expr: sarDbExpression('vv'), range: [-30, 5] };
    if (kind === 'general') {
      const r = refl(it, 'red'), gg = refl(it, 'green'), b = refl(it, 'blue');
      return { expr: `((${r}+${gg}+${b})/3)`, range: [0, 0.4] };
    }
    const def = INDICES.find((i) => i.id === (kind === 'dnbr' ? 'nbr' : kind))!;
    return { expr: indexExpression(it, def), range: [-1, 1] };
  };

  const check = (it: ImageryItem | null): string | null => {
    if (!it) return t('Select scenes A (before) and B (after)');
    const k = sensorOf(it);
    if (kind === 'sar') return k === 's1' ? null : t('SAR change needs Sentinel-1 RTC scenes');
    if (k !== 's2' && k !== 'landsat') return t('Optical change needs Sentinel-2 or Landsat scenes');
    if (kind !== 'general') {
      const def = INDICES.find((i) => i.id === (kind === 'dnbr' ? 'nbr' : kind))!;
      const a = indexAvailability(it, def);
      if (!a.ok) return a.why!;
    }
    return null;
  };

  const run = async () => {
    if (!aoi || !A || !B) return;
    const e = check(A) ?? check(B);
    if (e) return setErr(e);
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setErr('');
    setRes(null);
    try {
      const grid = gridFor(aoi.geometry);
      const read = async (it: ImageryItem, lbl: string) => {
        const { expr, range } = exprFor(it);
        const r = await fetchRaster(it, expr, range, grid, ac.signal, (d, n) => setBusy(`${t('Reading')} ${lbl} ${d}/${n}`));
        if (sensorOf(it) === 's2') {
          const clear = await fetchRaster(it, S2_CLEAR_EXPR, [0, 1], grid, ac.signal);
          for (let p = 0; p < r.values.length; p++) if (!(clear.values[p] > 0.5)) r.values[p] = NaN;
        }
        return r;
      };
      const ra = await read(A, 'A');
      const rb = await read(B, 'B');
      setBusy(t('Classifying…'));
      let out: Classified;
      let legend;
      if (kind === 'dnbr') {
        out = classify(aoi.geometry, ra, rb, (a, b) => DNBR_CLASSES.find((c) => a - b < c.max)!.id, DNBR_CLASSES);
        legend = { items: [...DNBR_CLASSES.slice(1).map((c) => ({ color: `rgba(${c.rgba.join(',')})`, label: t(c.label) })), { color: 'rgb(128,128,128)', label: t('No data / cloud') }], note: t('dNBR = NBR(before) − NBR(after). Classes: Key & Benson (2006), FIREMON. Regional calibration recommended.') };
      } else {
        const up = kind === 'ndvi' ? [79, 209, 139, 220] : kind === 'sar' || kind === 'general' ? [124, 231, 247, 220] : [30, 144, 255, 230];
        const down = [242, 102, 90, 220];
        out = classify(aoi.geometry, ra, rb, (a, b) => (b - a >= thr ? 1 : a - b >= thr ? 2 : 3), [
          { id: 1, label: 'Increase', rgba: up as any },
          { id: 2, label: 'Decrease', rgba: down as any },
          { id: 3, label: 'No significant change', rgba: [0, 0, 0, 0] },
        ]);
        legend = {
          items: [
            { color: `rgba(${up.join(',')})`, label: `${t('Increase')} (≥ +${thr})` },
            { color: `rgba(${down.join(',')})`, label: `${t('Decrease')} (≤ −${thr})` },
            { color: 'rgba(0,0,0,0)', label: `${t('No significant change')} (|Δ| < ${thr})` },
            { color: 'rgb(128,128,128)', label: t('No data / cloud') },
          ],
          note: t('Difference of values between dates; a change in value is not proof of a real change on the ground.'),
        };
      }
      const prov = await imageProvider(out.imageUrl, out.grid.west, out.grid.south, out.grid.east, out.grid.north);
      g.putImagery('change', `${t('Change')} · ${t(KINDS.find((k) => k.id === kind)!.label)}`, prov, { meta: `${sceneLabel(A)} → ${sceneLabel(B)}`, legend });
      setRes(out);
      g.putReport({
        id: 'change',
        title: `Change detection — ${KINDS.find((k) => k.id === kind)!.label}`,
        lines: [
          `Before (A): ${A.id} (${A.datetime})`,
          `After (B): ${B.id} (${B.datetime})`,
          kind === 'dnbr' ? 'dNBR = NBR_A − NBR_B, Key & Benson (2006) classes' : `Threshold |Δ| ≥ ${thr}`,
          ...Object.entries(out.areasKm2).map(([k, v]) => `Class ${k}: ${v.toFixed(3)} km² (${((100 * v) / Math.max(out.validKm2, 1e-9)).toFixed(1)} % of valid)`),
          `No data / cloud: ${out.noDataKm2.toFixed(3)} km²`,
          ...compareWarnings(A, B),
        ],
      });
    } catch (e2: any) {
      if (e2.name !== 'AbortError') setErr(e2.message);
    } finally {
      setBusy('');
    }
  };

  const toggleSwipe = () => {
    if (!A || !B) return;
    if (swipe) {
      g.removeLayer('swipe-a');
      g.removeLayer('swipe-b');
      setSwipe(false);
      return;
    }
    const mk = (it: ImageryItem) =>
      sensorOf(it) === 's1'
        ? pcProvider(indexTileUrl(it, sarDbExpression('vv'), [-25, 0], 'greys_r'), it)
        : pcProvider(compositeTileUrl(it, ['red', 'green', 'blue'], DEFAULT_STRETCH), it);
    const la = g.putImagery('swipe-a', `◀ A ${sceneLabel(A)}`, mk(A));
    const lb = g.putImagery('swipe-b', `B ${sceneLabel(B)} ▶`, mk(B));
    if (la) la.splitDirection = Cesium.SplitDirection.LEFT;
    if (lb) lb.splitDirection = Cesium.SplitDirection.RIGHT;
    setSwipe(true);
  };

  const runSeries = async () => {
    if (!aoi || !A) return;
    if (kind === 'general' || kind === 'dnbr') return setErr(t('Time series supports NDVI, NDWI, MNDWI and SAR.'));
    const pool = [...lastResults].filter((x) => x.collection === A.collection && x.source === 'planetary-computer').sort((a, b) => a.datetime.localeCompare(b.datetime)).slice(-14);
    if (pool.length < 2) return setErr(t('Search more scenes of the same collection over this AOI first (Imagery Explorer or Identify).'));
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setErr('');
    const out: { date: string; value: number; id: string; clear: boolean }[] = [];
    try {
      for (let i = 0; i < pool.length; i++) {
        setBusy(`${t('Time series')} ${i + 1}/${pool.length}`);
        const it = pool[i];
        const { expr, range } = exprFor(it);
        try {
          const s = await indexSummary(it, expr, aoi.geometry, range, ac.signal);
          if (s.cloudFraction != null && s.cloudFraction > 0.8) continue;
          out.push({ date: it.datetime.slice(0, 10), value: s.clearMean ?? s.stats.mean, id: it.id, clear: s.clearMean != null });
        } catch {
          /* scene may not cover AOI */
        }
      }
      setSeries(out);
    } catch (e2: any) {
      if (e2.name !== 'AbortError') setErr(e2.message);
    } finally {
      setBusy('');
    }
  };

  const warn = A && B ? compareWarnings(A, B) : [];

  return (
    <div className="space-y-2.5">
      <div className="text-[11px] text-slate-300">
        <div>A ({t('before')}): {sceneLabel(A)}</div>
        <div>B ({t('after')}): {sceneLabel(B)}</div>
      </div>
      <Select value={kind} onChange={(e) => { const k = e.target.value as Kind; setKind(k); setThr(k === 'sar' ? 3 : k === 'general' ? 0.05 : 0.15); }}>
        {KINDS.map((k) => <option key={k.id} value={k.id}>{t(k.label)}</option>)}
      </Select>
      {kind !== 'dnbr' && (
        <Field label={kind === 'sar' ? t('Change threshold (dB)') : t('Change threshold |Δ|')}>
          <Input type="number" step={kind === 'sar' ? 0.5 : 0.01} value={thr} onChange={(e) => setThr(Math.abs(+e.target.value))} />
        </Field>
      )}
      <p className="text-[10px] text-muted">{t('A lower threshold detects more change but also more noise. Land-cover classification change is not available (needs a classifier).')}</p>
      {warn.length > 0 && <Notice tone="warn">{warn.map((w) => <div key={w}>• {t(w)}</div>)}</Notice>}
      <div className="flex flex-wrap gap-1.5">
        <Button variant="primary" onClick={run} disabled={!aoi || !A || !B || !!busy}>{t('Detect change')}</Button>
        <Button variant={swipe ? 'active' : 'ghost'} onClick={toggleSwipe} disabled={!A || !B}>{t('Swipe A | B')}</Button>
        <Button onClick={runSeries} disabled={!aoi || !A || !!busy}>{t('Time series')}</Button>
        {busy && <Button variant="danger" onClick={() => abort.current?.abort()}>{t('Cancel')}</Button>}
      </div>
      {swipe && <p className="text-[10px] text-cyan-300">{t('Drag the swipe slider at the bottom of the map.')}</p>}
      {busy && <div className="flex items-center gap-2 text-xs text-muted"><Spinner /> {busy}</div>}
      {err && <Notice tone="bad">{err}</Notice>}
      {res && (
        <div className="rounded border border-line p-2">
          <dl>
            {kind === 'dnbr'
              ? DNBR_CLASSES.slice(1).map((c) => <KV key={c.id} k={t(c.label)} v={`${fmtNum(res.areasKm2[c.id] ?? 0, 3)} km²`} mono />)
              : (
                <>
                  <KV k={t('Increase')} v={`${fmtNum(res.areasKm2[1] ?? 0, 3)} km² (${fmtNum((100 * (res.areasKm2[1] ?? 0)) / Math.max(res.validKm2, 1e-9), 1)} %)`} mono />
                  <KV k={t('Decrease')} v={`${fmtNum(res.areasKm2[2] ?? 0, 3)} km² (${fmtNum((100 * (res.areasKm2[2] ?? 0)) / Math.max(res.validKm2, 1e-9), 1)} %)`} mono />
                  <KV k={t('No significant change')} v={`${fmtNum(res.areasKm2[3] ?? 0, 3)} km²`} mono />
                </>
              )}
            <KV k={t('No data / cloud')} v={`${fmtNum(res.noDataKm2, 3)} km²`} mono />
            <KV k={t('Valid area')} v={`${fmtNum(res.validKm2, 3)} / ${fmtNum(res.aoiKm2, 3)} km²`} mono />
          </dl>
          <div className="mt-2 flex flex-wrap gap-1">
            <Button onClick={() => downloadJson('change-summary.geojson', { type: 'Feature', geometry: aoi!.geometry, properties: { kind, threshold: kind === 'dnbr' ? 'Key & Benson 2006' : thr, before: A?.id, after: B?.id, areasKm2: res.areasKm2, noDataKm2: res.noDataKm2, validKm2: res.validKm2, rasterBounds: [res.grid.west, res.grid.south, res.grid.east, res.grid.north] } })}>
              {t('Export GeoJSON summary')}
            </Button>
            <a href={res.pngUrl} download="change-mask.png"><Button>{t('Export PNG mask')}</Button></a>
          </div>
          <p className="mt-1 text-[10px] text-muted">{t('Values come from 8-bit tiles of server-side band math (precision ≈ range / 255). Treat small differences with caution.')}</p>
        </div>
      )}
      {series && <SeriesChart series={series} label={t(KINDS.find((k) => k.id === kind)!.label)} />}
    </div>
  );
}

function SeriesChart({ series, label }: { series: { date: string; value: number; id: string; clear: boolean }[]; label: string }) {
  if (!series.length) return <p className="text-[11px] text-muted">{t('No usable scenes (cloud cover or AOI outside the scenes).')}</p>;
  const W = 280, H = 110, P = 26;
  const vs = series.map((s) => s.value);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const span = hi - lo || 1;
  const ts = series.map((s) => new Date(s.date).getTime());
  const t0 = Math.min(...ts), t1 = Math.max(...ts) || t0 + 1;
  const x = (tm: number) => P + ((tm - t0) / (t1 - t0 || 1)) * (W - P - 6);
  const y = (v: number) => H - 14 - ((v - lo) / span) * (H - 24);
  const path = series.map((s, i) => `${i ? 'L' : 'M'}${x(ts[i]).toFixed(1)},${y(s.value).toFixed(1)}`).join(' ');
  const csv = 'date,value,scene,cloud_free_mean\n' + series.map((s) => `${s.date},${s.value.toFixed(4)},${s.id},${s.clear}`).join('\n');
  return (
    <div className="rounded border border-line p-2">
      <div className="label mb-1">{label} — {t('AOI mean over time')}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <line x1={P} x2={W - 6} y1={H - 14} y2={H - 14} stroke="rgba(148,178,214,0.2)" />
        <text x={2} y={y(hi) + 3} fontSize="8" fill="#8b98ab">{hi.toFixed(2)}</text>
        <text x={2} y={y(lo) + 3} fontSize="8" fill="#8b98ab">{lo.toFixed(2)}</text>
        <path d={path} fill="none" stroke="#22d3ee" strokeWidth={1.8} />
        {series.map((s, i) => <circle key={s.id} cx={x(ts[i])} cy={y(s.value)} r={2.6} fill={s.clear ? '#22d3ee' : '#f5b84b'}><title>{`${s.date}: ${s.value.toFixed(3)}`}</title></circle>)}
        <text x={P} y={H - 2} fontSize="8" fill="#8b98ab">{series[0].date}</text>
        <text x={W - 6} y={H - 2} fontSize="8" fill="#8b98ab" textAnchor="end">{series[series.length - 1].date}</text>
      </svg>
      <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`} download="aoi-time-series.csv"><Button>{t('Download CSV')}</Button></a>
      <p className="mt-1 text-[10px] text-muted">{t('Cyan = cloud-free mean (Sentinel-2 SCL); orange = mean of all valid pixels. Scenes with > 80 % cloud in the AOI are skipped.')}</p>
    </div>
  );
}
