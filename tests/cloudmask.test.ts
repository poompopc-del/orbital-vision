import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMask, distanceTo, pxForMeters, ST_CLEAR, ST_CLOUD, ST_NODATA, ST_SHADOW } from '../src/lib/cloudmask';

const W = 40, H = 40;
const grid = (fill: number) => new Float32Array(W * H).fill(fill);
const at = (x: number, y: number) => y * W + x;
const opts = { bufferPx: 2, nearPx: 5, shadowNearPx: 20, thinCloud: true, hotThr: 0 };

test('distance transform: 0 at source, grows with distance', () => {
  const d = distanceTo((p) => p === at(10, 10), W, H);
  assert.equal(d[at(10, 10)], 0);
  assert.equal(d[at(13, 10)], 3);
  assert.ok(Math.abs(d[at(12, 12)] - 2 * Math.SQRT2) < 1e-5);
});

test('cloud edge buffer: pixels next to a flagged cloud become cloud, far pixels stay clear', () => {
  const s = grid(4);
  s[at(20, 20)] = 8;
  const m = buildMask(s, null, W, H, opts);
  assert.equal(m[at(20, 20)], ST_CLOUD);
  assert.equal(m[at(22, 20)], ST_CLOUD, 'within 2 px buffer');
  assert.equal(m[at(25, 20)], ST_CLEAR, 'outside buffer');
});

test('no buffer when bufferPx = 0', () => {
  const s = grid(4);
  s[at(20, 20)] = 8;
  const m = buildMask(s, null, W, H, { ...opts, bufferPx: 0 });
  assert.equal(m[at(21, 20)], ST_CLEAR);
});

test('"unclassified" (SCL 7) and hazy pixels count as cloud only near a cloud', () => {
  const s = grid(4), hot = grid(-0.1);
  s[at(5, 5)] = 8;
  s[at(9, 5)] = 7; // 4 px from cloud → thin cloud
  s[at(35, 35)] = 7; // far → clear
  hot[at(5, 9)] = 0.05; // hazy, 4 px from cloud
  hot[at(30, 5)] = 0.2; // bright roof far from cloud → stays clear
  const m = buildMask(s, hot, W, H, opts);
  assert.equal(m[at(9, 5)], ST_CLOUD);
  assert.equal(m[at(11, 5)], ST_CLOUD, 'thin cloud is buffered too');
  assert.equal(m[at(5, 9)], ST_CLOUD);
  assert.equal(m[at(35, 35)], ST_CLEAR);
  assert.equal(m[at(30, 5)], ST_CLEAR);
});

test('thin-cloud check can be turned off', () => {
  const s = grid(4);
  s[at(5, 5)] = 8;
  s[at(9, 5)] = 7;
  const m = buildMask(s, null, W, H, { ...opts, thinCloud: false });
  assert.equal(m[at(9, 5)], ST_CLEAR);
});

test('shadow is buffered; "dark area" near a cloud counts as shadow, far away does not', () => {
  const s = grid(4);
  s[at(5, 5)] = 8;
  s[at(5, 15)] = 2; // 10 px from cloud
  s[at(38, 38)] = 2; // ~46 px away
  s[at(30, 20)] = 3; // flagged shadow
  const m = buildMask(s, null, W, H, opts);
  assert.equal(m[at(5, 15)], ST_SHADOW);
  assert.equal(m[at(38, 38)], ST_CLEAR);
  assert.equal(m[at(31, 20)], ST_SHADOW, 'shadow buffer');
});

test('no data stays no data', () => {
  const s = grid(4);
  s[at(1, 1)] = NaN;
  s[at(2, 1)] = 8;
  const m = buildMask(s, null, W, H, opts);
  assert.equal(m[at(1, 1)], ST_NODATA);
});

test('metres → pixels at zoom 15 near Bangkok (~4.6 m/px)', () => {
  const g = { z: 15, north: 13.8, south: 13.7 };
  assert.equal(pxForMeters(g, 100), 22);
  assert.equal(pxForMeters(g, 0), 0);
});
