import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLinear } from '../src/lib/linear';

// synthetic 10 m NDVI scenes: dense forest (≈ 0.80) with sensor/atmosphere noise
const W = 240, H = 240;
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}
function scenes(seed: number, sigma = 0.03) {
  const r = rng(seed);
  const a = new Float32Array(W * H), b = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) {
    a[p] = 0.8 + sigma * gauss(r);
    b[p] = 0.8 + sigma * gauss(r);
  }
  return { a, b };
}
/** Draw a narrow track into the after-image: sub-pixel width → NDVI drop of `drop` shared over the pixels it crosses. */
function track(b: Float32Array, x0: number, y0: number, x1: number, y1: number, drop: number) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  const hit = new Set<number>();
  for (let i = 0; i <= n; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / n), y = Math.round(y0 + ((y1 - y0) * i) / n);
    hit.add(y * W + x);
  }
  hit.forEach((p) => (b[p] -= drop));
  return hit;
}
const dist = (p: number, x0: number, y0: number, x1: number, y1: number) => {
  const y = (p / W) | 0, x = p - y * W;
  const dx = x1 - x0, dy = y1 - y0;
  const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
};

test('finds a sub-pixel track the per-pixel threshold misses', () => {
  const { a, b } = scenes(1);
  const line = track(b, 30, 40, 200, 170, 0.1); // ≈ 2.1 km, NDVI drop 0.10
  // the existing "clearing" rule (drop ≥ 0.20) sees almost none of it
  const perPixel = [...line].filter((p) => a[p] - b[p] >= 0.2).length;
  assert.ok(perPixel / line.size < 0.1, `per-pixel rule found ${perPixel}/${line.size}`);

  const res = detectLinear(a, b, W, H);
  const found = [...line].filter((p) => res.mask[p]).length;
  assert.ok(found / line.size >= 0.7, `found ${found}/${line.size} track pixels`);
  let off = 0;
  for (let p = 0; p < W * H; p++) if (res.mask[p] && dist(p, 30, 40, 200, 170) > 2) off++;
  assert.ok(off <= 5, `${off} pixels flagged away from the track`);
  // a faint stretch may split the track into pieces; together they should span most of its ≈ 2.1 km
  const total = res.pieces.reduce((t, p) => t + p.lengthM, 0);
  assert.ok(total > 1700 && total < 2600, `pieces total ${total.toFixed(0)} m`);
});

test('pure noise gives no detections', () => {
  for (const seed of [2, 3, 4]) {
    const { a, b } = scenes(seed);
    const res = detectLinear(a, b, W, H);
    assert.equal(res.pieces.length, 0, `seed ${seed}: ${res.pieces.length} false pieces`);
  }
});

test('a broad clearing, haze and a vegetation step edge are not called linear', () => {
  const { a, b } = scenes(5);
  // clearing 40×40 px
  for (let y = 100; y < 140; y++) for (let x = 100; x < 140; x++) b[y * W + x] -= 0.35;
  // haze gradient across the whole after-image
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) b[y * W + x] -= (0.08 * x) / W;
  // step: the left third drier after (season change on the forest edge)
  for (let y = 0; y < H; y++) for (let x = 0; x < 60; x++) b[y * W + x] -= 0.12;
  const res = detectLinear(a, b, W, H);
  const n = res.mask.reduce((t, v) => t + v, 0);
  assert.ok(n <= 10, `${n} pixels flagged`);
});

test('a track partly under cloud (NaN) is still found where visible', () => {
  const { a, b } = scenes(6);
  const line = track(b, 20, 120, 220, 120, 0.12);
  for (let y = 80; y < 160; y++) for (let x = 100; x < 140; x++) b[y * W + x] = NaN;
  const res = detectLinear(a, b, W, H);
  const visible = [...line].filter((p) => !Number.isNaN(b[p]));
  const found = visible.filter((p) => res.mask[p]).length;
  assert.ok(found / visible.length >= 0.7, `found ${found}/${visible.length}`);
  for (let p = 0; p < W * H; p++) if (Number.isNaN(b[p])) assert.equal(res.mask[p], 0);
});

test('vegetation gain along a line is not reported as a new track', () => {
  const { a, b } = scenes(7);
  track(a, 30, 200, 210, 30, 0.12); // the line was bare BEFORE (regrowth after)
  const res = detectLinear(a, b, W, H);
  assert.equal(res.pieces.length, 0);
});
