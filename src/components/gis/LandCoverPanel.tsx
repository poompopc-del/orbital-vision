import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Notice, Select, Spinner, cx } from '../ui';
import { drapeImage, gridFor, type Grid } from '../../lib/change';
import { indexExpression, indexTileUrl, INDICES, sarDbExpression } from '../../lib/spectral';
import type { ImageryItem } from '../../lib/stac';
import { downloadJson } from '../../lib/geo';
import { useWorkspace } from '../../store';
import { useGis } from './GisContext';
import { imageProvider, pcProvider, sceneLabel } from './sceneLayer';
import { CONF_INFO, Conf, LC, LC_INFO, QA, QA_INFO, SURFACE_CLASSES, featuresFor, qaValid, type FeatureName } from '../../lib/classify/types';
import { fetchStack, fetchWorldCover, stackSensor } from '../../lib/classify/fetchStack';
import { classifyStack, featureVector, summarize, type LandCover, type Summary } from '../../lib/classify/run';
import { FLAG } from '../../lib/classify/spatial';
import { polygonMask, rowAreasKm2, pixelSizeM } from '../../lib/classify/grid';
import type { Stack } from '../../lib/classify/stack';
import { parseSamples, samplePixels, type ParsedSamples } from '../../lib/classify/training';
import { assess, spatialSplit, type Assessment } from '../../lib/classify/accuracy';
import { predict, trainForest, parseForest, type Forest } from '../../lib/classify/rf';
import { deleteModel, downloadModel, listModels, saveModel } from '../../lib/classify/modelStore';
import { area, nameOf, tl } from '../../lib/classify/i18n';

type LayerKey = 'lc' | 'raw' | 'conf' | 'uncertain' | 'qa' | 'index';

interface Run {
  item: ImageryItem;
  grid: Grid;
  mask: Uint8Array;
  rowArea: Float64Array;
  stack: Stack;
  lc: LandCover;
  sumRaw: Summary;
  sumRef: Summary;
  worldCover: boolean;
}

const rgbaCss = (c: readonly number[]) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(2)})`;
const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : '—');

export default function LandCoverPanel() {
  const g = useGis();
  const { aoi } = useWorkspace();
  const [which, setWhich] = useState<'A' | 'B'>('B');
  const scene = (which === 'A' ? g.sceneA : g.sceneB) ?? g.sceneA ?? g.sceneB;
  const [method, setMethod] = useState<'rules' | 'model'>('rules');
  const [models, setModels] = useState<Forest[]>(() => listModels());
  const [modelId, setModelId] = useState('');
  const [useCtx, setUseCtx] = useState(true);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [shown, setShown] = useState<Record<LayerKey, boolean>>({ lc: true, raw: false, conf: false, uncertain: false, qa: false, index: false });
  const [samples, setSamples] = useState<(ParsedSamples & { name: string }) | null>(null);
  const [acc, setAcc] = useState<{ title: string; a: Assessment; note: string; warnings: string[] } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const modelFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!g.resetKey) return;
    setRun(null);
    setAcc(null);
    setErr('');
  }, [g.resetKey]);

  const sensor = scene ? stackSensor(scene) : null;
  const usableModels = models.filter((m) => m.meta.sensor === sensor);
  const model = usableModels.find((m) => m.meta.id === modelId) ?? usableModels[0] ?? null;

  // ------------------------------------------------------------ layers
  const draw = async (key: LayerKey, r: Run, on: boolean) => {
    const id = `lc-${key}`;
    if (!on) return g.removeLayer(id);
    const { grid, mask, lc } = r;
    const meta = `${sceneLabel(r.item)} · ${lc.methodLabel}`;
    if (key === 'index') {
      const prov = lc.sensor === 's1'
        ? pcProvider(indexTileUrl(r.item, sarDbExpression('vv'), [-25, 0], 'greys_r'), r.item)
        : pcProvider(indexTileUrl(r.item, indexExpression(r.item, INDICES.find((d) => d.id === 'ndvi')!), [-0.2, 0.9], 'rdylgn'), r.item);
      g.putImagery(id, lc.sensor === 's1' ? tl('Original layer · SAR VV (dB)', 'ชั้นข้อมูลต้นฉบับ · SAR VV (dB)') : tl('Original layer · NDVI', 'ชั้นข้อมูลต้นฉบับ · NDVI'), prov, { meta, alpha: 0.9 });
      return;
    }
    let url = '';
    let name = '';
    let legend: { items: { color: string; label: string }[]; note?: string };
    if (key === 'lc' || key === 'raw') {
      const cls = key === 'lc' ? lc.refined.cls : lc.cls;
      url = drapeImage(grid, (p) => (mask[p] ? LC_INFO[cls[p] as LC].rgba : null), (p) => !!LC_INFO[cls[p] as LC]?.hatch);
      name = key === 'lc' ? tl('Land cover (after spatial check)', 'สิ่งปกคลุมดิน (หลังตรวจบริบทเชิงพื้นที่)') : tl('Land cover (raw)', 'สิ่งปกคลุมดิน (ผลดิบ)');
      const present = new Set<number>();
      for (let p = 0; p < cls.length; p++) if (mask[p]) present.add(cls[p]);
      legend = {
        items: [...present].sort((a, b) => a - b).map((c) => ({ color: rgbaCss(LC_INFO[c as LC].rgba), label: nameOf(LC_INFO[c as LC]) })),
        note: lc.status === 'provisional' ? tl('Provisional — not validated against reference data.', 'ผลเบื้องต้น · ยังไม่ผ่านการตรวจสอบกับข้อมูลอ้างอิง') : tl('Model checked on held-out reference samples (see accuracy).', 'โมเดลผ่านการทดสอบกับตัวอย่างอ้างอิงที่แยกไว้ (ดูความถูกต้อง)'),
      };
    } else if (key === 'conf') {
      url = drapeImage(grid, (p) => (mask[p] ? CONF_INFO[lc.refined.level[p] as Conf].rgba : null));
      name = tl('Confidence map', 'แผนที่ความเชื่อมั่น');
      legend = { items: [Conf.High, Conf.Medium, Conf.Low, Conf.Unknown].map((c) => ({ color: rgbaCss(CONF_INFO[c].rgba), label: nameOf(CONF_INFO[c]) })), note: tl('Agreement of the evidence, not accuracy.', 'ความสอดคล้องของหลักฐาน ไม่ใช่ความถูกต้อง') };
    } else if (key === 'uncertain') {
      const f = lc.refined.flags;
      url = drapeImage(grid, (p) => {
        if (!mask[p]) return null;
        const c = lc.refined.cls[p];
        if (c === LC.Cloud || c === LC.CloudShadow) return null;
        if (c === LC.Unknown) return [150, 150, 150, 200];
        if (f[p] & (FLAG.isolatedWater | FLAG.vegInWater | FLAG.anomaly)) return [236, 92, 210, 220];
        if (lc.refined.level[p] <= Conf.Low) return [232, 120, 60, 210];
        return null;
      });
      name = tl('Uncertain pixels', 'พิกเซลที่ไม่แน่นอน');
      legend = { items: [
        { color: 'rgba(150,150,150,0.8)', label: tl('Unknown / not classified', 'ระบุไม่ได้') },
        { color: 'rgba(232,120,60,0.85)', label: tl('Low confidence', 'ความเชื่อมั่นต่ำ') },
        { color: 'rgba(236,92,210,0.85)', label: tl('Spatial check flag (isolated water, vegetation in water, odd pixel)', 'ถูกตั้งข้อสังเกตจากบริบท (น้ำโดดเดี่ยว พืชกลางน้ำ พิกเซลผิดแปลก)') },
      ] };
    } else {
      url = drapeImage(grid, (p) => {
        if (!mask[p]) return null;
        const q = lc.qa[p] as QA;
        return q === QA.Clear || q === QA.ClearWaterHint ? null : QA_INFO[q]?.rgba ?? null;
      });
      name = tl('Cloud / shadow / quality mask', 'หน้ากากเมฆ / เงา / คุณภาพข้อมูล');
      const present = new Set<number>();
      for (let p = 0; p < lc.qa.length; p++) if (mask[p] && lc.qa[p] !== QA.Clear && lc.qa[p] !== QA.ClearWaterHint) present.add(lc.qa[p]);
      legend = { items: [...present].map((q) => ({ color: rgbaCss(QA_INFO[q as QA].rgba), label: nameOf(QA_INFO[q as QA]) })) };
    }
    const prov = await imageProvider(url, grid.west, grid.south, grid.east, grid.north);
    g.putImagery(id, name, prov, { meta, legend });
  };

  const toggle = (k: LayerKey) => {
    if (!run) return;
    const on = !shown[k];
    setShown((s) => ({ ...s, [k]: on }));
    void draw(k, run, on);
  };

  // ------------------------------------------------------------ run
  const classify = async () => {
    if (!aoi || !scene) return;
    setErr('');
    setAcc(null);
    if (!sensor) return setErr(tl('Classification needs a Sentinel-2, Landsat 8/9 or Sentinel-1 RTC scene.', 'การจำแนกต้องใช้ภาพ Sentinel-2, Landsat 8/9 หรือ Sentinel-1 RTC'));
    if (method === 'model' && !model) return setErr(tl('No trained model for this sensor yet — train one below or use the rule-based mode.', 'ยังไม่มีโมเดลที่ฝึกแล้วสำหรับเซนเซอร์นี้ · ฝึกโมเดลด้านล่าง หรือใช้โหมดกฎ'));
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    try {
      const grid = gridFor(aoi.geometry, 768, 16);
      const stack = await fetchStack(scene, grid, ac.signal, (name, d, n) => setBusy(`${tl('Reading original bands', 'กำลังอ่านแบนด์ต้นฉบับ')} ${name} (${d}/${n})`));
      let wc: Float32Array | null = null;
      if (useCtx && sensor !== 's1' && method === 'rules') {
        setBusy(tl('Reading ESA WorldCover 2021 context…', 'กำลังอ่านข้อมูลบริบท ESA WorldCover 2021…'));
        wc = await fetchWorldCover(aoi.geometry, grid, ac.signal).catch(() => null);
      }
      setBusy(tl('Classifying…', 'กำลังจำแนก…'));
      await new Promise((r) => setTimeout(r, 0));
      const mask = polygonMask(grid, aoi.geometry);
      const lc = classifyStack(stack, { method, model, worldCover: wc, mask });
      const rowArea = rowAreasKm2(grid);
      const r: Run = {
        item: scene, grid, mask, rowArea, stack, lc, worldCover: !!wc,
        sumRaw: summarize(lc.cls, lc.level, lc.qa, grid.width, mask, rowArea),
        sumRef: summarize(lc.refined.cls, lc.refined.level, lc.qa, grid.width, mask, rowArea),
      };
      setRun(r);
      for (const k of Object.keys(shown) as LayerKey[]) await draw(k, r, shown[k]);
      g.putReport({
        id: 'landcover',
        title: `Land-cover classification — ${sceneLabel(scene)}`,
        lines: [
          `Method: ${lc.methodLabel}${wc ? ' + ESA WorldCover 2021 context (cropland / built-up / wetland)' : ''}`,
          `Status: ${lc.status === 'provisional' ? 'PROVISIONAL — not validated against reference data' : 'model evaluated on held-out reference samples'}`,
          `Scene: ${scene.id} · acquired ${scene.datetime}`,
          `Pixel ≈ ${pixelSizeM(grid).toFixed(1)} m (analysis grid, zoom ${grid.z})`,
          ...SURFACE_CLASSES.map((c) => `${LC_INFO[c].en}: ${r.sumRef.perClassKm2[c].toFixed(3)} km² (${(r.sumRef.perClassKm2[c] * 625).toFixed(1)} rai)`),
          `Classified: ${r.sumRef.classifiedKm2.toFixed(3)} km² · Unknown: ${r.sumRef.unknownKm2.toFixed(3)} km² · Cloud/shadow: ${r.sumRef.cloudShadowKm2.toFixed(3)} km² of ${r.sumRef.aoiKm2.toFixed(3)} km²`,
          `Low-confidence pixels: ${r.sumRef.lowConfidencePixels}`,
          'Confidence = agreement of the evidence / model vote share; it is not accuracy.',
        ],
      });
    } catch (e: any) {
      if (e.name !== 'AbortError') setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  // ------------------------------------------------------------ reference samples, accuracy, training
  const loadSamples = async (f?: File) => {
    if (!f) return;
    setErr('');
    try {
      const p = parseSamples(JSON.parse(await f.text()));
      setSamples({ ...p, name: f.name });
    } catch (e: any) {
      setErr(`${tl('Could not read the sample file', 'อ่านไฟล์ตัวอย่างไม่ได้')}: ${e.message}`);
    }
  };

  const refPixels = () => {
    if (!run || !samples) return [];
    return samplePixels(run.grid, samples.features).filter((s) => run.mask[s.p] && qaValid(run.lc.qa[s.p]) && SURFACE_CLASSES.includes(s.cls));
  };

  const assessMap = () => {
    if (!run) return;
    const px = refPixels();
    if (px.length < 10) return setErr(tl('Too few reference pixels inside the AOI with usable data (need ≥ 10).', 'ตัวอย่างอ้างอิงที่อยู่ใน AOI และมีข้อมูลใช้ได้น้อยเกินไป (ต้องมีอย่างน้อย 10 พิกเซล)'));
    const ref = px.map((s) => s.cls);
    const pred = px.map((s) => run.lc.refined.cls[s.p]);
    const classes = [...new Set([...ref, ...pred])].sort((a, b) => a - b);
    setAcc({
      title: tl('Accuracy of the current map against your reference samples', 'ความถูกต้องของแผนที่นี้เทียบกับตัวอย่างอ้างอิงของคุณ'),
      a: assess(ref, pred, classes),
      note: tl(
        'All samples are used as reference. Valid only if the samples are independent ground truth (field survey or verified very-high-resolution imagery) and were not used to tune the rules.',
        'ใช้ตัวอย่างทั้งหมดเป็นข้อมูลอ้างอิง · ผลนี้เชื่อถือได้ก็ต่อเมื่อตัวอย่างเป็นข้อมูลจริงที่เป็นอิสระ (สำรวจภาคสนาม หรือแปลจากภาพความละเอียดสูงมากที่ตรวจแล้ว) และไม่ได้ใช้ปรับเกณฑ์',
      ),
      warnings: pred.includes(LC.Unknown) ? [tl('“Unknown” predictions are counted as errors here — they are honest, but they lower overall accuracy.', 'ผล “ระบุไม่ได้” ถูกนับเป็นความคลาดเคลื่อน · เป็นผลที่ตรงไปตรงมาแต่ทำให้ค่าความถูกต้องรวมลดลง')] : [],
    });
  };

  const train = () => {
    if (!run || !samples) return;
    setErr('');
    const names = featuresFor(run.stack.sensor).filter((k) => run.stack.data[k]) as FeatureName[];
    const px = refPixels().map((s) => ({ ...s, x: featureVector(run.stack, s.p, names) })).filter((s) => s.x.some(Number.isFinite));
    const classes = new Set(px.map((s) => s.cls));
    if (px.length < 30 || classes.size < 2) return setErr(tl('Training needs at least 30 usable reference pixels in at least two classes.', 'การฝึกโมเดลต้องมีพิกเซลอ้างอิงที่ใช้ได้อย่างน้อย 30 พิกเซล และอย่างน้อย 2 ประเภท'));
    const fixed = px.some((s) => s.split);
    const split = fixed
      ? { train: px.filter((s) => s.split !== 'validation'), val: px.filter((s) => s.split === 'validation'), warnings: [] as string[] }
      : spatialSplit(px, 0.3, 11);
    if (!split.train.length) return setErr(tl('No training samples left after the split.', 'ไม่มีตัวอย่างสำหรับฝึกเหลือหลังแบ่งชุดข้อมูล'));
    const perClass: Record<number, number> = {};
    split.train.forEach((s) => (perClass[s.cls] = (perClass[s.cls] ?? 0) + 1));
    const forest = trainForest(split.train.map((s) => s.x), split.train.map((s) => s.cls), {
      id: `rf_${Date.now().toString(36)}`,
      name: `${samples.name.replace(/\.[^.]+$/, '')} · ${run.item.datetime.slice(0, 10)}`,
      sensor: run.stack.sensor,
      features: names,
      createdAt: new Date().toISOString(),
      training: { samples: split.train.length, groups: new Set(split.train.map((s) => s.group)).size, perClass, sceneIds: [run.item.id] },
      validation: null,
    });
    let a: Assessment | null = null;
    const vClasses = new Set(split.val.map((s) => s.cls));
    if (split.val.length >= 20 && vClasses.size >= 2) {
      const pred = split.val.map((s) => predict(forest, s.x).cls);
      a = assess(split.val.map((s) => s.cls), pred);
      forest.meta.validation = {
        samples: split.val.length,
        groups: new Set(split.val.map((s) => s.group)).size,
        overallAccuracy: a.overallAccuracy,
        kappa: a.kappa,
        method: fixed ? 'validation features marked in the sample file' : 'held-out sample groups (spatial split by feature / ~1 km block)',
      };
    }
    const e = saveModel(forest);
    if (e) setErr(`${tl('Model trained but not saved in this browser', 'ฝึกโมเดลแล้วแต่บันทึกในเบราว์เซอร์ไม่ได้')}: ${e}`);
    setModels(listModels());
    setModelId(forest.meta.id);
    if (a)
      setAcc({
        title: tl('Model accuracy on held-out reference samples', 'ความถูกต้องของโมเดลกับตัวอย่างอ้างอิงที่แยกไว้'),
        a,
        note: tl(
          'Validation pixels come from different sample features / ~1 km blocks than the training pixels, so neighbouring pixels are not on both sides. The numbers describe agreement with YOUR samples; they are field accuracy only if the samples are ground truth.',
          'พิกเซลทดสอบมาจากตัวอย่าง / บล็อกพื้นที่ ~1 กม. คนละชุดกับพิกเซลที่ใช้ฝึก พิกเซลข้างเคียงจึงไม่อยู่ทั้งสองชุด · ตัวเลขนี้บอกความสอดคล้องกับตัวอย่างของคุณ และจะเป็นความถูกต้องภาคสนามได้ก็ต่อเมื่อตัวอย่างเป็นข้อมูลจริง',
        ),
        warnings: split.warnings,
      });
    else
      setAcc(null), setErr(tl('Model trained, but there were too few independent validation samples (≥ 20 in ≥ 2 classes) — it is saved as NOT validated.', 'ฝึกโมเดลแล้ว แต่ตัวอย่างทดสอบที่เป็นอิสระมีน้อยเกินไป (ต้องมี ≥ 20 พิกเซล ใน ≥ 2 ประเภท) · บันทึกไว้ในสถานะ “ยังไม่ผ่านการตรวจสอบ”'));
    setMethod('model');
  };

  const importModel = async (f?: File) => {
    if (!f) return;
    try {
      const m = parseForest(await f.text());
      saveModel(m);
      setModels(listModels());
      setModelId(m.meta.id);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const s = run?.sumRef;
  const classRows = useMemo(() => (s ? SURFACE_CLASSES.filter((c) => s.perClassKm2[c] > 0) : []), [s]);

  return (
    <div className="space-y-3">
      <Notice>
        {tl(
          'Classifies each pixel only when several bands and indices agree. Pixels that fail quality control (cloud, shadow, haze, saturation, no data) and pixels with conflicting evidence stay Unknown — the map is not forced to be complete.',
          'จำแนกแต่ละพิกเซลเมื่อหลายแบนด์และหลายดัชนีให้ผลสอดคล้องกันเท่านั้น · พิกเซลที่ไม่ผ่านการตรวจคุณภาพ (เมฆ เงา หมอก ค่าอิ่มตัว ไม่มีข้อมูล) และพิกเซลที่หลักฐานขัดแย้งกันจะคงเป็น “ระบุไม่ได้” · ระบบไม่บังคับจำแนกทุกพิกเซล',
        )}
      </Notice>

      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          {(['A', 'B'] as const).map((k) => (
            <Button key={k} variant={which === k ? 'active' : 'ghost'} onClick={() => setWhich(k)} disabled={!(k === 'A' ? g.sceneA : g.sceneB)}>
              {tl('Scene', 'ภาพ')} {k}
            </Button>
          ))}
          <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300" title={sceneLabel(scene)}>{sceneLabel(scene)}</span>
        </div>
        <div className="grid grid-cols-2 gap-1">
          <Button variant={method === 'rules' ? 'active' : 'ghost'} onClick={() => setMethod('rules')}>{tl('Rule-based (provisional)', 'ใช้กฎหลายดัชนี (เบื้องต้น)')}</Button>
          <Button variant={method === 'model' ? 'active' : 'ghost'} onClick={() => setMethod('model')} disabled={!usableModels.length} title={usableModels.length ? '' : tl('Train or import a model for this sensor first', 'ต้องฝึกหรือนำเข้าโมเดลของเซนเซอร์นี้ก่อน')}>
            {tl('Trained model (RF)', 'โมเดลที่ฝึกแล้ว (RF)')}
          </Button>
        </div>
        {method === 'model' && usableModels.length > 0 && (
          <Select value={model?.meta.id ?? ''} onChange={(e) => setModelId(e.target.value)}>
            {usableModels.map((m) => (
              <option key={m.meta.id} value={m.meta.id}>
                {m.meta.name} · {m.meta.validation ? `OA ${(m.meta.validation.overallAccuracy * 100).toFixed(0)}% (${tl('samples', 'ตัวอย่าง')})` : tl('not validated', 'ยังไม่ตรวจสอบ')}
              </option>
            ))}
          </Select>
        )}
        {method === 'rules' && sensor !== 's1' && (
          <label className="flex items-start gap-2 text-[11px] text-slate-300">
            <input type="checkbox" className="mt-0.5" checked={useCtx} onChange={(e) => setUseCtx(e.target.checked)} />
            <span>{tl('Use ESA WorldCover 2021 as context (separates cropland from natural vegetation and helps built-up vs bare soil; never overrides strong spectral evidence)', 'ใช้ ESA WorldCover 2021 เป็นข้อมูลบริบท (ช่วยแยกพื้นที่เกษตรออกจากพืชพรรณธรรมชาติ และช่วยแยกสิ่งปลูกสร้างกับดินเปล่า โดยไม่ลบล้างหลักฐานเชิงสเปกตรัมที่ชัดเจน)')}</span>
          </label>
        )}
        {sensor === 's1' && <p className="text-[10px] leading-snug text-muted">{tl('Sentinel-1: radar feature set (VV, VH, VV−VH). Optical indices are not used. Radar separates open water and strong scatterers; other surfaces mostly stay Unknown.', 'Sentinel-1: ใช้ชุดข้อมูลเรดาร์ (VV, VH, VV−VH) ไม่ใช้ดัชนีของภาพออปติคัล · เรดาร์แยกแหล่งน้ำเปิดและวัตถุสะท้อนแรงได้ดี พื้นผิวอื่นส่วนใหญ่จะคงเป็น “ระบุไม่ได้”')}</p>}
        <div className="flex gap-1.5">
          <Button variant="primary" onClick={classify} disabled={!aoi || !scene || !!busy}>{tl('Classify land cover', 'จำแนกสิ่งปกคลุมดิน')}</Button>
          {busy && <Button variant="danger" onClick={() => abort.current?.abort()}>{tl('Cancel', 'ยกเลิก')}</Button>}
        </div>
        {!aoi && <p className="text-[11px] text-muted">{tl('Draw or choose an AOI first (AOI tab or the ▭ tool).', 'วาดหรือเลือกพื้นที่ AOI ก่อน (แท็บ AOI หรือเครื่องมือ ▭)')}</p>}
        {aoi && !scene && <p className="text-[11px] text-muted">{tl('Pick a scene in “Images used for analysis” above.', 'เลือกภาพในหัวข้อ “ภาพที่ใช้วิเคราะห์” ด้านบน')}</p>}
        {busy && <div className="ov-progress flex items-center gap-2 text-xs text-muted"><Spinner /> {busy}</div>}
        {err && <Notice tone="bad">{err}</Notice>}
      </div>

      {run && s && (
        <div className="ov-enter space-y-2 rounded border border-line p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {run.lc.status === 'provisional'
              ? <Badge tone="warn">{tl('Provisional · not validated', 'ผลเบื้องต้น · ยังไม่ผ่านการตรวจสอบ')}</Badge>
              : <Badge tone="ok">{tl('Model checked on samples', 'โมเดลผ่านการทดสอบกับตัวอย่าง')}</Badge>}
            <Badge>{run.lc.sensor.toUpperCase()}</Badge>
            <span className="font-mono text-[10px] text-muted">{run.item.datetime.slice(0, 10)} · ≈{pixelSizeM(run.grid).toFixed(0)} m</span>
          </div>

          <div>
            <div className="label mb-1">{tl('Area by class', 'พื้นที่แต่ละประเภท')}</div>
            <table className="w-full text-[11px]">
              <tbody>
                {classRows.map((c) => (
                  <tr key={c} className="border-b border-white/5">
                    <td className="py-0.5 pr-1"><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: rgbaCss(LC_INFO[c].rgba) }} />{nameOf(LC_INFO[c])}</td>
                    <td className="py-0.5 text-right font-mono text-slate-200">{area(s.perClassKm2[c])}</td>
                    <td className="w-12 py-0.5 text-right font-mono text-muted">{pct(s.perClassKm2[c], s.aoiKm2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ClassBar s={s} />
          </div>

          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <Stat k={tl('Classified', 'จำแนกได้')} v={area(s.classifiedKm2)} sub={pct(s.classifiedKm2, s.aoiKm2)} />
            <Stat k={tl('Unknown (not classified)', 'ระบุไม่ได้ (ไม่จำแนก)')} v={area(s.unknownKm2)} sub={pct(s.unknownKm2, s.aoiKm2)} tone={s.unknownKm2 > 0.2 * s.aoiKm2 ? 'warn' : undefined} />
            <Stat k={tl('Cloud / shadow', 'เมฆ / เงาเมฆ')} v={area(s.cloudShadowKm2)} sub={pct(s.cloudShadowKm2, s.aoiKm2)} />
            <Stat k={tl('Low-confidence pixels', 'พิกเซลความเชื่อมั่นต่ำ')} v={s.lowConfidencePixels.toLocaleString()} sub={pct(s.lowConfidencePixels, s.pixels)} />
            <Stat k={tl('Source data quality (QC-passed)', 'คุณภาพข้อมูลต้นทาง (ผ่านการตรวจ)')} v={pct(s.aoiKm2 - s.invalidKm2, s.aoiKm2)} tone={s.invalidKm2 > 0.3 * s.aoiKm2 ? 'warn' : undefined} />
            <Stat k={tl('Spatial checks', 'การตรวจเชิงพื้นที่')} v={`${run.lc.refined.counts.isolatedWater + run.lc.refined.counts.vegInWater + run.lc.refined.counts.anomaly} ${tl('flags', 'จุด')}`} sub={`${run.lc.refined.counts.smoothed} ${tl('smoothed', 'ปรับเรียบ')}`} />
          </dl>
          {s.invalidKm2 > 0.3 * s.aoiKm2 && <Notice tone="warn">{tl('More than 30% of the AOI failed quality control — choose a clearer scene before drawing conclusions.', 'พื้นที่ AOI มากกว่า 30% ไม่ผ่านการตรวจคุณภาพ · ควรเลือกภาพที่ชัดกว่านี้ก่อนสรุปผล')}</Notice>}

          <div>
            <div className="label mb-1">{tl('Map layers', 'ชั้นข้อมูลบนแผนที่')}</div>
            <div className="grid grid-cols-2 gap-1">
              {([
                ['lc', tl('Land cover', 'สิ่งปกคลุมดิน')],
                ['raw', tl('Raw (before spatial check)', 'ผลดิบ (ก่อนตรวจบริบท)')],
                ['conf', tl('Confidence', 'ความเชื่อมั่น')],
                ['uncertain', tl('Uncertain pixels', 'พิกเซลไม่แน่นอน')],
                ['qa', tl('Cloud / shadow mask', 'หน้ากากเมฆ / เงา')],
                ['index', run.lc.sensor === 's1' ? 'SAR VV' : tl('Original NDVI', 'NDVI ต้นฉบับ')],
              ] as [LayerKey, string][]).map(([k, label]) => (
                <Button key={k} variant={shown[k] ? 'active' : 'ghost'} onClick={() => toggle(k)} aria-pressed={shown[k]}>{label}</Button>
              ))}
            </div>
          </div>

          <p className="text-[10px] leading-snug text-muted">
            {tl('Confidence shows how well the evidence agrees (or the model vote share). It is not accuracy. Areas: ellipsoidal pixel areas on the analysis grid, values from 8-bit tiles of server-side band math.', 'ความเชื่อมั่นแสดงว่าหลักฐานสอดคล้องกันมากเพียงใด (หรือสัดส่วนเสียงโหวตของโมเดล) ไม่ใช่ความถูกต้อง · พื้นที่คำนวณจากขนาดพิกเซลบนทรงรีของกริดวิเคราะห์ ค่ามาจากไทล์ 8 บิตของการคำนวณแบนด์บนเซิร์ฟเวอร์')}
          </p>
          <Button onClick={() => downloadJson('land-cover-summary.geojson', {
            type: 'Feature', geometry: aoi!.geometry,
            properties: {
              scene: run.item.id, acquired: run.item.datetime, sensor: run.lc.sensor, method: run.lc.methodLabel, status: run.lc.status,
              worldCoverContext: run.worldCover, processedAt: new Date().toISOString(),
              areaKm2: Object.fromEntries(Object.entries(s.perClassKm2).filter(([, v]) => v > 0).map(([k, v]) => [LC_INFO[+k as LC].en, +v.toFixed(5)])),
              areaRai: Object.fromEntries(Object.entries(s.perClassKm2).filter(([, v]) => v > 0).map(([k, v]) => [LC_INFO[+k as LC].en, +(v * 625).toFixed(2)])),
              classifiedKm2: s.classifiedKm2, unknownKm2: s.unknownKm2, cloudShadowKm2: s.cloudShadowKm2, lowConfidencePixels: s.lowConfidencePixels,
              rawAreaKm2: Object.fromEntries(Object.entries(run.sumRaw.perClassKm2).filter(([, v]) => v > 0).map(([k, v]) => [LC_INFO[+k as LC].en, +v.toFixed(5)])),
              note: 'Confidence is evidence agreement / model vote share, not accuracy. Provisional unless validated with independent reference data.',
              rasterBounds: [run.grid.west, run.grid.south, run.grid.east, run.grid.north],
            },
          })}>{tl('Export GeoJSON summary', 'ส่งออกสรุป GeoJSON')}</Button>
        </div>
      )}

      <details className="rounded border border-line p-2">
        <summary className="label cursor-pointer">{tl('Reference samples, accuracy & model training', 'ตัวอย่างอ้างอิง ความถูกต้อง และการฝึกโมเดล')}</summary>
        <div className="mt-2 space-y-2">
          <p className="text-[10px] leading-snug text-muted">
            {tl('Import a GeoJSON of points or polygons with a “class” property (water, vegetation, forest, agriculture, bare soil, built-up, wetland — English or Thai). Optional “split”: train / validation. Only use samples you have verified (field survey or very-high-resolution imagery).', 'นำเข้า GeoJSON ที่เป็นจุดหรือรูปปิด พร้อมคุณสมบัติ “class” (เช่น water / น้ำ, vegetation / พืชพรรณ, forest / ป่าทึบ, agriculture / เกษตร, bare soil / ดินเปล่า, built-up / สิ่งปลูกสร้าง, wetland / ชุ่มน้ำ) ใส่ “split” เป็น train หรือ validation ได้ · ใช้เฉพาะตัวอย่างที่ตรวจสอบแล้ว (สำรวจภาคสนาม หรือแปลจากภาพความละเอียดสูงมาก)')}
          </p>
          <div className="flex flex-wrap gap-1">
            <Button onClick={() => fileRef.current?.click()}>{tl('Import samples (GeoJSON)', 'นำเข้าตัวอย่าง (GeoJSON)')}</Button>
            <input ref={fileRef} type="file" accept=".geojson,.json" className="hidden" onChange={(e) => loadSamples(e.target.files?.[0])} />
            <Button onClick={assessMap} disabled={!run || !samples}>{tl('Assess current map', 'ประเมินแผนที่ปัจจุบัน')}</Button>
            <Button variant="primary" onClick={train} disabled={!run || !samples}>{tl('Train Random Forest', 'ฝึก Random Forest')}</Button>
          </div>
          {samples && (
            <div className="text-[11px] text-slate-300">
              {samples.name}: {samples.features.length} {tl('features', 'รายการ')} · {Object.entries(samples.perClass).map(([c, n]) => `${nameOf(LC_INFO[+c as LC])} ${n}`).join(' · ')}
              {samples.skipped.length > 0 && <div className="text-warn">{tl('Skipped', 'ข้าม')} {samples.skipped.length}: {samples.skipped.slice(0, 3).map((x) => `#${x.index} ${x.reason}`).join('; ')}</div>}
            </div>
          )}
          {!run && samples && <p className="text-[10px] text-muted">{tl('Run a classification on the scene first — training reads the same bands.', 'จำแนกภาพก่อน · การฝึกโมเดลใช้แบนด์ชุดเดียวกัน')}</p>}
          {acc && <AccuracyView {...acc} />}
          <div>
            <div className="label mb-1">{tl('Saved models (this browser)', 'โมเดลที่บันทึกไว้ (ในเบราว์เซอร์นี้)')}</div>
            {models.length === 0 && <p className="text-[10px] text-muted">{tl('None. No pre-trained model is shipped — there is no verified training data in the app.', 'ยังไม่มี · ระบบไม่ได้แถมโมเดลสำเร็จรูป เพราะยังไม่มีชุดข้อมูลฝึกที่ผ่านการตรวจสอบ')}</p>}
            <ul className="space-y-1">
              {models.map((m) => (
                <li key={m.meta.id} className="rounded border border-line px-2 py-1 text-[11px]">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-slate-200" title={m.meta.name}>{m.meta.name}</span>
                    <Badge>{m.meta.sensor}</Badge>
                    {m.meta.validation ? <Badge tone="ok">OA {(m.meta.validation.overallAccuracy * 100).toFixed(0)}%</Badge> : <Badge tone="warn">{tl('not validated', 'ยังไม่ตรวจสอบ')}</Badge>}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-muted">
                    {m.meta.training.samples} {tl('training px', 'พิกเซลฝึก')} / {m.meta.training.groups} {tl('groups', 'กลุ่ม')} · {m.meta.features.length} {tl('features', 'ตัวแปร')} · {m.meta.createdAt.slice(0, 10)}
                  </div>
                  <div className="mt-1 flex gap-1">
                    <Button onClick={() => downloadModel(m)}>{tl('Export', 'ส่งออก')}</Button>
                    <Button variant="danger" onClick={() => { if (confirm(tl('Delete this model?', 'ลบโมเดลนี้?'))) { deleteModel(m.meta.id); setModels(listModels()); } }}>{tl('Delete', 'ลบ')}</Button>
                  </div>
                </li>
              ))}
            </ul>
            <Button className="mt-1" onClick={() => modelFileRef.current?.click()}>{tl('Import model (JSON)', 'นำเข้าโมเดล (JSON)')}</Button>
            <input ref={modelFileRef} type="file" accept=".json" className="hidden" onChange={(e) => importModel(e.target.files?.[0])} />
          </div>
          <p className="text-[10px] leading-snug text-muted">{tl('Model probabilities are not calibrated; with enough independent validation data they should be calibrated before being read as probabilities.', 'ค่าความน่าจะเป็นของโมเดลยังไม่ได้ปรับเทียบ (calibration) · เมื่อมีข้อมูลทดสอบอิสระเพียงพอ ควรปรับเทียบก่อนนำไปตีความเป็นความน่าจะเป็น')}</p>
        </div>
      </details>
    </div>
  );
}

function Stat({ k, v, sub, tone }: { k: string; v: string; sub?: string; tone?: 'warn' }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-muted" title={k}>{k}</dt>
      <dd className={cx('font-mono text-[11px]', tone === 'warn' ? 'text-warn' : 'text-slate-100')}>{v}{sub && <span className="ml-1 text-muted">{sub}</span>}</dd>
    </div>
  );
}

function ClassBar({ s }: { s: Summary }) {
  const parts: [string, number][] = [
    ...SURFACE_CLASSES.map((c) => [rgbaCss(LC_INFO[c].rgba), s.perClassKm2[c]] as [string, number]),
    ['rgba(235,238,240,0.6)', s.cloudShadowKm2],
    ['repeating-linear-gradient(45deg,#777 0 3px,transparent 3px 6px)', s.unknownKm2],
  ];
  return (
    <div className="mt-1.5 flex h-2 overflow-hidden rounded-sm bg-ink-950" aria-hidden>
      {parts.filter(([, v]) => v > 0).map(([c, v], i) => <span key={i} className="ov-grow-x h-full" style={{ width: `${(100 * v) / Math.max(s.aoiKm2, 1e-12)}%`, background: c }} />)}
    </div>
  );
}

function AccuracyView({ title, a, note, warnings }: { title: string; a: Assessment; note: string; warnings: string[] }) {
  const f = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
  const nm = (c: number) => nameOf(LC_INFO[c as LC] ?? { en: String(c), th: String(c) });
  return (
    <div className="ov-enter space-y-1.5 rounded border border-cyan-400/30 p-2">
      <div className="text-xs font-semibold text-white">{title}</div>
      <div className="flex flex-wrap gap-3 font-mono text-[11px]">
        <span>{tl('Overall accuracy', 'ความถูกต้องรวม')} <b className="text-cyan-300">{f(a.overallAccuracy)}</b></span>
        <span>Kappa <b className="text-slate-100">{Number.isFinite(a.kappa) ? a.kappa.toFixed(3) : '—'}</b></span>
        <span>n = {a.n}</span>
      </div>
      <div className="overflow-x-auto scroll-thin">
        <table className="text-[10px]">
          <thead>
            <tr><th className="pr-2 text-left text-muted">{tl('Reference ↓ / Predicted →', 'อ้างอิง ↓ / ผลจำแนก →')}</th>{a.classes.map((c) => <th key={c} className="px-1 text-right font-normal text-muted" title={nm(c)}>{nm(c).slice(0, 8)}</th>)}</tr>
          </thead>
          <tbody>
            {a.matrix.map((row, i) => (
              <tr key={i}>
                <td className="pr-2 text-slate-300">{nm(a.classes[i])}</td>
                {row.map((v, j) => <td key={j} className={cx('px-1 text-right font-mono', i === j ? 'text-cyan-300' : v ? 'text-warn' : 'text-muted')}>{v}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <table className="w-full text-[10px]">
        <thead><tr className="text-muted"><th className="text-left font-normal">{tl('Class', 'ประเภท')}</th><th className="text-right font-normal" title={tl("Producer's accuracy = recall", 'Producer’s accuracy = recall')}>PA</th><th className="text-right font-normal" title={tl("User's accuracy = precision", 'User’s accuracy = precision')}>UA</th><th className="text-right font-normal">F1</th><th className="text-right font-normal">IoU</th></tr></thead>
        <tbody>
          {a.perClass.filter((c) => c.reference > 0).map((c) => (
            <tr key={c.cls} className="border-t border-white/5 font-mono"><td className="font-sans text-slate-300">{nm(c.cls)}</td><td className="text-right">{f(c.producers)}</td><td className="text-right">{f(c.users)}</td><td className="text-right">{f(c.f1)}</td><td className="text-right">{f(c.iou)}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] leading-snug text-muted">{note}</p>
      {warnings.map((w) => <p key={w} className="text-[10px] text-warn">• {w}</p>)}
    </div>
  );
}
