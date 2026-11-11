import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseStack, compass, dateColour, pixelBreak } from '../src/lib/timeseries';

const N = NaN;

test('pixel: a lasting drop breaks at its first scene', () => {
  assert.deepEqual(pixelBreak([0.8, 0.82, 0.79, 0.55, 0.52, 0.5]), [3, true]);
});
test('pixel: a one-scene dip that recovers is ignored', () => {
  assert.deepEqual(pixelBreak([0.8, 0.82, 0.55, 0.8, 0.81]), [-1, false]);
});
test('pixel: clouds (NaN) are skipped, the break is found on the clear scenes', () => {
  assert.deepEqual(pixelBreak([0.8, N, 0.81, N, 0.6, N, 0.58]), [4, true]);
});
test('pixel: a drop on the newest value is kept as unconfirmed', () => {
  assert.deepEqual(pixelBreak([0.8, 0.8, 0.81, 0.6]), [3, false]);
});
test('pixel: too few earlier values → no baseline, no break', () => {
  assert.deepEqual(pixelBreak([0.8, 0.5]), [-1, false]);
  assert.deepEqual(pixelBreak([N, 0.8, N, 0.5]), [-1, false]);
});

// synthetic stack: 8 scenes, a road growing east by ~10 px per scene from scene 3 on
const W = 120, H = 60, S = 8;
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const g = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
function stack(seed: number) {
  const r = rng(seed);
  const st = Array.from({ length: S }, () => new Float32Array(W * H).map(() => 0.8 + 0.03 * g(r)));
  return st;
}
const days = Array.from({ length: S }, (_, k) => k * 10);

test('a road growing east: dated pixels, direction ≈ east, speed from the dates', () => {
  const st = stack(1);
  for (let k = 3; k < S; k++)
    for (let s = k; s < S; s++) for (let x = 10; x < 10 + (k - 2) * 15; x++) for (let y = 30; y < 32; y++) st[s][y * W + x] = Math.min(st[s][y * W + x], 0.55);
  const res = analyseStack(st, days, W, H);
  assert.equal(res.pieces.length, 1, `${res.pieces.length} pieces`);
  const pc = res.pieces[0];
  assert.equal(pc.first, 3);
  assert.equal(pc.last, 7); // the newest scene: unconfirmed part of the same piece
  assert.ok(pc.growth, 'has a growth vector');
  assert.equal(compass(pc.growth!.bearingDeg, false), 'east');
  // ~60 px between the first and last centroids over 40 days → ≈ 450 m/month at 10 m
  assert.ok(pc.growth!.mPerMonth > 300 && pc.growth!.mPerMonth < 600, `${pc.growth!.mPerMonth} m/month`);
  assert.equal(res.breakAt[31 * W + 20], 3);
  assert.equal(res.breakAt[31 * W + 30], 4);
  assert.equal(res.breakAt[31 * W + 50], 5);
});

test('pure noise and a one-scene cloud shadow give no pieces', () => {
  const st = stack(2);
  for (let y = 10; y < 40; y++) for (let x = 20; x < 60; x++) st[4][y * W + x] -= 0.3; // shadow on scene 4 only
  const res = analyseStack(st, days, W, H);
  assert.equal(res.pieces.length, 0);
});

test('cloud masks on some scenes do not hide a lasting clearing', () => {
  const st = stack(3);
  for (let s = 2; s < S; s++) for (let y = 20; y < 30; y++) for (let x = 50; x < 60; x++) st[s][y * W + x] = 0.4;
  for (let y = 0; y < H; y++) for (let x = 40; x < 80; x++) { st[3][y * W + x] = NaN; st[5][y * W + x] = NaN; }
  const res = analyseStack(st, days, W, H);
  assert.equal(res.pieces.length, 1);
  assert.equal(res.pieces[0].first, 2);
  assert.equal(res.pieces[0].growth, null); // all at once: no direction
});

test('colours run yellow → purple', () => {
  assert.deepEqual(dateColour(0, 5), [250, 204, 21]);
  assert.deepEqual(dateColour(4, 5), [147, 51, 234]);
});
