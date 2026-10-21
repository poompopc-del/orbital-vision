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

test('shift +1 puts every box fully on the neighbour side, −1 fully on the Thai side', () => {
  const nb = tilesAlong([line], 10, 'T', { shift: 1, neighbour: east });
  const th = tilesAlong([line], 10, 'T', { shift: -1, neighbour: east });
  assert.ok(nb.length > 0 && nb.length === th.length);
  nb.forEach((t) => assert.ok(cx(t)[0] >= 102 - 1e-9, 'west edge on/after the line'));
  th.forEach((t) => assert.ok(cx(t)[1] <= 102 + 1e-9, 'east edge on/before the line'));
});

test('the side is found from the neighbour outline, whichever way the line runs', () => {
  const rev: [number, number][] = [[102, 14], [102, 13]];
  tilesAlong([rev], 10, 'T', { shift: 1, neighbour: east }).forEach((t) => assert.ok(cx(t)[0] >= 102 - 1e-9));
});

test('boxes keep their size and ids when shifted', () => {
  const a = tilesAlong([line], 10, 'T', { shift: 0, neighbour: east });
  const b = tilesAlong([line], 10, 'T', { shift: 0.6, neighbour: east });
  assert.deepEqual(a.map((t) => t.id), b.map((t) => t.id));
  a.forEach((t, i) => {
    const [w1, e1] = cx(t), [w2, e2] = cx(b[i]);
    assert.ok(Math.abs((e1 - w1) - (e2 - w2)) < 1e-9);
  });
});
