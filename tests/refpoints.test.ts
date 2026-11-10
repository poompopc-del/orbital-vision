import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dir8, nearestRef, nearText, refKind, type RefPoint } from '../src/lib/refpoints';

test('kind from the name', () => {
  assert.equal(refKind('หลักเขตหมายเลข 7'), 'marker');
  assert.equal(refKind('หลักเขตแดนหมายเลข 12'), 'marker');
  assert.equal(refKind('BP 23'), 'marker');
  assert.equal(refKind('เนิน 404'), 'hill');
  assert.equal(refKind('Hill 385'), 'hill');
  assert.equal(refKind('ช่องพราน'), 'pass');
  assert.equal(refKind('ช่องเล็กเยีย'), 'pass');
  assert.equal(refKind('จว.สุรินทร์'), 'other');
});

// made-up points around a spot (not real survey data)
const refs: RefPoint[] = [
  { name: 'หลักเขตหมายเลข 7', lon: 103.865, lat: 14.352, kind: 'marker' },
  { name: 'ช่องพราน', lon: 103.83, lat: 14.36, kind: 'pass' },
  { name: 'เนิน 404', lon: 103.92, lat: 14.33, kind: 'hill' },
];

test('nearest point, distance and direction', () => {
  const n = nearestRef(103.8506, 14.35, refs)!; // 14°20'59.9"N 103°51'02.0"E
  assert.equal(n.name, 'หลักเขตหมายเลข 7');
  assert.ok(n.km > 1.4 && n.km < 1.7, `km ${n.km}`);
  assert.equal(dir8(n.bearingDeg), 6); // west of the pillar
  assert.equal(nearText(n, true), '1.6 กม. ทางทิศตะวันตกของหลักเขตหมายเลข 7');
  assert.equal(nearText(n, false), '1.6 km west of หลักเขตหมายเลข 7');
});

test('nothing within range → null; right on a point → "at"', () => {
  assert.equal(nearestRef(100.5, 13.75, refs), null);
  const n = nearestRef(103.83, 14.36, refs)!;
  assert.equal(nearText(n, true), 'ที่ช่องพราน');
});

test('eight directions', () => {
  assert.deepEqual([0, 44, 46, 90, 180, 225, 270, 337, 359].map(dir8), [0, 1, 1, 2, 4, 5, 6, 7, 0]);
});
