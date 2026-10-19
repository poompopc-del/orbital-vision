import { useMemo, useRef, useState } from 'react';
import { t } from '../../i18n';
import { Badge, Button, Field, Input, KV, Notice, Select, Spinner, cx } from '../ui';
import {
  aoiStatistics, bandsFor, COLORMAPS, COMPOSITES, compositeAvailability, compositeTileUrl, DEFAULT_STRETCH, INDICES,
  indexAvailability, indexExpression, indexSummary, indexTileUrl, maskTileUrl, rampCss, refl, sensorOf,
  type IndexDef, type IndexSummary, type Role, type StretchOpts,
} from '../../lib/spectral';
import { areaKm2 } from '../../lib/geo';
import { fmtNum } from '../../lib/format';
import { useWorkspace } from '../../store';
import { useGis } from './GisContext';
import { pcProvider, sceneLabel } from './sceneLayer';
import Histogram from './Histogram';

type Mode = 'index' | 'composite' | 'custom';

export default function SpectralPanel() {
  const g = useGis();
  const { aoi } = useWorkspace();
  const [which, setWhich] = useState<'A' | 'B'>('A');
  const scene = which === 'A' ? g.sceneA : g.sceneB;
  const [mode, setMode] = useState<Mode>('index');
  const [indexId, setIndexId] = useState('ndvi');
  const def = INDICES.find((i) => i.id === indexId)!;
  const [range, setRange] = useState<[number, number]>(def.range);
  const [cmap, setCmap] = useState(def.colormap);
  const [thrOn, setThrOn] = useState(false);
  const [thr, setThr] = useState(0);
  const [below, setBelow] = useState(false);
  const [compId, setCompId] = useState('cir');
  const [rgb, setRgb] = useState<[Role, Role, Role]>(['swir2', 'nir', 'red']);
  const [st, setSt] = useState<StretchOpts>(DEFAULT_STRETCH);
  const [brightness, setBrightness] = useState(1);
  const [stats, setStats] = useState<IndexSummary | null>(null);
  const [maskArea, setMaskArea] = useState<{ frac: number; km2: number; valid: number } | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const abort = useRef<AbortController | null>(null);

  const pickIndex = (d: IndexDef) => {
    setIndexId(d.id);
    setRange(d.range);
    setCmap(d.colormap);
    setThr(d.id === 'sar_vv_db' ? -18 : d.id === 'awei' ? 0 : 0.1);
    setBelow(d.id === 'sar_vv_db');
    setStats(null);
    setMaskArea(null);
  };

  const bands = scene ? bandsFor(scene) : {};
  const avail = scene ? indexAvailability(scene, def) : { ok: false, why: t('Select a scene first') };
  const rgbNow: [Role, Role, Role] = mode === 'composite' ? COMPOSITES.find((c) => c.id === compId)!.rgb : rgb;
  const cAvail = scene ? compositeAvailability(scene, rgbNow) : { ok: false, why: t('Select a scene first') };

  const grouped = useMemo(() => {
    const m = new Map<string, IndexDef[]>();
    INDICES.forEach((d) => m.set(d.group, [...(m.get(d.group) ?? []), d]));
    return [...m.entries()];
  }, []);

  const render = () => {
    if (!scene) return;
    setErr('');
    try {
      if (mode === 'index') {
        const expr = indexExpression(scene, def);
        g.putImagery('spectral', `${def.name} · ${sceneLabel(scene)}`, pcProvider(indexTileUrl(scene, expr, range, cmap), scene), {
          meta: `${def.formula} · ${scene.id}`,
          legend: { ramp: rampCss(cmap), range, note: `${t(def.legend)} ${t('Transparent = no data.')}` },
        });
        if (thrOn) {
          g.putImagery('spectral-mask', `${def.name} ${below ? '<' : '>'} ${thr} · ${scene.datetime.slice(0, 10)}`, pcProvider(maskTileUrl(scene, expr, thr, below, [0, 160, 255, 210]), scene), {
            meta: t('Threshold mask — user-set threshold, not a validated classification'),
            legend: { items: [{ color: 'rgba(0,160,255,0.85)', label: `${def.name} ${below ? '<' : '>'} ${thr}` }] },
          });
        } else g.removeLayer('spectral-mask');
      } else {
        const s2 = { ...st, max: st.max / brightness };
        const names = rgbNow.map((r) => bands[r]?.label ?? r).join(' / ');
        g.putImagery('spectral', `RGB ${names} · ${sceneLabel(scene)}`, pcProvider(compositeTileUrl(scene, rgbNow, s2), scene), {
          meta: `${names} · stretch ${s2.min.toFixed(3)}–${s2.max.toFixed(3)} reflectance · γ ${s2.gamma}`,
          legend: { items: [{ color: '#f2665a', label: `R = ${bands[rgbNow[0]]?.label} (${bands[rgbNow[0]]?.nm} nm)` }, { color: '#4fd18b', label: `G = ${bands[rgbNow[1]]?.label} (${bands[rgbNow[1]]?.nm} nm)` }, { color: '#4f8dff', label: `B = ${bands[rgbNow[2]]?.label} (${bands[rgbNow[2]]?.nm} nm)` }] },
        });
        g.removeLayer('spectral-mask');
      }
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const runStats = async () => {
    if (!scene || !aoi) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setBusy(t('Computing statistics in AOI…'));
    setErr('');
    setMaskArea(null);
    try {
      const expr = indexExpression(scene, def);
      const s = await indexSummary(scene, expr, aoi.geometry, range, ac.signal);
      setStats(s);
      if (thrOn) {
        const cond = below ? `(${expr})<${thr}` : `(${expr})>${thr}`;
        const m = await aoiStatistics(scene, `where(${cond},1,0)`, aoi.geometry, { signal: ac.signal });
        const valid = (m.validPercent ?? 100) / 100;
        setMaskArea({ frac: m.mean, km2: m.mean * areaKm2(aoi.geometry) * Math.min(1, valid), valid });
      }
      g.putReport({
        id: 'spectral',
        title: `${def.name} — ${sceneLabel(scene)}`,
        lines: [
          `Formula: ${def.formula}`,
          `Scene: ${scene.id} (${scene.collectionLabel})`,
          `AOI: ${aoi.name}, ${areaKm2(aoi.geometry).toFixed(2)} km²`,
          `Min / mean / max: ${s.stats.min.toFixed(3)} / ${s.stats.mean.toFixed(3)} / ${s.stats.max.toFixed(3)}`,
          s.clearMean != null ? `Clear-sky mean (SCL-masked): ${s.clearMean.toFixed(3)} · cloud/shadow ${(100 * (s.cloudFraction ?? 0)).toFixed(1)}%` : '',
          `Valid pixels: ${s.stats.validPercent?.toFixed(1) ?? '—'}%`,
          'Source: Microsoft Planetary Computer data API (server-side band math on original bands)',
        ].filter(Boolean),
      });
    } catch (e: any) {
      if (e.name !== 'AbortError') setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const percentileStretch = async () => {
    if (!scene || !aoi) return;
    setBusy(t('Computing 2–98 % stretch…'));
    try {
      if (mode === 'index') {
        const s = await aoiStatistics(scene, indexExpression(scene, def), aoi.geometry);
        if (s.p2 != null && s.p98 != null) setRange([+s.p2.toFixed(3), +s.p98.toFixed(3)]);
      } else {
        const ss = await Promise.all(rgbNow.map((r) => aoiStatistics(scene, refl(scene, r)!, aoi.geometry)));
        const lo = Math.min(...ss.map((x) => x.p2 ?? x.min)), hi = Math.max(...ss.map((x) => x.p98 ?? x.max));
        setSt((o) => ({ ...o, min: Math.max(0, +lo.toFixed(3)), max: +hi.toFixed(3) }));
        setBrightness(1);
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const k = scene ? sensorOf(scene) : 'other';

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-1">
        {(['A', 'B'] as const).map((w) => (
          <Button key={w} variant={which === w ? 'active' : 'ghost'} onClick={() => setWhich(w)} className="justify-start truncate">
            {w}: {sceneLabel(w === 'A' ? g.sceneA : g.sceneB)}
          </Button>
        ))}
      </div>
      {!scene && <Notice>{t('Pick scene A / B from “Identify imagery” or the Imagery Explorer results.')}</Notice>}

      <div className="grid grid-cols-3 gap-1">
        {(['index', 'composite', 'custom'] as Mode[]).map((m) => (
          <Button key={m} variant={mode === m ? 'active' : 'ghost'} onClick={() => setMode(m)}>{t(m === 'index' ? 'Spectral index' : m === 'composite' ? 'Composite' : 'Custom RGB')}</Button>
        ))}
      </div>

      {mode === 'index' && (
        <>
          <div className="max-h-48 overflow-y-auto rounded border border-line scroll-thin">
            {grouped.map(([grp, list]) => (
              <div key={grp}>
                <div className="label bg-ink-950/60 px-2 py-1">{t(grp)}</div>
                {list.map((d) => {
                  const a = scene ? indexAvailability(scene, d) : { ok: true };
                  return (
                    <button
                      key={d.id}
                      disabled={!!scene && !a.ok}
                      onClick={() => pickIndex(d)}
                      title={a.ok ? d.purpose : a.why}
                      className={cx('flex w-full items-center justify-between px-2 py-1 text-left text-xs', indexId === d.id ? 'bg-cyan-400/10 text-white' : 'text-slate-300 hover:bg-navy-800', scene && !a.ok && 'cursor-not-allowed opacity-40')}
                    >
                      <span>{d.name}</span>
                      {scene && !a.ok && <span className="text-[10px] text-muted">{t('n/a')}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="rounded border border-line p-2 text-[11px]">
            <div className="font-semibold text-white">{def.name}</div>
            <div className="text-slate-300">{t(def.purpose)}</div>
            <div className="mt-1 font-mono text-cyan-300">{def.formula}</div>
            {scene && avail.ok && def.roles.length > 0 && (
              <div className="mt-1 text-muted">
                {t('Bands used')}: {def.roles.map((r) => `${bands[r]?.label} (${bands[r]?.nm} nm, ${bands[r]?.res})`).join(' · ')}
                {k === 's2' && ` · ${t('reflectance')} = (DN − ${scene.datetime >= '2022-01-25' || parseFloat(scene.baseline ?? '0') >= 4 ? 1000 : 0}) / 10000`}
                {k === 'landsat' && ` · ${t('reflectance via scale/offset (unscale)')}`}
              </div>
            )}
            <div className="mt-1 text-muted">{t('Sensors')}: {def.sensors.map((s) => (s === 's2' ? 'Sentinel-2' : s === 'landsat' ? 'Landsat 8/9' : 'Sentinel-1 RTC')).join(', ')}</div>
            <div className="mt-1 text-warn">{t(def.caveat)}</div>
            {def.reference && <div className="mt-0.5 text-muted">{t('Reference')}: {def.reference}</div>}
            {scene && !avail.ok && <div className="mt-1 text-bad">{avail.why}</div>}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <Field label={t('Min')}><Input type="number" step="0.05" value={range[0]} onChange={(e) => setRange([+e.target.value, range[1]])} /></Field>
            <Field label={t('Max')}><Input type="number" step="0.05" value={range[1]} onChange={(e) => setRange([range[0], +e.target.value])} /></Field>
            <Field label={t('Colour ramp')}>
              <Select value={cmap} onChange={(e) => setCmap(e.target.value)}>{COLORMAPS.map((c) => <option key={c}>{c}</option>)}</Select>
            </Field>
          </div>
          <div className="h-2.5 rounded" style={{ background: rampCss(cmap) }} />
          <div className="rounded border border-line p-2">
            <label className="flex items-center gap-2 text-xs text-slate-200">
              <input type="checkbox" checked={thrOn} onChange={(e) => setThrOn(e.target.checked)} /> {t('Threshold mask')}
            </label>
            {thrOn && (
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                <Input type="number" step="0.01" value={thr} onChange={(e) => setThr(+e.target.value)} />
                <Select value={below ? 'below' : 'above'} onChange={(e) => setBelow(e.target.value === 'below')}>
                  <option value="above">{t('value > threshold')}</option>
                  <option value="below">{t('value < threshold')}</option>
                </Select>
              </div>
            )}
          </div>
        </>
      )}

      {mode !== 'index' && (
        <>
          {mode === 'composite' ? (
            <Select value={compId} onChange={(e) => setCompId(e.target.value)}>
              {COMPOSITES.map((c) => <option key={c.id} value={c.id}>{t(c.name)}</option>)}
            </Select>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {(['R', 'G', 'B'] as const).map((ch, i) => (
                <Field key={ch} label={ch}>
                  <Select value={rgb[i]} onChange={(e) => setRgb(Object.assign([...rgb], { [i]: e.target.value as Role }) as [Role, Role, Role])}>
                    {(Object.keys(bands) as Role[]).map((r) => <option key={r} value={r}>{bands[r]!.label} · {bands[r]!.nm} nm</option>)}
                  </Select>
                </Field>
              ))}
            </div>
          )}
          {mode === 'composite' && <p className="text-[11px] text-muted">{t(COMPOSITES.find((c) => c.id === compId)!.use)}</p>}
          {scene && !cAvail.ok && <Notice tone="bad">{cAvail.why}</Notice>}
          <div className="grid grid-cols-2 gap-1.5">
            <Field label={`${t('Min reflectance')} · ${st.min.toFixed(3)}`}><input type="range" min={0} max={0.3} step={0.005} value={st.min} onChange={(e) => setSt({ ...st, min: +e.target.value })} className="w-full" /></Field>
            <Field label={`${t('Max reflectance')} · ${st.max.toFixed(3)}`}><input type="range" min={0.05} max={1} step={0.01} value={st.max} onChange={(e) => setSt({ ...st, max: +e.target.value })} className="w-full" /></Field>
            <Field label={`${t('Gamma')} · ${st.gamma.toFixed(2)}`}><input type="range" min={0.5} max={2.5} step={0.05} value={st.gamma} onChange={(e) => setSt({ ...st, gamma: +e.target.value })} className="w-full" /></Field>
            <Field label={`${t('Contrast')} · ${st.contrast.toFixed(0)}`}><input type="range" min={0} max={20} step={1} value={st.contrast} onChange={(e) => setSt({ ...st, contrast: +e.target.value })} className="w-full" /></Field>
            <Field label={`${t('Brightness')} · ${brightness.toFixed(2)}`}><input type="range" min={0.5} max={2.5} step={0.05} value={brightness} onChange={(e) => setBrightness(+e.target.value)} className="w-full" /></Field>
            <Field label={`${t('Saturation')} · ${st.saturation.toFixed(2)}`}><input type="range" min={0.5} max={2} step={0.05} value={st.saturation} onChange={(e) => setSt({ ...st, saturation: +e.target.value })} className="w-full" /></Field>
          </div>
          <p className="text-[10px] text-muted">{t('Opacity is set per layer in the Layer manager. No-data pixels are transparent.')}</p>
        </>
      )}

      <div className="flex flex-wrap gap-1.5">
        <Button variant="primary" onClick={render} disabled={!scene || (mode === 'index' ? !avail.ok : !cAvail.ok)}>{t('Show on map')}</Button>
        <Button onClick={percentileStretch} disabled={!scene || !aoi || !!busy || (mode === 'index' ? !avail.ok : !cAvail.ok)}>{t('2–98 % stretch (AOI)')}</Button>
        {mode === 'index' && <Button onClick={runStats} disabled={!scene || !aoi || !avail.ok || !!busy}>{t('Statistics in AOI')}</Button>}
        {busy && <Button variant="danger" onClick={() => abort.current?.abort()}>{t('Cancel')}</Button>}
      </div>
      {!aoi && <p className="text-[11px] text-muted">{t('Draw a rectangle AOI to compute statistics.')}</p>}
      {busy && <div className="flex items-center gap-2 text-xs text-muted"><Spinner /> {busy}</div>}
      {err && <Notice tone="bad">{err}</Notice>}

      {stats && mode === 'index' && (
        <div className="rounded border border-line p-2">
          <dl>
            <KV k={t('Min / Max')} v={`${fmtNum(stats.stats.min, 3)} / ${fmtNum(stats.stats.max, 3)}`} mono />
            <KV k={t('Mean (all valid pixels)')} v={fmtNum(stats.stats.mean, 3)} mono />
            {stats.clearMean != null && <KV k={t('Mean (cloud-free, SCL)')} v={fmtNum(stats.clearMean, 3)} mono />}
            {stats.cloudFraction != null && <KV k={t('Cloud / shadow in AOI')} v={`${fmtNum(100 * stats.cloudFraction, 1)} %`} mono />}
            <KV k={t('2nd / 98th percentile')} v={`${fmtNum(stats.stats.p2, 3)} / ${fmtNum(stats.stats.p98, 3)}`} mono />
            <KV k={t('Valid pixels')} v={`${fmtNum(stats.stats.validPercent, 1)} %${stats.stats.validPixels != null ? ` (${stats.stats.validPixels.toLocaleString()})` : ''}`} mono />
            {maskArea && <KV k={t('Area matching threshold')} v={`${fmtNum(maskArea.km2, 3)} km² (${fmtNum(100 * maskArea.frac, 1)} % ${t('of valid pixels')})`} mono />}
          </dl>
          {stats.stats.histogram && <Histogram hist={stats.stats.histogram} threshold={thrOn ? thr : null} />}
          {stats.stats.validPercent != null && stats.stats.validPercent < 90 && <p className="text-[10px] text-warn">{t('Part of the AOI has no data in this scene (outside the footprint or masked).')}</p>}
          <p className="mt-1 text-[10px] text-muted">{t('Statistics are computed server-side from the original bands, resampled to ≤ 1024 px across the AOI.')}</p>
        </div>
      )}
      <Badge>{t('Band math: Microsoft Planetary Computer data API')}</Badge>
    </div>
  );
}
