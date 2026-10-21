import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtArea, geometryAreaKm2, KM2_TO_RAI, km2ToRai, m2ToRai, polygonAreaKm2, rectAreaKm2, raiToKm2, RAI_M2 } from '../src/lib/area';

const close = (a: number, b: number, rel: number) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${a} vs ${b}`);

test('whole ellipsoid equals the WGS84 surface area (510,065,621.724 km²)', () => {
  close(rectAreaKm2(-180, -90, 180, 90), 510065621.724, 1e-9);
});

test('small cell matches the local metric approximation (a·Δλ × M·Δφ)', () => {
  // 0.01° × 0.01° at the equator: 1,113.195 m × 1,105.743 m
  close(rectAreaKm2(0, 0, 0.01, 0.01), (111319.4908 * 0.01 * 110574.2727 * 0.01) / 1e6, 1e-4);
});

test('polygon area equals the exact rectangle area for lat/lon rectangles', () => {
  for (const [w, s, e, n] of [[100, 14, 101, 15], [98.5, 6.1, 98.62, 6.2], [102, 13.9, 102.05, 13.95]]) {
    close(polygonAreaKm2([[[w, s], [e, s], [e, n], [w, n], [w, s]]]), rectAreaKm2(w, s, e, n), 1e-9);
  }
});

test('holes are subtracted and multipolygons add up', () => {
  const outer = [[100, 14], [101, 14], [101, 15], [100, 15], [100, 14]];
  const hole = [[100.25, 14.25], [100.75, 14.25], [100.75, 14.75], [100.25, 14.75], [100.25, 14.25]];
  close(polygonAreaKm2([outer, hole]), rectAreaKm2(100, 14, 101, 15) - rectAreaKm2(100.25, 14.25, 100.75, 14.75), 1e-9);
  const mp: GeoJSON.MultiPolygon = { type: 'MultiPolygon', coordinates: [[outer], [hole]] };
  close(geometryAreaKm2(mp), rectAreaKm2(100, 14, 101, 15) + rectAreaKm2(100.25, 14.25, 100.75, 14.75), 1e-9);
});

test('a ~5 km square at 14°N is about 25 km²', () => {
  const dy = 2.5 / 110.574, dx = 2.5 / (111.32 * Math.cos((14 * Math.PI) / 180));
  close(polygonAreaKm2([[[100 - dx, 14 - dy], [100 + dx, 14 - dy], [100 + dx, 14 + dy], [100 - dx, 14 + dy], [100 - dx, 14 - dy]]]), 25, 0.01);
});

test('unit constants: 1 km² = 625 rai, 1 rai = 1,600 m²', () => {
  assert.equal(KM2_TO_RAI, 625);
  assert.equal(RAI_M2, 1600);
  assert.equal(km2ToRai(1), 625);
  assert.equal(raiToKm2(625), 1);
  assert.equal(m2ToRai(1600), 1);
  assert.equal(km2ToRai(1e6 / 1e6), 1e6 / RAI_M2);
});

test('formatting uses km² and rai only, primary unit selectable', () => {
  assert.equal(fmtArea(12.45, 'km2', true), '12.45 ตร.กม. (7,781.25 ไร่)');
  assert.equal(fmtArea(12.45, 'rai', true), '7,781.25 ไร่ (12.45 ตร.กม.)');
  assert.equal(fmtArea(12.45, 'km2', false), '12.45 km² (7,781.25 rai)');
  for (const s of [fmtArea(0.0031), fmtArea(250.5), fmtArea(0)]) assert.ok(!/ha|เฮกตาร์|acre|ตร\.ม\.|mi²/.test(s), s);
});
