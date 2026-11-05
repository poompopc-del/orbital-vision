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
import ResultDownloads from './ResultDownloads';
import { compareWarnings } from './compareChecks';
import { drapeImage } from '../../lib/change';
import { fetchStack, stackSensor } from '../../lib/classify/fetchStack';
import { classifyStack } from '../../lib/classify/run';
import { classChange, compatibility, sameSeasonWindow, CC, CC_INFO } from '../../lib/classify/classChange';
import { polygonMask, rowAreasKm2 } from '../../lib/classify/grid';
import { area as fmtA, isTh, nameOf, tl } from '../../lib/classify/i18n';
import { gsdMeters } from '../../lib/qc';
import { qaValid } from '../../lib/classify/types';

type Kind = 'ndvi' | 'ndwi' | 'mndwi' | 'ndbi' | 'dnbr' | 'sar' | 'general' | 'landcover';

const defaultThr = (k: Kind) => (k === 'sar' ? 3 : k === 'general' ? 0.05 : 0.15);

const KINDS: { id: Kind; label: string }[] = [
  { id: 'ndvi', label: 'NDVI change (vegetation)' },
  { id: 'ndwi', label: 'NDWI change (water)' },
  { id: 'mndwi', label: 'MNDWI change (water)' },
  { id: 'ndbi', label: 'NDBI change (built-up)' },
  { id: 'dnbr', label: 'dNBR burn severity' },
  { id: 'sar', label: 'SAR VV backscatter change (dB)' },
  { id: 'general', label: 'General brightness difference' },
  { id: 'landcover', label: 'Land-cover class change (multi-index, with uncertainty)' },
];
const CC_SHOWN = [CC.VegLoss, CC.VegGain, CC.PossibleFlood, CC.WaterLoss, CC.BuiltGain, CC.BareGain, CC.Uncertain, CC.NoChange];
const geomKey = (it: ImageryItem) => { const p = it.raw?.properties ?? {}; return String(p['s2:mgrs_tile'] ?? (p['landsat:wrs_path'] != null ? `${p['landsat:wrs_path']}/${p['landsat:wrs_row']}` : p['sat:relative_orbit'] ?? '')) || undefined; };

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
  const [kindState, setKind] = useState<Kind>('ndvi');
  const [thrState, setThr] = useState(0.15);
  const kind = kindState;
  const thr = thrState;
  const [resMeta, setResMeta] = useState<{ A: ImageryItem; B: ImageryItem; kind: Kind; thr: number; legend: { color: string; label: string }[] } | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [res, setRes] = useState<Classified | null>(null);
  const [swipe, setSwipe] = useState(false);
  const [ccInfo, setCcInfo] = useState<{ warnings: string[]; validShare: number; season: boolean } | null>(null);
  const [series, setSeries] = useState<{ date: string; value: number; id: string; clear: boolean }[] | null>(null);
  const abort = useRef<AbortController | null>(null);
  const A = g.sceneA, B = g.sceneB;
  useEffect(() => {
    if (!g.resetKey) return;
    setRes(null);
    setResMeta(null);
    setSeries(null);
    setSwipe(false);
    setErr('');
  }, [g.resetKey]);

  const exprFor = (it: ImageryItem, kind: Kind = kindState): { expr: string; range: [number, number] } => {
    if (kind === 'sar') return { expr: sarDbExpression('vv'), range: [-30, 5] };
    if (kind === 'general') {
      const r = refl(it, 'red'), gg = refl(it, 'green'), b = refl(it, 'blue');
      return { expr: `((${r}+${gg}+${b})/3)`, range: [0, 0.4] };
    }
    const def = INDICES.find((i) => i.id === (kind === 'dnbr' ? 'nbr' : kind))!;
    return { expr: indexExpression(it, def), range: [-1, 1] };
  };

  const check = (it: ImageryItem | null, kind: Kind = kindState): string | null => {
    if (!it) return t('Select scenes A (before) and B (after)');
    const k = sensorOf(it);
    if (kind === 'landcover') return stackSensor(it) ? null : tl('Class change needs Sentinel-2, Landsat 8/9 or Sentinel-1 RTC scenes', 'การเปลี่ยนประเภทต้องใช้ภาพ Sentinel-2, Landsat 8/9 หรือ Sentinel-1 RTC');
    if (kind === 'sar') return k === 's1' ? null : t('SAR change needs Sentinel-1 RTC scenes');
    if (k !== 's2' && k !== 'landsat') return t('Optical change needs Sentinel-2 or Landsat scenes');
    if (kind !== 'general') {
      const def = INDICES.find((i) => i.id === (kind === 'dnbr' ? 'nbr' : kind))!;
      const a = indexAvailability(it, def);
      if (!a.ok) return a.why!;
    }
    return null;
  };

  const run = async (o?: { A?: ImageryItem; B?: ImageryItem; kind?: Kind }) => {
    const kind = o?.kind ?? kindState;
    const thr = o?.kind ? defaultThr(o.kind) : thrState;
    const A = o?.A ?? g.sceneA;
    const B = o?.B ?? g.sceneB;
    if (o?.kind) {
      setKind(o.kind);
      setThr(thr);
    }
    if (!aoi || !A || !B) return;
    const e = check(A, kind) ?? check(B, kind);
    if (e) return setErr(e);
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setErr('');
    setRes(null);
    setCcInfo(null);
    if (kind === 'landcover') {
      try {
        await runClassChange(A, B, ac);
      } catch (e2: any) {
        if (e2.name !== 'AbortError') setErr(e2.message);
      } finally {
        setBusy('');
      }
      return;
    }
    try {
      const grid = gridFor(aoi.geometry);
      const read = async (it: ImageryItem, lbl: string) => {
        const { expr, range } = exprFor(it, kind);
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
        const up = kind === 'ndbi' ? [255, 120, 90, 220] : kind === 'ndvi' ? [79, 209, 139, 220] : kind === 'sar' || kind === 'general' ? [124, 231, 247, 220] : [30, 144, 255, 230];
        const down = kind === 'ndbi' ? [79, 209, 139, 220] : [242, 102, 90, 220];
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
      setResMeta({ A, B, kind, thr, legend: (legend as any).items ?? [] });
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


  /** Change between two land-cover maps: only confident, QC-passed pixels count; the rest is uncertain / not checkable. */
  const runClassChange = async (A: ImageryItem, B: ImageryItem, ac: AbortController) => {
    if (!aoi) return;
    const grid = gridFor(aoi.geometry, 768, 16);
    const mask = polygonMask(grid, aoi.geometry);
    const rowA = rowAreasKm2(grid);
    const sa = await fetchStack(A, grid, ac.signal, (n, d, tot) => setBusy(`${t('Reading')} A: ${n} (${d}/${tot})`));
    const sb = await fetchStack(B, grid, ac.signal, (n, d, tot) => setBusy(`${t('Reading')} B: ${n} (${d}/${tot})`));
    setBusy(t('Classifying…'));
    const la = classifyStack(sa, { mask }), lb = classifyStack(sb, { mask });
    let aoiKm2 = 0, va = 0, vb = 0;
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p]) continue;
      const a = rowA[Math.floor(p / grid.width)];
      aoiKm2 += a;
      if (qaValid(la.qa[p])) va += a;
      if (qaValid(lb.qa[p])) vb += a;
    }
    const comp = compatibility(
      { sensor: sa.sensor, gsdM: gsdMeters(A), date: A.datetime, geometryKey: geomKey(A) },
      { sensor: sb.sensor, gsdM: gsdMeters(B), date: B.datetime, geometryKey: geomKey(B) },
      aoiKm2 ? va / aoiKm2 : 0, aoiKm2 ? vb / aoiKm2 : 0, 0.6, isTh() ? 'th' : 'en',
    );
    const season = !sameSeasonWindow(A.datetime, B.datetime);
    setCcInfo({ warnings: comp.warnings, validShare: comp.validShare, season });
    if (!comp.ok) throw new Error(`${tl('Not comparable', 'เปรียบเทียบไม่ได้')}: ${comp.blocking.join(' · ')}`);
    const classes = classChange({ cls: la.refined.cls, level: la.refined.level, qa: la.qa }, { cls: lb.refined.cls, level: lb.refined.level, qa: lb.qa }, { differentSeason: season, mask });
    const areas: Record<number, number> = {};
    let valid = 0, noData = 0;
    for (let p = 0; p < classes.length; p++) {
      if (!mask[p]) continue;
      const a = rowA[Math.floor(p / grid.width)];
      if (classes[p] === CC.NotCheckable) { noData += a; continue; }
      valid += a;
      areas[classes[p]] = (areas[classes[p]] ?? 0) + a;
    }
    const url = drapeImage(grid, (p) => (mask[p] ? CC_INFO[classes[p] as CC]?.rgba ?? null : null), (p) => !!CC_INFO[classes[p] as CC]?.hatch);
    const out: Classified = { grid, classes, areasKm2: areas, validKm2: valid, noDataKm2: noData, aoiKm2, imageUrl: url, pngUrl: url };
    const legendItems = [...CC_SHOWN.filter((c) => c !== CC.NoChange), CC.NotCheckable].map((c) => ({ color: `rgba(${CC_INFO[c].rgba.slice(0, 3).join(',')},${(CC_INFO[c].rgba[3] / 255).toFixed(2)})`, label: nameOf(CC_INFO[c]) }));
    const prov = await imageProvider(url, grid.west, grid.south, grid.east, grid.north);
    g.putImagery('change', `${t('Change')} · ${tl('land-cover classes', 'ประเภทสิ่งปกคลุมดิน')}`, prov, {
      meta: `${sceneLabel(A)} → ${sceneLabel(B)}`,
      legend: { items: legendItems, note: tl('Provisional rule-based classes on both dates. Change is counted only where both dates are at least medium confidence; seasonal crop / water changes between seasons are shown as uncertain.', 'จำแนกด้วยกฎแบบเบื้องต้นทั้งสองวัน · นับเป็นการเปลี่ยนแปลงเฉพาะพิกเซลที่ทั้งสองวันมีความเชื่อมั่นอย่างน้อยระดับปานกลาง · การเปลี่ยนของพืชไร่หรือน้ำตามฤดูกาลระหว่างต่างฤดูแสดงเป็น “ไม่แน่นอน”') },
    });
    setRes(out);
    setResMeta({ A, B, kind: 'landcover', thr: 0, legend: legendItems });
    g.putReport({
      id: 'change',
      title: 'Change detection — land-cover class change (provisional)',
      lines: [
        `Before (A): ${A.id} (${A.datetime}) · After (B): ${B.id} (${B.datetime})`,
        `Classification: ${la.methodLabel} on both dates (provisional, not validated)`,
        `Usable in both images: ${(comp.validShare * 100).toFixed(0)}% of the AOI`,
        season ? 'Different seasons: agricultural / seasonal-water changes downgraded to uncertain' : 'Same season window (±45 days)',
        ...CC_SHOWN.map((c) => `${CC_INFO[c].en}: ${(areas[c] ?? 0).toFixed(3)} km² (${((areas[c] ?? 0) * 625).toFixed(1)} rai)`),
        `Not checkable (cloud / shadow / no data): ${noData.toFixed(3)} km²`,
        ...comp.warnings,
      ],
    });
  };

  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => g.registerAction('change', (o) => void runRef.current(o)), [g.registerAction]);

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
    if (kind === 'general' || kind === 'dnbr') return setErr(t('Time series supports NDVI, NDWI, MNDWI, NDBI and SAR.'));
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
      {kind === 'landcover' && <p className="text-[10px] leading-snug text-muted">{tl('Classifies both images with the multi-index rules (QA-masked), then compares classes. Separates vegetation, water, built-up and bare-soil change; anything not clear-cut is “uncertain change”. This is separate from the index-difference methods above.', 'จำแนกภาพทั้งสองด้วยกฎหลายดัชนี (ตัดพิกเซลที่ไม่ผ่านการตรวจคุณภาพ) แล้วเทียบประเภท · แยกการเปลี่ยนแปลงของพืชพรรณ น้ำ สิ่งปลูกสร้าง และดินเปล่า · กรณีที่ไม่ชัดเจนแสดงเป็น “การเปลี่ยนแปลงไม่แน่นอน” · แยกจากวิธีหาผลต่างของดัชนีด้านบน')}</p>}
      {kind !== 'dnbr' && kind !== 'landcover' && (
        <Field label={kind === 'sar' ? t('Change threshold (dB)') : t('Change threshold |Δ|')}>
          <Input type="number" step={kind === 'sar' ? 0.5 : 0.01} value={thr} onChange={(e) => setThr(Math.abs(+e.target.value))} />
        </Field>
      )}
      <p className="text-[10px] text-muted">{t('A lower threshold detects more change but also more noise. For class-based change choose “Land-cover class change”.')}</p>
      {warn.length > 0 && <Notice tone="warn">{warn.map((w) => <div key={w}>• {t(w)}</div>)}</Notice>}
      <div className="flex flex-wrap gap-1.5">
        <Button variant="primary" onClick={() => run()} disabled={!aoi || !A || !B || !!busy}>{t('Detect change')}</Button>
        <Button variant={swipe ? 'active' : 'ghost'} onClick={toggleSwipe} disabled={!A || !B}>{t('Swipe A | B')}</Button>
        <Button onClick={runSeries} disabled={!aoi || !A || !!busy}>{t('Time series')}</Button>
        {busy && <Button variant="danger" onClick={() => abort.current?.abort()}>{t('Cancel')}</Button>}
      </div>
      {swipe && <p className="text-[10px] text-cyan-300">{t('Drag the swipe slider at the bottom of the map.')}</p>}
      {busy && <div className="flex items-center gap-2 text-xs text-muted"><Spinner /> {busy}</div>}
      {err && <Notice tone="bad">{err}</Notice>}
      {ccInfo && ccInfo.warnings.length > 0 && <Notice tone="warn">{ccInfo.warnings.map((w) => <div key={w}>• {w}</div>)}</Notice>}
      {res && res.validKm2 < 0.6 * res.aoiKm2 && (
        <Notice tone="warn">{tl('Less than 60% of the AOI could be compared (cloud, shadow or no data). Do not read the remaining area as “no change”.', 'เปรียบเทียบได้น้อยกว่า 60% ของ AOI (เมฆ เงา หรือไม่มีข้อมูล) · ห้ามตีความพื้นที่ที่เหลือว่า “ไม่เปลี่ยนแปลง”')}</Notice>
      )}
      {res && (
        <div className="ov-enter rounded border border-line p-2">
          <dl>
            {resMeta?.kind === 'landcover'
              ? CC_SHOWN.map((c) => <KV key={c} k={nameOf(CC_INFO[c])} v={`${fmtA(res.areasKm2[c] ?? 0)} · ${fmtNum((100 * (res.areasKm2[c] ?? 0)) / Math.max(res.aoiKm2, 1e-9), 1)} %`} mono />)
              : kind === 'dnbr'
              ? DNBR_CLASSES.slice(1).map((c) => <KV key={c.id} k={t(c.label)} v={`${fmtNum(res.areasKm2[c.id] ?? 0, 3)} km²`} mono />)
              : (
                <>
                  <KV k={t('Increase')} v={`${fmtNum(res.areasKm2[1] ?? 0, 3)} km² (${fmtNum((100 * (res.areasKm2[1] ?? 0)) / Math.max(res.validKm2, 1e-9), 1)} %)`} mono />
                  <KV k={t('Decrease')} v={`${fmtNum(res.areasKm2[2] ?? 0, 3)} km² (${fmtNum((100 * (res.areasKm2[2] ?? 0)) / Math.max(res.validKm2, 1e-9), 1)} %)`} mono />
                  <KV k={t('No significant change')} v={`${fmtNum(res.areasKm2[3] ?? 0, 3)} km²`} mono />
                </>
              )}
            <KV k={t('No data / cloud')} v={fmtA(res.noDataKm2)} mono />
            <KV k={t('Valid area')} v={`${fmtA(res.validKm2)} / ${fmtA(res.aoiKm2)}`} mono />
          </dl>
          <div className="mt-2 flex flex-wrap gap-1">
            <Button onClick={() => downloadJson('change-summary.geojson', { type: 'Feature', geometry: aoi!.geometry, properties: { kind, threshold: kind === 'dnbr' ? 'Key & Benson 2006' : thr, before: A?.id, after: B?.id, areasKm2: res.areasKm2, noDataKm2: res.noDataKm2, validKm2: res.validKm2, rasterBounds: [res.grid.west, res.grid.south, res.grid.east, res.grid.north] } })}>
              {t('Export GeoJSON summary')}
            </Button>
          </div>
          {resMeta && (
            <ResultDownloads
              title={t(KINDS.find((k) => k.id === resMeta.kind)!.label)}
              before={resMeta.A}
              after={resMeta.B}
              result={res}
              legend={resMeta.legend}
              summaryLines={[
                resMeta.kind === 'landcover'
                  ? CC_SHOWN.filter((c) => c !== CC.NoChange && (res.areasKm2[c] ?? 0) > 0).map((c) => `${nameOf(CC_INFO[c])}: ${fmtA(res.areasKm2[c] ?? 0)}`).join(' · ')
                  : resMeta.kind === 'dnbr'
                  ? DNBR_CLASSES.slice(1).map((c) => `${t(c.label)}: ${fmtNum(res.areasKm2[c.id] ?? 0, 2)} km²`).join(' · ')
                  : `${t('Increase')}: ${fmtNum(res.areasKm2[1] ?? 0, 2)} km² · ${t('Decrease')}: ${fmtNum(res.areasKm2[2] ?? 0, 2)} km² (|Δ| ≥ ${resMeta.thr})`,
                `${t('No data / cloud')}: ${fmtNum(res.noDataKm2, 2)} km²`,
              ]}
            />
          )}
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
        <text x={2} y={y(hi) + 3} fontSize="8" fill="#939d9a">{hi.toFixed(2)}</text>
        <text x={2} y={y(lo) + 3} fontSize="8" fill="#939d9a">{lo.toFixed(2)}</text>
        <path d={path} fill="none" stroke="#2fc4b2" strokeWidth={1.8} />
        {series.map((s, i) => <circle key={s.id} cx={x(ts[i])} cy={y(s.value)} r={2.6} fill={s.clear ? '#2fc4b2' : '#d5aa69'}><title>{`${s.date}: ${s.value.toFixed(3)}`}</title></circle>)}
        <text x={P} y={H - 2} fontSize="8" fill="#939d9a">{series[0].date}</text>
        <text x={W - 6} y={H - 2} fontSize="8" fill="#939d9a" textAnchor="end">{series[series.length - 1].date}</text>
      </svg>
      <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`} download="aoi-time-series.csv"><Button>{t('Download CSV')}</Button></a>
      <p className="mt-1 text-[10px] text-muted">{t('Green = cloud-free mean (Sentinel-2 SCL); amber = mean of all valid pixels. Scenes with > 80 % cloud in the AOI are skipped.')}</p>
    </div>
  );
}
