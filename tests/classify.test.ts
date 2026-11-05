// UNIT TESTS of formulas and decision logic.
//
// These use textbook surface-reflectance signatures (REFERENCE_SIGNATURES) and synthetic grids. They check
// that the rules behave as designed — they are NOT an accuracy assessment of the classifier. Accuracy can
// only be measured with real imagery and independent reference (ground-truth) samples; see accuracy.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conf, LC, QA } from '../src/lib/classify/types';
import { deriveIndices, REFERENCE_SIGNATURES as SIG, mndwi, ndvi, aweiNsh } from '../src/lib/classify/features';
import { classifyOptical, classifySar, PROFILE_LANDSAT, PROFILE_S2 } from '../src/lib/classify/rules';
import { decodeLandsatQa, decodeScl, decodeSar, dilateCloud } from '../src/lib/classify/qa';
import { otsu } from '../src/lib/classify/otsu';
import { components, refine, FLAG } from '../src/lib/classify/spatial';
import { predict, trainForest, serializeForest, parseForest, rng } from '../src/lib/classify/rf';
import { assess, spatialSplit } from '../src/lib/classify/accuracy';
import { floodPair, FC, WS, waterMap } from '../src/lib/classify/flood';
import { classChange, CC, compatibility } from '../src/lib/classify/classChange';
import { parseClass, parseSamples } from '../src/lib/classify/training';
import { classifyStack, summarize } from '../src/lib/classify/run';
import type { Stack } from '../src/lib/classify/stack';

const px = (s: keyof typeof SIG, extra: object = {}) => deriveIndices({ ...SIG[s], ...extra });
const cls = (s: keyof typeof SIG, q = QA.Clear, p = PROFILE_S2, ctx = {}) => classifyOptical(px(s), q, p, ctx, true);

// ---------------------------------------------------------------- formulas
test('index formulas match their published definitions', () => {
  assert.ok(Math.abs(ndvi(0.4, 0.1) - 0.6) < 1e-9);
  assert.ok(Math.abs(mndwi(0.07, 0.01) - 0.75) < 1e-9);
  assert.ok(Math.abs(aweiNsh(0.07, 0.01, 0.02, 0.005) - (4 * 0.06 - (0.005 + 0.01375))) < 1e-9);
  assert.ok(Number.isNaN(ndvi(0, 0)), 'division by zero is NaN, not 0');
});

// ---------------------------------------------------------------- test cases 1–9 (rule logic)
test('case 1: large water body (clear water) → Open water, high confidence', () => {
  const r = cls('clearWater');
  assert.equal(r.cls, LC.Water);
  assert.equal(r.level, Conf.High);
});

test('case 2: river / canal (turbid water) → Open water', () => {
  const r = cls('turbidWater');
  assert.equal(r.cls, LC.Water);
  assert.ok(r.level >= Conf.Medium);
});

test('case 3: agricultural land → vegetation spectrally; Agriculture only with cropland context', () => {
  const r = cls('cropGreen');
  assert.ok(r.cls === LC.Vegetation || r.cls === LC.DenseVegetation, `got ${LC[r.cls]}`);
  const c = cls('cropGreen', QA.Clear, PROFILE_S2, { worldCover: 40 });
  assert.equal(c.cls, LC.Agriculture);
  assert.ok(c.level <= Conf.Medium, 'context-based class is never High');
});

test('case 4: dense forest → Dense vegetation (not water, not bare)', () => {
  const r = cls('denseForest');
  assert.equal(r.cls, LC.DenseVegetation);
  assert.equal(r.level, Conf.High);
});

test('case 5: urban → Built-up; case 6: bare soil → Bare soil (visible slope separates them)', () => {
  assert.equal(cls('urban').cls, LC.BuiltUp);
  assert.equal(cls('bareSoil').cls, LC.BareSoil);
  assert.equal(cls('bareSoil').level, Conf.High);
});

test('case 7: cloud and cloud shadow from QA are never surface classes', () => {
  assert.equal(cls('clearWater', QA.Cloud).cls, LC.Cloud);
  assert.equal(cls('clearWater', QA.CloudShadow).cls, LC.CloudShadow);
  assert.equal(cls('denseForest', QA.CloudEdge).cls, LC.Cloud);
  assert.equal(cls('denseForest', QA.Saturated).cls, LC.Unknown);
  assert.equal(cls('denseForest', QA.Unclassified).cls, LC.Unknown);
});

test('case 7b: shadow missed by the mask is NOT called water (multi-index guard)', () => {
  const r = cls('cloudShadowOverVeg');
  assert.notEqual(r.cls, LC.Water);
  const t = cls('terrainShadowForest', QA.Dark);
  assert.notEqual(t.cls, LC.Water);
});

test('case 7c: water inside a dark / terrain-shadow area is at most Low confidence', () => {
  const r = cls('clearWater', QA.Dark);
  assert.equal(r.cls, LC.Water);
  assert.equal(r.level, Conf.Low);
});

test('case 8: flooded area — new water between dates is a POSSIBLE flood, uncertain where unclear', () => {
  const pre = Uint8Array.from([WS.notWater, WS.water, WS.water, WS.notWater, WS.invalid, WS.notWater, WS.mixed]);
  const post = Uint8Array.from([WS.water, WS.water, WS.notWater, WS.notWater, WS.water, WS.waterLow, WS.water]);
  assert.deepEqual([...floodPair(pre, post)], [FC.possibleFlood, FC.permanent, FC.receded, FC.dry, FC.uncertain, FC.uncertain, FC.uncertain]);
});

test('case 9: mixed water / vegetation → Wetland with limited confidence (not forced to water or vegetation)', () => {
  const r = cls('mixedWaterVeg');
  assert.equal(r.cls, LC.Wetland);
  assert.ok(r.level <= Conf.Medium);
});

test('Landsat profile has no red edge and still classifies the reference signatures', () => {
  assert.equal(Number.isNaN(PROFILE_LANDSAT.veg.ndre), true);
  assert.equal(classifyOptical(px('clearWater'), QA.Clear, PROFILE_LANDSAT).cls, LC.Water);
  assert.equal(classifyOptical(px('denseForest'), QA.Clear, PROFILE_LANDSAT).cls, LC.DenseVegetation);
});

test('conflicting evidence → Unknown, never a guess', () => {
  // a pixel half-way between urban and bare soil
  const mid = deriveIndices({ blue: 0.11, green: 0.135, red: 0.165, nir: 0.205, swir1: 0.28, swir2: 0.24 });
  const r = classifyOptical(mid, QA.Clear, PROFILE_S2, {}, true);
  assert.ok(r.cls === LC.Unknown || r.level <= Conf.Medium, `${LC[r.cls]} ${Conf[r.level]}`);
  // a pixel with almost no information
  const flat = classifyOptical({ ndvi: 0.2 }, QA.Clear, PROFILE_S2);
  assert.equal(flat.cls, LC.Unknown);
});

test('SAR: water from VV (+VH); noise floor and strong scatterers stay Low; optical indices unused', () => {
  assert.equal(classifySar({ vv: -22, vh: -27 }, QA.Clear).cls, LC.Water);
  assert.equal(classifySar({ vv: -22, vh: -27 }, QA.Clear).level, Conf.High);
  assert.equal(classifySar({ vv: -19, vh: -18 }, QA.Clear).level, Conf.Low, 'VH disagrees');
  assert.equal(classifySar({ vv: -26, vh: -30 }, QA.LowSignal).level, Conf.Low, 'noise floor = possible radar shadow');
  assert.equal(classifySar({ vv: -3, vh: -10 }, QA.Clear).level, Conf.Low);
  assert.equal(classifySar({ vv: -12, vh: -20 }, QA.Clear).cls, LC.Unknown);
  assert.equal(classifySar({ vv: -22, ndvi: 0.9 } as any, QA.Clear).cls, LC.Water, 'ndvi ignored for SAR');
});

// ---------------------------------------------------------------- QA decoding
test('Sentinel-2 SCL decoding', () => {
  assert.equal(decodeScl(0), QA.NoData);
  assert.equal(decodeScl(1), QA.Saturated);
  assert.equal(decodeScl(2), QA.Dark);
  assert.equal(decodeScl(3), QA.CloudShadow);
  assert.equal(decodeScl(4), QA.Clear);
  assert.equal(decodeScl(6), QA.ClearWaterHint);
  assert.equal(decodeScl(7), QA.Unclassified);
  assert.equal(decodeScl(8), QA.Cloud);
  assert.equal(decodeScl(9), QA.Cloud);
  assert.equal(decodeScl(10), QA.Cirrus);
  assert.equal(decodeScl(11), QA.Snow);
});

test('Landsat QA_PIXEL / QA_RADSAT decoding (USGS C2 bit layout)', () => {
  assert.equal(decodeLandsatQa(1), QA.NoData); // fill
  assert.equal(decodeLandsatQa(21824), QA.Clear); // typical clear-land value
  assert.equal(decodeLandsatQa(21952), QA.ClearWaterHint); // clear + water bit
  assert.equal(decodeLandsatQa(22280), QA.Cloud); // bit 3 set
  assert.equal(decodeLandsatQa(23888), QA.CloudShadow); // bit 4 set
  assert.equal(decodeLandsatQa(21826), QA.CloudEdge); // dilated cloud bit 1
  assert.equal(decodeLandsatQa(54596), QA.Cirrus); // bit 2 set
  assert.equal(decodeLandsatQa(21824, 4), QA.Saturated);
});

test('Sentinel-1 noise floor flag', () => {
  assert.equal(decodeSar(-26, -31), QA.LowSignal);
  assert.equal(decodeSar(-20, -26), QA.Clear);
  assert.equal(decodeSar(NaN, -20), QA.NoData);
});

test('cloud dilation marks clear neighbours as cloud edge, never touches no-data', () => {
  const W = 5, H = 3;
  const q = new Uint8Array(W * H).fill(QA.Clear);
  q[7] = QA.Cloud;
  q[0] = QA.NoData;
  const d = dilateCloud(q, W, H, 1);
  assert.equal(d[7], QA.Cloud);
  for (const p of [1, 2, 3, 6, 8, 11, 12, 13]) assert.equal(d[p], QA.CloudEdge, `pixel ${p}`);
  assert.equal(d[0], QA.NoData);
  assert.equal(d[4], QA.Clear);
  assert.equal(q[1], QA.Clear, 'input untouched');
});

// ---------------------------------------------------------------- Otsu
test('Otsu accepts a bimodal histogram and rejects a unimodal one', () => {
  const r = rng(1);
  const bi = [...Array(2000)].map((_, i) => (i % 3 === 0 ? 0.45 : -0.35) + (r() - 0.5) * 0.15);
  const a = otsu(bi, -1, 1);
  assert.equal(a.accepted, true);
  assert.ok(a.threshold > -0.25 && a.threshold < 0.35, `threshold ${a.threshold}`);
  const uni = [...Array(2000)].map(() => -0.3 + (r() + r() + r() - 1.5) * 0.1);
  assert.equal(otsu(uni, -1, 1).accepted, false);
  assert.equal(otsu(bi, -1, 1, { clamp: [0.5, 0.9] }).accepted, false, 'implausible thresholds are rejected');
});

// ---------------------------------------------------------------- spatial context
test('spatial refinement keeps small water bodies and keeps the raw result', () => {
  const W = 7, H = 7;
  const c = new Uint8Array(W * H).fill(LC.DenseVegetation);
  const l = new Uint8Array(W * H).fill(Conf.High);
  c[24] = LC.Water; // one-pixel pond in the middle of forest
  l[24] = Conf.High;
  for (let y = 0; y < H; y++) c[y * W + 6] = LC.Water; // 1-pixel-wide canal along the edge
  const raw = c.slice();
  const r = refine({ width: W, height: H, cls: c, level: l });
  assert.equal(r.cls[24], LC.Water, 'pond is never removed');
  assert.ok(r.flags[24] & FLAG.isolatedWater, 'pond is flagged for checking');
  assert.equal(r.level[24], Conf.Medium, 'its confidence is lowered one step');
  for (let y = 0; y < H; y++) assert.equal(r.cls[y * W + 6], LC.Water, 'canal kept');
  assert.deepEqual([...c], [...raw], 'raw classification not modified');
});

test('majority smoothing only touches Low-confidence non-water pixels and never fills Unknown', () => {
  const W = 3, H = 3;
  const c = new Uint8Array(9).fill(LC.BareSoil);
  const l = new Uint8Array(9).fill(Conf.High);
  c[4] = LC.BuiltUp; l[4] = Conf.Low;
  let r = refine({ width: W, height: H, cls: c, level: l });
  assert.equal(r.cls[4], LC.BareSoil);
  assert.ok(r.flags[4] & FLAG.smoothed);
  c[4] = LC.Unknown; l[4] = Conf.Unknown;
  r = refine({ width: W, height: H, cls: c, level: l });
  assert.equal(r.cls[4], LC.Unknown, 'unknown stays unknown');
  c[4] = LC.Water; l[4] = Conf.Low;
  r = refine({ width: W, height: H, cls: c, level: l });
  assert.equal(r.cls[4], LC.Water, 'water never smoothed away');
});

test('8-connected components', () => {
  const c = Uint8Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const { sizes } = components(c, 3, 3, (v) => v === 1);
  assert.deepEqual(sizes.slice(1), [3], 'diagonal pixels are one component');
});

// ---------------------------------------------------------------- whole-stack run + summary
test('classifyStack + summarize: unknown and cloud areas are reported separately, never as water or vegetation', () => {
  const sigs: (keyof typeof SIG)[] = ['clearWater', 'denseForest', 'bareSoil', 'urban'];
  const W = 4, H = 2, n = W * H;
  const data: any = {};
  for (const k of ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'] as const) data[k] = new Float32Array(n);
  const qa = new Uint8Array(n).fill(QA.Clear);
  for (let p = 0; p < n; p++) for (const k of Object.keys(data)) data[k][p] = (SIG[sigs[p % 4]] as any)[k];
  qa[5] = QA.Cloud;
  qa[6] = QA.NoData;
  const s: Stack = { sensor: 's2', width: W, height: H, data, qa };
  const lc = classifyStack(s);
  assert.equal(lc.cls[0], LC.Water);
  assert.equal(lc.cls[1], LC.DenseVegetation);
  assert.equal(lc.cls[5], LC.Cloud);
  assert.equal(lc.cls[6], LC.Unknown);
  assert.equal(lc.status, 'provisional');
  const sum = summarize(lc.cls, lc.level, lc.qa, W, new Uint8Array(n).fill(1), Float64Array.from([1, 1]));
  assert.equal(sum.aoiKm2, 8);
  assert.equal(sum.cloudShadowKm2, 1);
  assert.equal(sum.unknownKm2, 1);
  assert.equal(sum.classifiedKm2, 6);
  assert.equal(sum.invalidKm2, 2);
});

test('waterMap: QA-failed pixels are invalid, not dry', () => {
  const W = 3, H = 1;
  const data: any = {};
  for (const k of ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'] as const) data[k] = Float32Array.from([SIG.clearWater[k], SIG.denseForest[k], SIG.clearWater[k]]);
  const s: Stack = { sensor: 's2', width: W, height: H, data, qa: Uint8Array.from([QA.Clear, QA.Clear, QA.Cloud]) };
  for (const k of ['ndvi', 'ndwi', 'mndwi', 'awei'] as const) {
    s.data[k] = new Float32Array(3).map((_, i) => (deriveIndices({ blue: data.blue[i], green: data.green[i], red: data.red[i], nir: data.nir[i], swir1: data.swir1[i], swir2: data.swir2[i] }) as any)[k]);
  }
  const m = waterMap(s);
  assert.deepEqual([...m.state], [WS.water, WS.notWater, WS.invalid]);
  assert.equal(m.threshold.used, 'fixed');
});

// ---------------------------------------------------------------- change between classified maps
test('class change: only confident, QC-passed pixels count; seasonal changes are uncertain', () => {
  const A = { cls: Uint8Array.from([LC.DenseVegetation, LC.BareSoil, LC.Vegetation, LC.Water, LC.Unknown, LC.Agriculture]), level: new Uint8Array(6).fill(Conf.High), qa: new Uint8Array(6).fill(QA.Clear) };
  const B = { cls: Uint8Array.from([LC.BareSoil, LC.Water, LC.BuiltUp, LC.Water, LC.Water, LC.BareSoil]), level: new Uint8Array(6).fill(Conf.High), qa: new Uint8Array(6).fill(QA.Clear) };
  B.qa[3] = QA.Cloud;
  assert.deepEqual([...classChange(A, B, { differentSeason: false })], [CC.BareGain, CC.PossibleFlood, CC.BuiltGain, CC.NotCheckable, CC.Uncertain, CC.BareGain]);
  const seasonal = classChange(A, B, { differentSeason: true });
  assert.equal(seasonal[1], CC.Uncertain, 'new water between seasons may be seasonal');
  assert.equal(seasonal[5], CC.Uncertain, 'crop harvest between seasons');
  assert.equal(seasonal[2], CC.BuiltGain, 'new built-up is not seasonal');
  B.level[0] = Conf.Low;
  assert.equal(classChange(A, B, { differentSeason: false })[0], CC.Uncertain);
});

test('compatibility blocks radar vs optical, wrong order and low valid share', () => {
  const a = { sensor: 's2', gsdM: 10, date: '2026-01-10' };
  assert.equal(compatibility(a, { sensor: 's1', gsdM: 10, date: '2026-02-10' }, 1, 1).ok, false);
  assert.equal(compatibility(a, { sensor: 's2', gsdM: 10, date: '2025-12-10' }, 1, 1).ok, false);
  assert.equal(compatibility(a, { sensor: 's2', gsdM: 10, date: '2026-02-10' }, 0.9, 0.4).ok, false);
  const ok = compatibility(a, { sensor: 'landsat', gsdM: 30, date: '2026-07-10' }, 0.9, 0.9);
  assert.equal(ok.ok, true);
  assert.ok(ok.warnings.length >= 3, 'sensor, resolution and season warnings');
});

// ---------------------------------------------------------------- Random Forest (algorithm only)
test('Random Forest learns a separable synthetic problem and round-trips through JSON', () => {
  const r = rng(3);
  const X: number[][] = [], y: number[] = [];
  for (let i = 0; i < 300; i++) {
    const c = i % 3;
    X.push([c + (r() - 0.5) * 0.6, (r() - 0.5) * 3]);
    y.push([LC.Water, LC.Vegetation, LC.BuiltUp][c]);
  }
  const f = trainForest(X, y, { id: 't', name: 'synthetic', sensor: 's2', features: ['ndvi', 'ndwi'], createdAt: '2026-01-01', training: { samples: 300, groups: 300, perClass: {}, sceneIds: [] }, validation: null }, { nTrees: 15 });
  assert.equal(predict(f, [0, 0]).cls, LC.Water);
  assert.equal(predict(f, [1, 0]).cls, LC.Vegetation);
  assert.equal(predict(f, [2, 0]).cls, LC.BuiltUp);
  assert.ok(predict(f, [2, 0]).p > 0.8);
  const g = parseForest(serializeForest(f));
  assert.equal(predict(g, [1, 0]).cls, LC.Vegetation);
  assert.equal(f.meta.validation, null, 'a freshly trained model is not validated');
});

test('model trained for another sensor is refused', () => {
  const f = trainForest([[0], [1], [0], [1]], [1, 2, 1, 2], { id: 'x', name: 'x', sensor: 'landsat', features: ['ndvi'], createdAt: '', training: { samples: 4, groups: 4, perClass: {}, sceneIds: [] }, validation: null }, { nTrees: 2 });
  const s: Stack = { sensor: 's2', width: 1, height: 1, data: { ndvi: Float32Array.from([0.5]) }, qa: Uint8Array.from([QA.Clear]) };
  assert.throws(() => classifyStack(s, { method: 'model', model: f }));
});

// ---------------------------------------------------------------- accuracy assessment
test('confusion matrix metrics (worked example)', () => {
  // reference: 6 water, 4 veg; predicted: 5 of the water correct, 1 water→veg; 3 veg correct, 1 veg→water
  const ref = [1, 1, 1, 1, 1, 1, 2, 2, 2, 2];
  const pred = [1, 1, 1, 1, 1, 2, 2, 2, 2, 1];
  const a = assess(ref, pred);
  assert.deepEqual(a.matrix, [[5, 1], [1, 3]]);
  assert.equal(a.overallAccuracy, 0.8);
  const w = a.perClass[0];
  assert.ok(Math.abs(w.producers - 5 / 6) < 1e-9); // recall
  assert.ok(Math.abs(w.users - 5 / 6) < 1e-9); // precision
  assert.ok(Math.abs(w.iou - 5 / 7) < 1e-9);
  assert.ok(Math.abs(a.kappa - (0.8 - 0.52) / 0.48) < 1e-9);
});

test('spatial split never puts one group on both sides', () => {
  const samples = [] as { cls: number; group: string }[];
  for (let g = 0; g < 20; g++) for (let k = 0; k < 15; k++) samples.push({ cls: g % 2 ? LC.Water : LC.Vegetation, group: `poly${g}` });
  const s = spatialSplit(samples, 0.3, 1);
  const tg = new Set(s.train.map((x) => x.group));
  for (const v of s.val) assert.equal(tg.has(v.group), false);
  assert.ok(s.val.length > 0 && s.train.length > 0);
  const one = spatialSplit([{ cls: 1, group: 'a' }, { cls: 1, group: 'a' }, { cls: 2, group: 'b' }, { cls: 2, group: 'c' }]);
  assert.ok(one.warnings.some((w) => w.includes('class 1')), 'warns when a class cannot be validated');
});

// ---------------------------------------------------------------- training samples
test('training samples from GeoJSON: names in English/Thai, unknown labels reported', () => {
  assert.equal(parseClass('น้ำ'), LC.Water);
  assert.equal(parseClass('Built-up'), LC.BuiltUp);
  assert.equal(parseClass('forest'), LC.DenseVegetation);
  assert.equal(parseClass('6'), LC.BuiltUp);
  assert.equal(parseClass('lava'), null);
  const s = parseSamples({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { class: 'water' }, geometry: { type: 'Point', coordinates: [100.5, 13.7] } },
      { type: 'Feature', properties: { class: 'ดินเปล่า', split: 'validation' }, geometry: { type: 'Polygon', coordinates: [[[100, 13], [100.01, 13], [100.01, 13.01], [100, 13]]] } },
      { type: 'Feature', properties: { class: 'lava' }, geometry: { type: 'Point', coordinates: [0, 0] } },
    ],
  });
  assert.equal(s.features.length, 2);
  assert.equal(s.features[1].split, 'validation');
  assert.equal(s.skipped.length, 1);
});
