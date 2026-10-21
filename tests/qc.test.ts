import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPair, checkScene, comparisonQuality, gsdMeters, nearestPassing, QC_DEFAULT, sameSeason, sceneDates } from '../src/lib/qc';

const s2 = (o: any = {}) => ({ id: 's2', collection: 'sentinel-2-l2a', gsd: '10 m', cloudCover: 5, coveragePct: 100, datetime: '2026-10-01T03:00:00Z', raw: { properties: {} }, ...o }) as any;
const ls = (o: any = {}) => ({ ...s2(o), id: 'ls', collection: 'landsat-c2-l2', gsd: '30 m', ...o }) as any;
const s1 = (o: any = {}) => ({ id: 's1', collection: 'sentinel-1-rtc', gsd: '10 m (RTC γ⁰)', cloudCover: null, coveragePct: 100, datetime: '2026-10-01T11:00:00Z', raw: { properties: {} }, ...o }) as any;
const clear = { cloudPct: 2, shadowPct: 1, noDataPct: 0 };

test('default thresholds: scene cloud 20%', () => assert.equal(QC_DEFAULT.maxSceneCloud, 20));

test('scene cloud above the limit fails, at the limit passes', () => {
  assert.equal(checkScene(s2({ cloudCover: 21 }), clear, QC_DEFAULT).ok, false);
  assert.equal(checkScene(s2({ cloudCover: 20 }), clear, QC_DEFAULT).ok, true);
});

test('AOI cloud is judged separately from scene cloud', () => {
  // cloudy scene overall can still be rejected or accepted on its own scene limit; AOI cloud is its own check
  const q = { ...QC_DEFAULT, maxSceneCloud: 80 };
  assert.equal(checkScene(s2({ cloudCover: 70 }), clear, q).ok, true, 'cloudy scene but clear AOI passes when scene limit allows');
  const r = checkScene(s2({ cloudCover: 2 }), { cloudPct: 30, shadowPct: 5, noDataPct: 0 }, QC_DEFAULT);
  assert.equal(r.ok, false, 'clear scene but cloudy AOI fails');
  assert.ok(r.reasons.some((x) => x.includes('AOI')));
});

test('cloud shadow counts toward the AOI limit', () => {
  assert.equal(checkScene(s2(), { cloudPct: 12, shadowPct: 9, noDataPct: 0 }, QC_DEFAULT).ok, false);
});

test('unmeasured AOI cloud is "pending", never a pass', () => {
  const r = checkScene(s2(), null, QC_DEFAULT);
  assert.equal(r.ok, false);
  assert.equal(r.pending, true);
});

test('minimum analysable share is enforced', () => {
  assert.equal(checkScene(s2(), { cloudPct: 5, shadowPct: 0, noDataPct: 8 }, { ...QC_DEFAULT, minValidPct: 90 }).ok, false);
  assert.equal(checkScene(s2(), { cloudPct: 5, shadowPct: 0, noDataPct: 4 }, { ...QC_DEFAULT, minValidPct: 90 }).ok, true);
});

test('pixel size limit', () => {
  assert.equal(gsdMeters(ls()), 30);
  assert.equal(checkScene(ls(), clear, QC_DEFAULT).ok, false);
  assert.equal(checkScene(ls(), clear, { ...QC_DEFAULT, maxGsdM: 30 }).ok, true);
});

test('radar ignores cloud but not coverage', () => {
  assert.equal(checkScene(s1(), null, QC_DEFAULT).ok, true);
  assert.equal(checkScene(s1({ coveragePct: 60 }), null, QC_DEFAULT).ok, false);
});

test('radar is never compared with optical; cross-sensor optical needs consent', () => {
  assert.equal(checkPair(s1({ datetime: '2026-09-01T00:00:00Z' }), s2(), QC_DEFAULT).ok, false);
  const a = s2({ datetime: '2026-09-01T00:00:00Z' }), b = ls();
  assert.equal(checkPair(a, b, QC_DEFAULT).ok, false);
  const ok = checkPair(a, b, { ...QC_DEFAULT, allowCrossSensor: true });
  assert.equal(ok.ok, true);
  assert.ok(ok.notes.length > 0, 'cross-sensor limitation is stated');
});

test('before must precede after', () => {
  assert.equal(checkPair(s2({ datetime: '2026-10-05T00:00:00Z' }), s2(), QC_DEFAULT).ok, false);
});

test('quality score: factors add to the score, max 100, poorer inputs score lower', () => {
  const good = comparisonQuality({ validFrac: 1, aoiCloudA: 0, aoiCloudB: 0, sameCollection: true, sameFamily: true, sameGeometry: true, gapDays: 10, sameSeason: true, gsdA: 10, gsdB: 10 });
  assert.equal(good.score, 100);
  assert.equal(good.factors.reduce((t, f) => t + f.max, 0), 100);
  const bad = comparisonQuality({ validFrac: 0.6, aoiCloudA: 0.3, aoiCloudB: 0.1, sameCollection: false, sameFamily: true, sameGeometry: false, gapDays: 200, sameSeason: false, gsdA: 10, gsdB: 30 });
  assert.ok(bad.score < 60, String(bad.score));
  assert.ok(bad.factors.every((f) => f.points >= 0 && f.points <= f.max));
});

test('season check wraps around the new year', () => {
  assert.equal(sameSeason('2025-12-20T00:00:00Z', '2026-01-10T00:00:00Z'), true);
  assert.equal(sameSeason('2025-06-01T00:00:00Z', '2026-01-10T00:00:00Z'), false);
});

test('acquisition, processing and catalogue dates are kept apart', () => {
  const d = sceneDates({ datetime: '2026-10-19T03:41:51Z', raw: { properties: { 's2:generation_time': '2026-10-19T08:12:02Z', created: '2026-10-20T01:00:00Z' } } } as any);
  assert.equal(d.acquired, '2026-10-19T03:41:51Z');
  assert.equal(d.processed, '2026-10-19T08:12:02Z');
  assert.equal(d.ingested, '2026-10-20T01:00:00Z');
});

test('nearestPassing never returns a failing scene', () => {
  const list = [s2({ id: 'a', datetime: '2026-09-01T00:00:00Z' }), s2({ id: 'b', datetime: '2026-09-30T00:00:00Z' }), s2({ id: 'c', datetime: '2026-08-01T00:00:00Z' })];
  const pick = nearestPassing(list, '2026-09-29T00:00:00Z', (x) => x.id !== 'b');
  assert.equal(pick?.id, 'a');
  assert.equal(nearestPassing(list, '2026-09-29T00:00:00Z', () => false), null);
});
