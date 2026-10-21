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

test('border focus: centred at 0.5, pans into the neighbour or into Thailand, same size, line still on screen', () => {
  const line: [number, number, number, number] = [102.3, 13.6, 103.6, 14.6]; // TH–KH northern stretch
  const cambodia: [number, number] = [104.9, 12.7];
  const thailand: [number, number] = [101.0, 13.0];
  const cx = (r: number[]) => (r[0] + r[2]) / 2, cy = (r: number[]) => (r[1] + r[3]) / 2;
  const c = borderFocusRect(line, cambodia, thailand, 0.5);
  assert.ok(Math.abs(cx(c) - (line[0] + line[2]) / 2) < 1e-9 && Math.abs(cy(c) - (line[1] + line[3]) / 2) < 1e-9);
  const nb = borderFocusRect(line, cambodia, thailand, 1);
  assert.ok(cx(nb) > cx(c) && cy(nb) < cy(c), 'moves toward Cambodia (east-south)');
  const th = borderFocusRect(line, cambodia, thailand, 0);
  assert.ok(cx(th) < cx(c), 'moves toward Thailand (west)');
  for (const r of [nb, th, borderFocusRect(line, cambodia, thailand, 0.25), borderFocusRect(line, cambodia, thailand, 0.8)]) {
    assert.ok(Math.abs((r[2] - r[0]) - (c[2] - c[0])) < 1e-9 && Math.abs((r[3] - r[1]) - (c[3] - c[1])) < 1e-9, 'same size, no distortion');
    const overlaps = r[0] < line[2] && r[2] > line[0] && r[1] < line[3] && r[3] > line[1];
    assert.ok(overlaps, 'border line still on screen');
  }
  // monotonic: further along the slider = further into that country
  assert.ok(cx(borderFocusRect(line, cambodia, thailand, 0.75)) < cx(nb));
});

test('outside-share is measured from geometry', () => {
  const sq: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  assert.ok(inGeometry(0.5, 0.5, sq) && !inGeometry(1.5, 0.5, sq));
  assert.ok(Math.abs(outsideShare([0, 0, 1, 1], sq)) < 1e-9);
  assert.ok(Math.abs(outsideShare([0, 0, 2, 1], sq) - 0.5) < 0.02);
  assert.ok(Math.abs(outsideShare([5, 5, 6, 6], sq) - 1) < 1e-9);
});
