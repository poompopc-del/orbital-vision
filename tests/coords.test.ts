import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDMM, parseCoord, squareAround } from '../src/lib/coords';

const near = (a: number, b: number, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const ok = (s: string) => {
  const r = parseCoord(s);
  assert.ok(r.ok, `${s} → ${!r.ok ? r.error : ''}`);
  return (r as any).value as { lat: number; lon: number };
};

test("degrees + decimal minutes: 11°34.2819'N,104°40.8893'E", () => {
  const v = ok("11°34.2819'N,104°40.8893'E");
  near(v.lat, 11 + 34.2819 / 60);
  near(v.lon, 104 + 40.8893 / 60);
});

test('degrees-minutes-seconds as Google Maps shows it', () => {
  const v = ok(`11°34'16.9"N 104°40'53.4"E`);
  near(v.lat, 11 + 34 / 60 + 16.9 / 3600);
  near(v.lon, 104 + 40 / 60 + 53.4 / 3600);
});

test('plain decimals, latitude first', () => {
  const v = ok('11.571365, 104.681488');
  near(v.lat, 11.571365);
  near(v.lon, 104.681488);
});

test('leading hemisphere letters, space separated', () => {
  const v = ok('N 11 34.2819 E 104 40.8893');
  near(v.lat, 11 + 34.2819 / 60);
  near(v.lon, 104 + 40.8893 / 60);
});

test('longitude first when the letters say so', () => {
  const v = ok("104°40.8893'E 11°34.2819'N");
  near(v.lat, 11 + 34.2819 / 60);
  near(v.lon, 104 + 40.8893 / 60);
});

test('south / west and negative decimals', () => {
  const a = ok("33°52.0'S, 151°12.5'E");
  assert.ok(a.lat < 0 && a.lon > 0);
  const b = ok('-33.8667, -70.65');
  near(b.lat, -33.8667);
  near(b.lon, -70.65);
});

test('typographic quotes and º from phones / Word', () => {
  const v = ok('11º34′16.9″N 104º40′53.4″E');
  near(v.lat, 11 + 34 / 60 + 16.9 / 3600);
});

test('errors: one value, bad minutes, out of range, two latitudes', () => {
  assert.equal(parseCoord('11.5').ok, false);
  assert.equal(parseCoord("11°75'N 104°10'E").ok, false);
  assert.equal(parseCoord('104.68, 11.57, 3').ok, false);
  assert.equal(parseCoord('95.0, 104.0').ok, false);
  assert.equal(parseCoord("11°N 12°S").ok, false);
  assert.equal(parseCoord('').ok, false);
});

test('format back to degrees + decimal minutes round-trips', () => {
  const v = ok("11°34.2819'N,104°40.8893'E");
  assert.equal(formatDMM(v), "11°34.2819'N, 104°40.8893'E");
  assert.equal(formatDMM({ lat: -0.5, lon: -0.25 }), "0°30.0000'S, 0°15.0000'W");
});

test('square around a point is the requested size and centred', () => {
  const g = squareAround({ lat: 11.5714, lon: 104.6815 }, 2);
  const [w, s] = g.coordinates[0][0], [e, n] = g.coordinates[0][2];
  near((n - s) * 110.574, 2, 1e-3);
  near((e - w) * 111.32 * Math.cos((11.5714 * Math.PI) / 180), 2, 1e-3);
  near((w + e) / 2, 104.6815, 1e-5);
});
