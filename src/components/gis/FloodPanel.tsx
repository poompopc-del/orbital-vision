import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { Button, Field, Input, KV, Notice, Select, Spinner } from '../ui';
import { fetchRaster, gridFor, classify, type Classified, type Raster } from '../../lib/change';
import { indexExpression, INDICES, S2_CLEAR_EXPR, sarDbExpression, SAR_WATER_DEFAULT_DB, sensorOf } from '../../lib/spectral';
import { areaKm2, downloadJson } from '../../lib/geo';
import { fmtNum } from '../../lib/format';
import { useWorkspace } from '../../store';
import { useGis } from './GisContext';
import { imageProvider, sceneLabel } from './sceneLayer';
import ResultDownloads from './ResultDownloads';
import { compareWarnings } from './compareChecks';
import type { ImageryItem } from '../../lib/stac';
import { drapeImage } from '../../lib/change';
import { fetchStack } from '../../lib/classify/fetchStack';
import { waterMap, floodPair, floodSingle, FC, type WaterMap } from '../../lib/classify/flood';
import { polygonMask, rowAreasKm2 } from '../../lib/classify/grid';
import { area as fmtA, tl } from '../../lib/classify/i18n';

/** multi = optical multi-index (recommended) · sar2 = Sentinel-1 VV + VH · the rest are single-index thresholds (kept for comparison) */
type Method = 'multi' | 'sar2' | 'mndwi' | 'ndwi' | 'sar';
const isSar = (m: Method) => m === 'sar' || m === 'sar2';

const COLORS = {
  perm: [27, 58, 138, 220] as [number, number, number, number],
  flood: [30, 144, 255, 230] as [number, number, number, number],
  receded: [245, 184, 75, 220] as [number, number, number, number],
  water: [30, 144, 255, 230] as [number, number, number, number],
  uncertain: [190, 170, 220, 190] as [number, number, number, number],
};

export default function FloodPanel() {
  const g = useGis();
  const { aoi } = useWorkspace();
  const [methodState, setMethod] = useState<Method>('multi');
  const [adaptive, setAdaptive] = useState(true);
  const [thrInfo, setThrInfo] = useState<{ post: WaterMap['threshold']; pre: WaterMap['threshold'] | null; validPost: number; validPre: number | null } | null>(null);
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
    setThr(isSar(m) ? SAR_WATER_DEFAULT_DB : 0);
  };

  const run = async (o?: { pre?: ImageryItem | null; post?: ImageryItem; method?: Method }) => {
    const method = o?.method ?? methodState;
    const thr = o?.method ? (isSar(o.method) ? SAR_WATER_DEFAULT_DB : 0) : thrState;
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
      if (isSar(method) && k !== 's1') return t('SAR water detection needs a Sentinel-1 RTC scene');
      if (!isSar(method) && k !== 's2' && k !== 'landsat') return t('Optical water indices need Sentinel-2 or Landsat');
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
    setThrInfo(null);
    if (method === 'multi' || method === 'sar2') {
      try {
        await runMulti(method, post, pre, ac);
      } catch (e: any) {
        if (e.name !== 'AbortError') setErr(e.message);
      } finally {
        setBusy('');
      }
      return;
    }
    try {
      const grid = gridFor(aoi.geometry);
      const load = async (it: ImageryItem, label: string): Promise<Raster> => {
        setBusy(`${t('Reading')} ${label}…`);
        const r = await fetchRaster(it, exprFor(it), range, grid, ac.signal, (d, n) => setBusy(`${t('Reading')} ${label} ${d}/${n}`));
        if (sensorOf(it) === 's2') {
          // treat cloud, cloud shadow, cirrus, saturated and no-data pixels (SCL) as no data
          const clear = await fetchRaster(it, S2_CLEAR_EXPR, [0, 1], grid, ac.signal);
          for (let p = 0; p < r.values.length; p++) if (!(clear.values[p] > 0.5)) r.values[p] = NaN;
        }
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


  /** Multi-evidence water mapping on QC-passed pixels; new water is a POSSIBLE flood, unclear pixels are Uncertain. */
  const runMulti = async (method: 'multi' | 'sar2', post: ImageryItem, pre: ImageryItem | null, ac: AbortController) => {
    if (!aoi) return;
    const grid = gridFor(aoi.geometry, 768, 16);
    const mask = polygonMask(grid, aoi.geometry);
    const rowA = rowAreasKm2(grid);
    const read = async (it: ImageryItem, label: string) => {
      const st = await fetchStack(it, grid, ac.signal, (n, d, tot) => setBusy(`${t('Reading')} ${label}: ${n} (${d}/${tot})`));
      return waterMap(st, { adaptive, mask });
    };
    const wPost = await read(post, t('after'));
    const wPre = pre ? await read(pre, t('before')) : null;
    setBusy(t('Classifying…'));
    const classes = wPre ? floodPair(wPre.state, wPost.state) : floodSingle(wPost.state);
    const areas: Record<number, number> = {};
    let aoiKm2 = 0, noData = 0, valid = 0, vPost = 0, vPre = 0;
    for (let p = 0; p < classes.length; p++) {
      if (!mask[p]) { classes[p] = 0; continue; }
      const a = rowA[Math.floor(p / grid.width)];
      aoiKm2 += a;
      if (wPost.state[p]) vPost += a;
      if (wPre?.state[p]) vPre += a;
      if (classes[p] === FC.nodata) { noData += a; continue; }
      valid += a;
      areas[classes[p]] = (areas[classes[p]] ?? 0) + a;
    }
    const colour: Record<number, readonly [number, number, number, number]> = { 1: COLORS.perm, 2: COLORS.flood, 3: COLORS.receded, 5: COLORS.uncertain, 255: [128, 128, 128, 110] };
    if (!wPre) colour[1] = COLORS.water;
    const url = drapeImage(grid, (p) => colour[classes[p]] ?? null, (p) => classes[p] === FC.uncertain || classes[p] === FC.nodata);
    const out: Classified = { grid, classes, areasKm2: areas, validKm2: valid, noDataKm2: noData, aoiKm2, imageUrl: url, pngUrl: url };
    const prov = await imageProvider(url, grid.west, grid.south, grid.east, grid.north);
    const thrTxt = (w: WaterMap) => `${w.threshold.name} ${w.threshold.used === 'otsu' ? 'Otsu' : tl('fixed', 'คงที่')} ${w.threshold.value.toFixed(method === 'sar2' ? 1 : 3)}`;
    const methodLabel = method === 'sar2' ? `Sentinel-1 VV+VH · ${thrTxt(wPost)}` : `${tl('Multi-index', 'หลายดัชนี')} MNDWI/NDWI/AWEI · ${thrTxt(wPost)}`;
    const items = wPre
      ? [
          { color: 'rgb(27,58,138)', label: t('Permanent / pre-existing water') },
          { color: 'rgb(30,144,255)', label: tl('Possible flood (new water)', 'อาจเป็นน้ำท่วม (น้ำที่ปรากฏใหม่)') },
          { color: 'rgb(245,184,75)', label: t('Water before, not after (check)') },
        ]
      : [{ color: 'rgb(30,144,255)', label: t('Water detected') }];
    items.push({ color: 'rgba(190,170,220,0.8)', label: tl('Uncertain (mixed, low confidence or not checkable before)', 'ไม่แน่นอน (พิกเซลผสม ความเชื่อมั่นต่ำ หรือภาพก่อนตรวจไม่ได้)') });
    items.push({ color: 'rgb(128,128,128)', label: t('No data / cloud / low confidence') });
    g.putImagery('flood', `${t('Flood map')} · ${methodLabel}`, prov, {
      meta: `${pre ? `${sceneLabel(pre)} → ` : ''}${sceneLabel(post)}`,
      legend: { items, note: tl('Potential inundation from satellite data — not confirmation of flooding. Permanent water bodies are separated using the before image.', 'พื้นที่ที่อาจมีน้ำท่วมจากข้อมูลดาวเทียม ไม่ใช่การยืนยันน้ำท่วม · แยกแหล่งน้ำถาวรออกโดยใช้ภาพก่อนเหตุการณ์') },
    });
    setThrInfo({ post: wPost.threshold, pre: wPre?.threshold ?? null, validPost: aoiKm2 ? vPost / aoiKm2 : 0, validPre: wPre && aoiKm2 ? vPre / aoiKm2 : null });
    setRes({ ...out, mode: pre ? 'pair' : 'single', post, pre, method, thr: wPost.threshold.value, legendItems: items });
    g.putReport({
      id: 'flood',
      title: `Water / possible flood mapping — ${methodLabel}`,
      lines: [
        `Method: ${wPost.method}; ${pre ? 'before/after comparison (permanent water separated)' : 'single date'}`,
        `Threshold (after): ${wPost.threshold.name} = ${wPost.threshold.value.toFixed(3)} (${wPost.threshold.used}${wPost.threshold.adaptive ? `; Otsu: ${wPost.threshold.adaptive.reason}` : ''})`,
        wPre ? `Threshold (before): ${wPre.threshold.name} = ${wPre.threshold.value.toFixed(3)} (${wPre.threshold.used})` : '',
        pre ? `Before: ${pre.id} (${pre.datetime})` : '',
        `After: ${post.id} (${post.datetime})`,
        ...Object.entries(areas).map(([k, v]) => `Class ${k}: ${v.toFixed(3)} km² (${(v * 625).toFixed(1)} rai)`),
        `No data / cloud / shadow: ${noData.toFixed(3)} km² of ${aoiKm2.toFixed(3)} km²`,
        'New water is reported as POSSIBLE flood / potential inundation until confirmed by other evidence.',
      ].filter(Boolean),
    });
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
      <div className="grid grid-cols-2 gap-1">
        <Button variant={method === 'multi' ? 'active' : 'ghost'} onClick={() => setM('multi')}>{tl('Optical multi-index', 'ออปติคัล หลายดัชนี')}</Button>
        <Button variant={method === 'sar2' ? 'active' : 'ghost'} onClick={() => setM('sar2')}>{tl('Radar VV + VH', 'เรดาร์ VV + VH')}</Button>
      </div>
      <details className="text-[11px]">
        <summary className="cursor-pointer text-muted">{tl('Single-index thresholds (for comparison)', 'เกณฑ์ดัชนีเดียว (ใช้เปรียบเทียบ)')}</summary>
        <div className="mt-1 grid grid-cols-3 gap-1">
          <Button variant={method === 'mndwi' ? 'active' : 'ghost'} onClick={() => setM('mndwi')}>MNDWI</Button>
          <Button variant={method === 'ndwi' ? 'active' : 'ghost'} onClick={() => setM('ndwi')}>NDWI</Button>
          <Button variant={method === 'sar' ? 'active' : 'ghost'} onClick={() => setM('sar')}>SAR VV</Button>
        </div>
      </details>
      <p className="text-[10px] leading-snug text-muted">
        {method === 'multi'
          ? tl('Water only where MNDWI, NDWI and AWEI agree and NDVI, NIR and SWIR1 confirm it. Cloud, cloud edge, shadow, haze and saturated pixels (S2 SCL / Landsat QA_PIXEL + QA_RADSAT) are excluded; dark / terrain-shadow areas are at most low confidence. Mixed water–vegetation pixels are shown as uncertain.', 'นับเป็นน้ำเฉพาะเมื่อ MNDWI, NDWI และ AWEI ให้ผลตรงกัน และ NDVI, NIR, SWIR1 ยืนยัน · ตัดเมฆ ขอบเมฆ เงาเมฆ หมอก และค่าอิ่มตัวออก (S2 SCL / Landsat QA_PIXEL + QA_RADSAT) · พื้นที่มืดหรือเงาภูเขาได้ความเชื่อมั่นสูงสุดแค่ระดับต่ำ · พิกเซลผสมน้ำกับพืชแสดงเป็น “ไม่แน่นอน”')
          : method === 'sar2'
            ? tl('Speckle-filtered VV decides, VH confirms. Very low backscatter in both polarisations can also be radar shadow behind slopes or noise and stays low confidence. Wind-roughened water can be missed. Optical indices are not applied to radar.', 'ใช้ VV ที่กรองสัญญาณรบกวนแล้วเป็นหลัก และใช้ VH ยืนยัน · ค่าสะท้อนกลับต่ำมากทั้งสองโพลาไรเซชันอาจเป็นเงาเรดาร์หลังภูเขาหรือสัญญาณรบกวน จึงได้ความเชื่อมั่นต่ำ · ผิวน้ำที่มีคลื่นลมอาจตรวจไม่พบ · ไม่ใช้ดัชนีออปติคัลกับภาพเรดาร์')
            : method === 'sar'
              ? t('SAR workflow: water returns little backscatter. Pixels with VV below the threshold (dB) are classed as water. Wind, rain cells, radar shadow and smooth tarmac can mislead. Optical indices are not applied to SAR.')
              : t('Optical workflow: pixels above the index threshold are classed as water; Sentinel-2 clouds, shadows and cirrus (SCL) are removed as no data. Built-up areas and shadows can still be misclassified.')}
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        {method === 'multi' || method === 'sar2' ? (
          <label className="flex items-start gap-1.5 pt-4 text-[11px] text-slate-300" title={tl('Otsu threshold from the AOI histogram, used only when the histogram is clearly bimodal and the value is plausible; otherwise the fixed threshold is kept.', 'คำนวณเกณฑ์แบบ Otsu จากฮิสโทแกรมใน AOI ใช้เมื่อฮิสโทแกรมแยกสองกลุ่มชัดเจนและค่าอยู่ในช่วงที่สมเหตุสมผลเท่านั้น ไม่เช่นนั้นจะใช้เกณฑ์คงที่')}>
            <input type="checkbox" className="mt-0.5" checked={adaptive} onChange={(e) => setAdaptive(e.target.checked)} />
            {tl('Adaptive threshold (Otsu)', 'เกณฑ์ปรับตามภาพ (Otsu)')}
          </label>
        ) : (
          <Field label={method === 'sar' ? t('Threshold (dB)') : t('Threshold')}>
            <Input type="number" step={method === 'sar' ? 0.5 : 0.02} value={thr} onChange={(e) => setThr(+e.target.value)} />
          </Field>
        )}
        <Field label={t('Comparison')}>
          <Select value={usePre ? 'pair' : 'single'} onChange={(e) => setUsePre(e.target.value === 'pair')}>
            <option value="pair">{t('Before / after')}</option>
            <option value="single">{t('Single date')}</option>
          </Select>
        </Field>
      </div>
      {usePre && !pre && post && <p className="text-[10px] text-warn">{tl('No “before” image (scene A): permanent water cannot be separated from new water, so every water pixel is reported as water — not as flood.', 'ไม่มีภาพ “ก่อน” (ภาพ A) จึงแยกแหล่งน้ำถาวรออกจากน้ำใหม่ไม่ได้ · พิกเซลน้ำทั้งหมดจะแสดงเป็น “น้ำ” ไม่ใช่ “น้ำท่วม”')}</p>}
      {warn.length > 0 && <Notice tone="warn">{warn.map((w) => <div key={w}>• {t(w)}</div>)}</Notice>}
      <div className="flex gap-1.5">
        <Button variant="primary" onClick={() => run()} disabled={!aoi || !post || !!busy}>{t('Map water')}</Button>
        {busy && <Button variant="danger" onClick={() => abort.current?.abort()}>{t('Cancel')}</Button>}
      </div>
      {!aoi && <p className="text-[11px] text-muted">{t('Draw a rectangle AOI first.')}</p>}
      {busy && <div className="flex items-center gap-2 text-xs text-muted"><Spinner /> {busy}</div>}
      {err && <Notice tone="bad">{err}</Notice>}
      {thrInfo && (thrInfo.validPost < 0.6 || (thrInfo.validPre != null && thrInfo.validPre < 0.6)) && (
        <Notice tone="warn">{tl('Less than 60% of the AOI is usable in at least one image (cloud, shadow or no data). Treat the result as incomplete.', 'มีพื้นที่ใช้ได้น้อยกว่า 60% ของ AOI ในภาพอย่างน้อยหนึ่งภาพ (เมฆ เงา หรือไม่มีข้อมูล) · ผลลัพธ์ยังไม่ครบถ้วน')}</Notice>
      )}
      {res && (
        <div className="ov-enter rounded border border-line p-2">
          <dl>
            {res.mode === 'pair' ? (
              <>
                <KV k={tl('Possible flood (new water)', 'อาจเป็นน้ำท่วม (น้ำที่ปรากฏใหม่)')} v={fmtA(area(2))} mono />
                <KV k={t('Permanent / pre-existing water')} v={fmtA(area(1))} mono />
                <KV k={t('Water before, not after')} v={fmtA(area(3))} mono />
              </>
            ) : (
              <KV k={t('Water detected')} v={fmtA(area(1))} mono />
            )}
            {(res.method === 'multi' || res.method === 'sar2') && <KV k={tl('Uncertain', 'ไม่แน่นอน')} v={fmtA(area(5))} mono />}
            <KV k={t('No data / cloud')} v={`${fmtA(res.noDataKm2)} · ${fmtNum((100 * res.noDataKm2) / Math.max(res.aoiKm2, 1e-9), 1)} %`} mono />
            <KV k={t('AOI analysed')} v={`${fmtA(res.aoiKm2)} (${t('polygon')} ${fmtA(areaKm2(aoi!.geometry))})`} mono />
            {thrInfo && (
              <KV
                k={tl('Water threshold', 'เกณฑ์น้ำ')}
                v={`${thrInfo.post.name} ${thrInfo.post.value.toFixed(res.method === 'sar2' ? 1 : 3)} · ${thrInfo.post.used === 'otsu' ? 'Otsu' : tl('fixed', 'คงที่')}${thrInfo.post.adaptive && thrInfo.post.used !== 'otsu' ? ` (${thrInfo.post.adaptive.reason})` : ''}`}
                mono
              />
            )}
            {thrInfo && <KV k={tl('Usable pixels after / before', 'พิกเซลที่ใช้ได้ หลัง / ก่อน')} v={`${(thrInfo.validPost * 100).toFixed(0)}% / ${thrInfo.validPre != null ? `${(thrInfo.validPre * 100).toFixed(0)}%` : '—'}`} mono />}
            <KV k={t('Pixel size')} v={`≈ ${fmtNum(((40075016.7 * Math.cos(((res.grid.north + res.grid.south) / 2) * (Math.PI / 180))) / (256 * 2 ** res.grid.z)), 1)} m (zoom ${res.grid.z})`} mono />
          </dl>
          <div className="mt-2 flex flex-wrap gap-1">
            <Button
              onClick={() =>
                downloadJson('flood-extent-summary.geojson', {
                  type: 'Feature',
                  geometry: aoi!.geometry,
                  properties: {
                    method: res.method === 'multi' ? 'Multi-index MNDWI+NDWI+AWEI with NDVI/NIR/SWIR checks, QA-masked' : res.method === 'sar2' ? 'S1 RTC VV+VH, 5x5 speckle filter' : res.method === 'sar' ? 'S1 RTC VV dB threshold' : `${res.method.toUpperCase()} threshold`,
                    thresholdMode: thrInfo?.post.used ?? 'fixed',
                    areasRai: Object.fromEntries(Object.entries(res.areasKm2).map(([k, v]) => [k, +(v * 625).toFixed(2)])),
                    classes: { 1: 'permanent / pre-existing water (single date: water)', 2: 'possible flood (new water)', 3: 'water before, not after', 4: 'dry', 5: 'uncertain' },
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
            title={`${t('Flood map')} · ${res.method === 'multi' ? tl('multi-index', 'หลายดัชนี') : res.method === 'sar2' ? 'Sentinel-1 VV+VH' : res.method === 'sar' ? `Sentinel-1 VV < ${res.thr} dB` : `${res.method.toUpperCase()} > ${res.thr}`}`}
            before={res.pre}
            after={res.post}
            result={res}
            legend={res.legendItems}
            summaryLines={[
              res.mode === 'pair'
                ? `${tl('Possible flood (new water)', 'อาจเป็นน้ำท่วม (น้ำที่ปรากฏใหม่)')}: ${fmtA(area(2))} · ${t('Permanent / pre-existing water')}: ${fmtA(area(1))}`
                : `${t('Water detected')}: ${fmtA(area(1))}`,
              `${tl('Uncertain', 'ไม่แน่นอน')}: ${fmtA(area(5))} · ${t('No data / cloud')}: ${fmtA(res.noDataKm2)}`,
            ]}
          />
        </div>
      )}
    </div>
  );
}
