import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outlineRgba } from '../src/lib/outline';

const W = 8, H = 8;
const img = () => new Uint8ClampedArray(W * H * 4);
const put = (a: Uint8ClampedArray, x: number, y: number, rgba: number[]) => a.set(rgba, (y * W + x) * 4);
const alpha = (a: Uint8ClampedArray, x: number, y: number) => a[(y * W + x) * 4 + 3];

test('a filled patch keeps only its border, in its own colour', () => {
  const a = img();
  for (let y = 2; y <= 5; y++) for (let x = 2; x <= 5; x++) put(a, x, y, [239, 68, 68, 215]);
  const o = outlineRgba(a, W, H);
  assert.equal(alpha(o, 2, 2), 255);
  assert.equal(alpha(o, 5, 3), 255);
  assert.equal(alpha(o, 3, 3), 0); // interior
  assert.equal(alpha(o, 4, 4), 0);
  assert.deepEqual([...o.slice((2 * W + 3) * 4, (2 * W + 3) * 4 + 3)], [239, 68, 68]);
});

test('a one-pixel-wide line stays whole', () => {
  const a = img();
  for (let x = 0; x < W; x++) put(a, x, 4, [244, 63, 94, 215]);
  const o = outlineRgba(a, W, H);
  for (let x = 0; x < W; x++) assert.equal(alpha(o, x, 4), 255);
});

test('cloud / no-data hatching (lighter alpha) is left out', () => {
  const a = img();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(a, x, y, [235, 235, 245, 170]);
  const o = outlineRgba(a, W, H);
  assert.equal(o.reduce((t, v, i) => t + (i % 4 === 3 ? v : 0), 0), 0);
});
