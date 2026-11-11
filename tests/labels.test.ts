import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, labelsCsv, labelsGeoJson, labelsNear, type ChangeLabel } from '../src/lib/labelCore';

// made-up spots, not real data
const L = (id: string, lon: number, lat: number, label: ChangeLabel['label'], note?: string): ChangeLabel => ({ id, createdAt: '2026-11-11T00:00:00Z', label, note, lon, lat, source: 'change' });
const set = [L('a', 103.85, 14.35, 'track'), L('b', 103.8504, 14.35, 'false_alarm', 'cloud edge, "thin"'), L('c', 103.9, 14.4, 'clearing')];

test('labels near a point, nearest first, within the radius', () => {
  const n = labelsNear(103.8501, 14.35, set);
  assert.deepEqual(n.map((x) => x.id), ['a', 'b']);
  assert.ok(n[0].distM > 5 && n[0].distM < 20, `${n[0].distM}`);
  assert.equal(labelsNear(103.95, 14.45, set).length, 0);
});

test('GeoJSON export: one point per label with its properties', () => {
  const g = labelsGeoJson(set);
  assert.equal(g.features.length, 3);
  assert.deepEqual(g.features[2].geometry.coordinates, [103.9, 14.4]);
  assert.equal(g.features[1].properties.label, 'false_alarm');
});

test('CSV export quotes notes with commas and quotes', () => {
  const csv = labelsCsv(set).split('\n');
  assert.equal(csv.length, 4);
  assert.ok(csv[2].includes('"cloud edge, ""thin"""'), csv[2]);
});

test('unknown kind falls back to "other"', () => {
  assert.equal(kindOf('nonsense').id, 'other');
});
