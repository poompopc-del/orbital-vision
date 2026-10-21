import { test } from 'node:test';
import assert from 'node:assert/strict';
import { borderFocusRect, inGeometry, outsideShare, overviewRect, THAILAND_BBOX_FALLBACK } from '../src/lib/extent';

const contains = (o: number[], i: number[]) => o[0] <= i[0] && o[1] <= i[1] && o[2] >= i[2] && o[3] >= i[3];

test('overview frame contains all of Thailand with a margin on every side', () => {
  const r = overviewRect(THAILAND_BBOX_FALLBACK);
  assert.ok(contains(r, THAILAND_BBOX_FALLBACK));
  assert.ok(r[0] < THAILAND_BBOX_FALLBACK[0] && r[2] > THAILAND_BBOX_FALLBACK[2] && r[1] < THAILAND_BBOX_FALLBACK[1] && r[3] > THAILAND_BBOX_FALLBACK[3]);
  // northern tip (Mae Sai ~20.45N), southern tip (~5.6N), western (~97.35E), eastern (~105.6E) are inside
  for (const [x, y] of [[99.88, 20.45], [101.1, 5.65], [97.36, 18.5], [105.63, 15.3]]) assert.ok(x > r[0] && x < r[2] && y > r[1] && y < r[3]);
});

test('border focus: centred at 0.5, shifted toward the neighbour above 0.5, line stays in frame', () => {
  const line: [number, number, number, number] = [102.3, 13.6, 103.6, 14.6]; // TH–KH northern stretch
  const toward: [number, number] = [104.9, 12.7]; // Cambodia
  const c = borderFocusRect(line, toward, 0.5);
  assert.ok(Math.abs((c[0] + c[2]) / 2 - (line[0] + line[2]) / 2) < 1e-9);
  const f = borderFocusRect(line, toward, 0.9);
  assert.ok((f[0] + f[2]) / 2 > (c[0] + c[2]) / 2, 'moves east');
  assert.ok((f[1] + f[3]) / 2 < (c[1] + c[3]) / 2, 'moves south');
  assert.ok(contains(f, line), 'border line still fully visible');
  // no distortion: the frame keeps the same width/height ratio at every share (it only grows)
  assert.ok(Math.abs((f[2] - f[0]) / (f[3] - f[1]) - (c[2] - c[0]) / (c[3] - c[1])) < 1e-9);
  for (const sh of [0.2, 0.35, 0.65, 0.8, 0.95]) assert.ok(contains(borderFocusRect(line, toward, sh), line), `line inside at share ${sh}`);
});

test('outside-share is measured from geometry', () => {
  const sq: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  assert.ok(inGeometry(0.5, 0.5, sq) && !inGeometry(1.5, 0.5, sq));
  assert.ok(Math.abs(outsideShare([0, 0, 1, 1], sq)) < 1e-9);
  assert.ok(Math.abs(outsideShare([0, 0, 2, 1], sq) - 0.5) < 0.02);
  assert.ok(Math.abs(outsideShare([5, 5, 6, 6], sq) - 1) < 1e-9);
});
