import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearMask, dilate, CLEAR, CLOUD, DARK, SHADOW } from '../src/lib/cloudmask';

const W = 60, H = 40;
const grid = (v: number) => new Float32Array(W * H).fill(v);

test('dilate grows a point into a (2r+1) square', () => {
  const m = new Uint8Array(W * H);
  m[20 * W + 30] = 1;
  const d = dilate(m, W, H, 2);
  assert.equal(d.reduce((a, b) => a + b, 0), 25);
  assert.equal(d[18 * W + 28], 1);
  assert.equal(d[17 * W + 30], 0);
});

test('cloud and shadow edges are grown; far pixels stay clear', () => {
  const c = grid(CLEAR);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) c[y * W + x] = CLOUD;
  c[30 * W + 50] = SHADOW;
  const m = clearMask(c, W, H, 10, { edgeM: 30, nearM: 100 });
  assert.equal(m[15 * W + 15], 0); // cloud
  assert.equal(m[15 * W + 22], 0); // 3 px from the cloud edge
  assert.equal(m[15 * W + 24], 1); // 5 px away
  assert.equal(m[30 * W + 53], 0); // around the shadow
  assert.equal(m[5 * W + 45], 1);
});

test('dark pixels count as shadow only near a cloud', () => {
  const c = grid(CLEAR);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) c[y * W + x] = CLOUD;
  c[8 * W + 8] = DARK; // close to the cloud
  c[35 * W + 55] = DARK; // far away (a dark field)
  const m = clearMask(c, W, H, 10, { edgeM: 0, nearM: 100 });
  assert.equal(m[8 * W + 8], 0);
  assert.equal(m[35 * W + 55], 1);
});
