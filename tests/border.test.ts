import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tilesAlong } from '../src/lib/border';

// a straight north–south border at lon 102; the neighbour lies to the east
const line: [number, number][] = [[102, 13], [102, 14]];
const east: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[102, 12], [104, 12], [104, 15], [102, 15], [102, 12]]] };
const cx = (t: { center: [number, number]; geometry: GeoJSON.Polygon }) => {
  const xs = t.geometry.coordinates[0].map((p) => p[0]);
  return [Math.min(...xs), Math.max(...xs)];
};

test('shift 0 straddles the line', () => {
  for (const t of tilesAlong([line], 10, 'T', { shift: 0, neighbour: east })) {
    const [w, e] = cx(t);
    assert.ok(w < 102 && e > 102);
  }
});

test('shift +1 puts boxes on the neighbour side, −1 on the Thai side (line kept just inside)', () => {
  const kmDeg = 1 / (111.32 * Math.cos((13.5 * Math.PI) / 180));
  const nb = tilesAlong([line], 10, 'T', { shift: 1, neighbour: east });
  const th = tilesAlong([line], 10, 'T', { shift: -1, neighbour: east });
  assert.ok(nb.length > 0 && th.length > 0);
  nb.forEach((t) => { const [w, e] = cx(t); assert.ok(w < 102 && w > 102 - 1.2 * kmDeg && e > 102 + 8 * kmDeg); });
  th.forEach((t) => { const [w, e] = cx(t); assert.ok(e > 102 && e < 102 + 1.2 * kmDeg && w < 102 - 8 * kmDeg); });
});

test('boxes cover every point of a winding line at every shift', () => {
  const wind: [number, number][] = [];
  for (let i = 0; i <= 400; i++) wind.push([102 + 0.06 * Math.sin(i / 9) + 0.02 * Math.sin(i / 2.3), 12 + i * 0.006]);
  for (const sh of [-1, -0.5, 0, 0.5, 1]) {
    const ts = tilesAlong([wind], 10, 'W', { shift: sh, neighbour: east });
    for (let i = 0; i < wind.length - 1; i++)
      for (let k = 0; k <= 10; k++) {
        const q: [number, number] = [wind[i][0] + ((wind[i + 1][0] - wind[i][0]) * k) / 10, wind[i][1] + ((wind[i + 1][1] - wind[i][1]) * k) / 10];
        assert.ok(ts.some((t) => { const r = t.geometry.coordinates[0]; return q[0] >= r[0][0] - 1e-9 && q[0] <= r[1][0] + 1e-9 && q[1] >= r[0][1] - 1e-9 && q[1] <= r[2][1] + 1e-9; }), `uncovered point at shift ${sh}`);
      }
  }
});

test('the side is found from the neighbour outline, whichever way the line runs', () => {
  const rev: [number, number][] = [[102, 14], [102, 13]];
  tilesAlong([rev], 10, 'T', { shift: 1, neighbour: east }).forEach((t) => { const [w, e] = cx(t); assert.ok(w < 102 && (102 - w) < (e - 102) / 4, 'mostly east of the line'); });
});

test('boxes keep their size when shifted', () => {
  const a = tilesAlong([line], 10, 'T', { shift: 0, neighbour: east });
  const b = tilesAlong([line], 10, 'T', { shift: 0.6, neighbour: east });
  const wKm = (t: any) => (cx(t)[1] - cx(t)[0]) * 111.32 * Math.cos((t.center[1] * Math.PI) / 180);
  [...a, ...b].forEach((t) => assert.ok(Math.abs(wKm(t) - 10) < 0.01, String(wKm(t))));
});

import { stitch } from '../src/lib/border';
test('stitch joins touching pieces in any direction', () => {
  const parts: [number, number][][] = [[[0, 0], [1, 0]], [[2, 0], [1, 0]], [[2, 0], [3, 0]], [[10, 10], [11, 10]]];
  const s = stitch(parts);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0][0], [0, 0]);
  assert.deepEqual(s[0][s[0].length - 1], [3, 0]);
});

test('overlapping pieces do not produce duplicate boxes', () => {
  const a = tilesAlong([line, line], 10, 'T');
  const b = tilesAlong([line], 10, 'T');
  assert.equal(a.length, b.length);
});
