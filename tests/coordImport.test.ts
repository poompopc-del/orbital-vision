import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importCoordFiles, importCoordText, parseAngle, placePolygon, swapLatLon, TEMPLATE_CSV, type InputFile } from '../src/lib/coordImport';
import { crsFromText, lonLatToUtm, mercToLonLat, utmToLonLat, indian1975ToWgs84 } from '../src/lib/projection';

const near = (a: number, b: number, tol: number, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);
const enc = (s: string) => new TextEncoder().encode(s);
const file = (name: string, content: string | Uint8Array): InputFile => ({ name, bytes: typeof content === 'string' ? enc(content) : content });

// ---- tiny ZIP writer (deflate via CompressionStream) for KMZ / XLSX / zipped shapefile fixtures
async function deflateRaw(b: Uint8Array) {
  const s = new Blob([b]).stream().pipeThrough(new CompressionStream('deflate-raw' as CompressionFormat));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function zip(entries: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let off = 0;
  for (const [name, c] of Object.entries(entries)) {
    const data = typeof c === 'string' ? enc(c) : c;
    const comp = await deflateRaw(data);
    const nb = enc(name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(8, 8, true); lh.setUint32(18, comp.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nb.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(10, 8, true); ch.setUint32(20, comp.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nb.length, true); ch.setUint32(42, off, true);
    parts.push(new Uint8Array(lh.buffer), nb, comp);
    central.push(new Uint8Array(ch.buffer), nb);
    off += 30 + nb.length + comp.length;
  }
  const csize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, Object.keys(entries).length, true); e.setUint16(10, Object.keys(entries).length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

// ---------------------------------------------------------------- projections

test('UTM ↔ lon/lat round-trips and matches reference values', () => {
  const [lon, lat] = utmToLonLat(500000, 0, 31, true);
  near(lon, 3, 1e-9); near(lat, 0, 1e-9);
  // on the central meridian the northing is k0 × the meridian arc (WGS84 arc to 45° = 4,984,944.378 m)
  const [l2, b2] = utmToLonLat(500000, 0.9996 * 4984944.378, 31, true);
  near(l2, 3, 1e-9); near(b2, 45, 1e-8);
  for (const [x, y] of [[100.5018, 13.7563], [98.98, 18.79], [104.5, 15.2], [-70.1, -33.4]]) {
    const u = lonLatToUtm(x, y);
    const [bx, by] = utmToLonLat(u.e, u.n, u.zone, u.north);
    near(bx, x, 1e-8); near(by, y, 1e-8);
  }
  const bkk = lonLatToUtm(100.5018, 13.7563);
  assert.equal(bkk.zone, 47);
  near(bkk.e, 662_000, 1500); near(bkk.n, 1_521_000, 1500);
});

test('Web Mercator and Indian 1975 conversions', () => {
  const R = 6378137, la = 13.7563, lo = 100.5018;
  const [lon, lat] = mercToLonLat((lo * Math.PI / 180) * R, R * Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360)));
  near(lon, lo, 1e-9); near(lat, la, 1e-9);
  // Indian 1975 → WGS84 shifts points in Thailand by a few hundred metres
  const [x, y] = indian1975ToWgs84(100.5, 13.75);
  const dm = Math.hypot((x - 100.5) * 108_000, (y - 13.75) * 110_600);
  assert.ok(dm > 200 && dm < 600, `shift ${dm} m`);
});

test('CRS names from EPSG codes, URNs and .prj WKT', () => {
  assert.deepEqual(crsFromText('EPSG:32647'), { kind: 'utm', zone: 47, north: true, datum: 'wgs84' });
  assert.deepEqual(crsFromText('urn:ogc:def:crs:EPSG::32748'), { kind: 'utm', zone: 48, north: false, datum: 'wgs84' });
  assert.deepEqual(crsFromText('PROJCS["WGS_1984_UTM_Zone_48N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984"]]]'), { kind: 'utm', zone: 48, north: true, datum: 'wgs84' });
  assert.deepEqual(crsFromText('PROJCS["Indian_1975_UTM_Zone_47N",GEOGCS["GCS_Indian_1975"]]'), { kind: 'utm', zone: 47, north: true, datum: 'indian1975' });
  assert.deepEqual(crsFromText('PROJCS["WGS 84 / UTM zone 47N",GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]],AUTHORITY["EPSG","32647"]]'), { kind: 'utm', zone: 47, north: true, datum: 'wgs84' });
  assert.deepEqual(crsFromText('urn:ogc:def:crs:OGC:1.3:CRS84'), { kind: 'geo', datum: 'wgs84' });
  assert.deepEqual(crsFromText('EPSG:3857'), { kind: 'merc' });
});

// ---------------------------------------------------------------- angles & free text

test('angles: decimal, decimal comma, DMS with marks / letters / colons', () => {
  near(parseAngle('13.7563')!.v, 13.7563, 1e-12);
  near(parseAngle('13,7563')!.v, 13.7563, 1e-12);
  near(parseAngle(`13°45'22.7"N`)!.v, 13 + 45 / 60 + 22.7 / 3600, 1e-12);
  near(parseAngle(`100° 30′ 06.5″ E`)!.v, 100 + 30 / 60 + 6.5 / 3600, 1e-12);
  near(parseAngle('S 33 24 00')!.v, -33.4, 1e-12);
  near(parseAngle('100d30m15s')!.v, 100 + 30 / 60 + 15 / 3600, 1e-12);
  near(parseAngle('13:45:30')!.v, 13.758333, 1e-6);
  assert.equal(parseAngle('13°75\''), null);
  assert.equal(parseAngle('abc'), null);
});

test('pasted lines: lat,lon · lon,lat · DMS · UTM · Google Maps links · WKT', () => {
  const r = importCoordText(
    [
      'ฝายบ้านหนองบัว 13.7563, 100.5018',
      '14.0215 99.5321 จุดตรวจ B',
      `N 13°45'22.7" E 100°30'06.5"`,
      '47P 668000 1520000 สถานี UTM',
      'https://www.google.com/maps/place/X/@15.2441,104.8473,15z/data=!3m1!4b1',
      'https://maps.google.com/?q=18.7883,98.9853',
      'POLYGON((100 14, 100.1 14, 100.1 14.1, 100 14.1, 100 14))',
      'just a note without numbers',
    ].join('\n'),
  );
  assert.equal(r.places.length, 7, JSON.stringify(r.warnings));
  const [a, b, c, d, e, f, g] = r.places;
  assert.equal(a.name, 'ฝายบ้านหนองบัว'); near(a.lat, 13.7563, 1e-9); near(a.lon, 100.5018, 1e-9);
  assert.equal(b.name, 'จุดตรวจ B'); near(b.lat, 14.0215, 1e-9);
  near(c.lat, 13.75631, 1e-4); near(c.lon, 100.50181, 1e-4);
  assert.equal(d.name, 'สถานี') // the "UTM" label is stripped; near(d.lat, 13.74, 0.02); near(d.lon, 100.55, 0.02);
  near(e.lat, 15.2441, 1e-9); near(e.lon, 104.8473, 1e-9);
  near(f.lat, 18.7883, 1e-9);
  assert.equal(g.kind, 'polygon'); near(g.lon, 100.05, 1e-9);
  assert.equal(r.skipped, 0);
});

test('a whole file of lon,lat pairs is detected as lon,lat', () => {
  const r = importCoordText('100.50, 13.75\n101.20, 14.10\n99.90, 15.30');
  assert.equal(r.places.length, 3);
  near(r.places[0].lat, 13.75, 1e-9); near(r.places[0].lon, 100.5, 1e-9);
});

test('UTM without a zone uses the chosen default zone and says so', () => {
  const r = importCoordText('668000 1520000\n245000 1650000', { utmZone: 48 });
  assert.equal(r.places.length, 2);
  assert.ok(r.usedDefaultZone);
  near(r.places[0].lon, 106.55, 0.05); // zone 48 central meridian 105°E
});

// ---------------------------------------------------------------- tables

test('CSV with Thai headers, DMS cells, size column, bad row reported', () => {
  const csv = 'ลำดับ,ชื่อจุด,ละติจูด,ลองจิจูด,ขนาด_กม\n1,บ้านนา,13.5,100.25,3\n2,ห้วยทราย,"13°45\'00""N","100°30\'00""E",\n3,ผิดพลาด,,100.1,\n';
  const r = importCoordText(csv);
  assert.equal(r.places.length, 2);
  assert.equal(r.places[0].name, 'บ้านนา');
  assert.equal(r.places[0].sizeKm, 3);
  near(r.places[1].lat, 13.75, 1e-9); near(r.places[1].lon, 100.5, 1e-9);
  assert.equal(r.skipped, 1);
  assert.ok(r.formats.includes('CSV'));
});

test('template CSV imports cleanly', () => {
  const r = importCoordText(TEMPLATE_CSV);
  assert.equal(r.places.length, 3);
  assert.equal(r.skipped, 0);
});

test('semicolon CSV with decimal commas, tab TSV, swapped columns, UTM columns with zone', async () => {
  const r1 = importCoordText('name;lat;lon\nA;13,75;100,5\n');
  near(r1.places[0].lon, 100.5, 1e-9);
  const r2 = importCoordText('name\tlongitude\tlatitude\nB\t99.1\t17.2\n');
  near(r2.places[0].lat, 17.2, 1e-9);
  const r3 = importCoordText('name,lat,lon\nSwapped,100.5,13.75\n');
  near(r3.places[0].lat, 13.75, 1e-9);
  const r4 = importCoordText('id,E,N,zone\nU1,668000,1520000,47N\nU2,245000,1650000,48\n');
  assert.equal(r4.places.length, 2);
  near(r4.places[0].lon, 100.55, 0.02);
  near(r4.places[1].lon, 102.6, 0.05);
  const r5 = importCoordText('ชื่อ,พิกัด\nบ้าน,"13.7, 100.6"\nลิงก์,https://www.google.com/maps/@16.43,102.83,14z\n');
  assert.equal(r5.places.length, 2);
  near(r5.places[1].lon, 102.83, 1e-9);
});

test('Windows-874 (Thai ANSI) CSV is decoded', async () => {
  // "ชื่อ" in TIS-620: 0xAA 0xD7 0xE8 0xCD
  const head = new Uint8Array([0xaa, 0xd7, 0xe8, 0xcd]);
  const rest = enc(',lat,lon\nA,13.1,100.1\n');
  const b = new Uint8Array(head.length + rest.length);
  b.set(head); b.set(rest, head.length);
  const r = await importCoordFiles([file('thai.csv', b)]);
  assert.equal(r.places.length, 1);
  assert.equal(r.places[0].name, 'A');
});

// ---------------------------------------------------------------- GeoJSON / KML / GPX

test('GeoJSON: points, multipolygon (largest ring), lines, names from properties, UTM crs', async () => {
  const gj = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { NAME: 'P1' }, geometry: { type: 'Point', coordinates: [100.1, 14.1, 12] } },
      { type: 'Feature', properties: { ชื่อ: 'แปลง' }, geometry: { type: 'MultiPolygon', coordinates: [[[[100, 14], [100.01, 14], [100.01, 14.01], [100, 14]]], [[[101, 15], [101.2, 15], [101.2, 15.2], [101, 15.2], [101, 15]]]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[100, 13], [100.2, 13.1]] } },
      { type: 'Feature', properties: {}, geometry: null },
    ],
  };
  const r = await importCoordFiles([file('areas.geojson', JSON.stringify(gj))]);
  assert.equal(r.places.length, 3);
  assert.equal(r.places[0].name, 'P1');
  assert.equal(r.places[1].name, 'แปลง');
  near(r.places[1].lon, 101.1, 1e-9);
  assert.equal(r.places[2].kind, 'line');
  assert.equal(r.places[2].name, 'areas 1');
  assert.equal(r.skipped, 1);
  const utm = { type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32647' } }, features: [{ type: 'Feature', properties: { name: 'U' }, geometry: { type: 'Point', coordinates: [668000, 1520000] } }] };
  const r2 = await importCoordFiles([file('u.json', JSON.stringify(utm))]);
  near(r2.places[0].lon, 100.55, 0.02);
});

test('JSON array of records is read like a table', () => {
  const r = importCoordText(JSON.stringify([{ title: 'A', latitude: 13.1, longitude: 100.1 }, { title: 'B', latitude: 13.2, longitude: 100.2 }]));
  assert.deepEqual(r.places.map((p) => p.name), ['A', 'B']);
});

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>My map</name>
<Placemark><name><![CDATA[จุด &amp; ฝาย]]></name><Point><coordinates>100.5,13.75,0</coordinates></Point></Placemark>
<Placemark><name>แปลงป่า</name><ExtendedData><Data name="x"><value>1</value></Data></ExtendedData>
 <Polygon><outerBoundaryIs><LinearRing><coordinates>
   100,14,0 100.1,14,0 100.1,14.1,0 100,14.1,0 100,14,0
 </coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>100.02,14.02 100.03,14.02 100.03,14.03 100.02,14.02</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark>
<Placemark><name>เส้นทาง</name><LineString><coordinates>99,15 99.5,15.5</coordinates></LineString></Placemark>
</Document></kml>`;

test('KML: names (CDATA + entities), points, polygon outer ring, lines', async () => {
  const r = await importCoordFiles([file('map.kml', KML)]);
  assert.equal(r.places.length, 3);
  assert.equal(r.places[0].name, 'จุด & ฝาย');
  assert.equal(r.places[1].kind, 'polygon');
  assert.equal(r.places[1].ring!.length, 5);
  assert.equal(r.places[2].kind, 'line');
});

test('KMZ (zipped KML) is unzipped and read', async () => {
  const r = await importCoordFiles([file('map.kmz', await zip({ 'doc.kml': KML, 'files/icon.png': new Uint8Array([1, 2, 3]) }))]);
  assert.equal(r.places.length, 3);
  assert.ok(r.formats.includes('KMZ') && r.formats.includes('KML'));
});

test('GPX: waypoints and tracks', async () => {
  const gpx = `<gpx version="1.1"><wpt lat="13.75" lon="100.5"><name>WP1</name></wpt><wpt lon="100.6" lat="13.8"/>
  <trk><name>เดินป่า</name><trkseg><trkpt lat="14" lon="100"></trkpt><trkpt lat="14.1" lon="100.1"/></trkseg></trk></gpx>`;
  const r = await importCoordFiles([file('track.gpx', gpx)]);
  assert.equal(r.places.length, 3);
  assert.equal(r.places[0].name, 'WP1');
  near(r.places[1].lon, 100.6, 1e-9);
  assert.equal(r.places[2].name, 'เดินป่า');
  assert.equal(r.places[2].kind, 'line');
});

// ---------------------------------------------------------------- Excel

function sheetXml(rows: (string | number)[][]) {
  const col = (i: number) => String.fromCharCode(65 + i);
  return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (typeof v === 'number' ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${v}</t></is></c>`)).join('')}</row>`)
    .join('')}</sheetData></worksheet>`;
}

test('Excel .xlsx: shared strings, inline strings, numbers, several sheets', async () => {
  const x = await zip({
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': '<workbook><sheets><sheet name="จุด" sheetId="1" r:id="rId1"/><sheet name="อื่น" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>ชื่อ</t></si><si><r><t>la</t></r><r><t>t</t></r></si><si><t>lon</t></si><si><t>บ้าน &amp; ไร่</t></si></sst>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>13.7563</v></c><c r="C2"><v>100.5018</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>แถว4</t></is></c><c r="C4"><v>101</v></c><c r="B4"><v>14</v></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': sheetXml([['17.1, 99.2 ไม่มีหัวตาราง']]),
  });
  const r = await importCoordFiles([file('points.xlsx', x)]);
  assert.equal(r.places.length, 3, JSON.stringify(r.warnings));
  assert.equal(r.places[0].name, 'บ้าน & ไร่');
  near(r.places[1].lat, 14, 1e-9); near(r.places[1].lon, 101, 1e-9);
  near(r.places[2].lat, 17.1, 1e-9);
  assert.ok(r.formats.includes('Excel'));
});

// ---------------------------------------------------------------- Shapefile

function shpPoints(pts: [number, number][]) {
  const len = 100 + pts.length * (8 + 20);
  const b = new DataView(new ArrayBuffer(len));
  b.setInt32(0, 9994, false); b.setInt32(24, len / 2, false); b.setInt32(28, 1000, true); b.setInt32(32, 1, true);
  let p = 100;
  pts.forEach(([x, y], i) => {
    b.setInt32(p, i + 1, false); b.setInt32(p + 4, 10, false); b.setInt32(p + 8, 1, true); b.setFloat64(p + 12, x, true); b.setFloat64(p + 20, y, true);
    p += 28;
  });
  return new Uint8Array(b.buffer);
}
function shpPolygon(ring: [number, number][]) {
  const content = 44 + 4 + ring.length * 16;
  const len = 100 + 8 + content;
  const b = new DataView(new ArrayBuffer(len));
  b.setInt32(0, 9994, false); b.setInt32(24, len / 2, false); b.setInt32(28, 1000, true); b.setInt32(32, 5, true);
  b.setInt32(100, 1, false); b.setInt32(104, content / 2, false); b.setInt32(108, 5, true);
  b.setInt32(144, 1, true); b.setInt32(148, ring.length, true); b.setInt32(152, 0, true);
  ring.forEach(([x, y], i) => { b.setFloat64(156 + i * 16, x, true); b.setFloat64(164 + i * 16, y, true); });
  return new Uint8Array(b.buffer);
}
function dbf(names: string[], bytesOf = (s: string) => enc(s)) {
  const w = 30;
  const hlen = 32 + 32 + 1, rlen = 1 + w;
  const b = new Uint8Array(hlen + names.length * rlen + 1);
  const dv = new DataView(b.buffer);
  b[0] = 3; dv.setUint32(4, names.length, true); dv.setUint16(8, hlen, true); dv.setUint16(10, rlen, true);
  b.set(enc('NAME'), 32); b[32 + 11] = 'C'.charCodeAt(0); b[32 + 16] = w;
  b[64] = 0x0d;
  names.forEach((n, i) => {
    const o = hlen + i * rlen;
    b[o] = 0x20;
    const nb = bytesOf(n);
    b.fill(0x20, o + 1, o + 1 + w);
    b.set(nb.subarray(0, w), o + 1);
  });
  b[b.length - 1] = 0x1a;
  return b;
}

test('Shapefile (.shp + .dbf + .prj in UTM 47N) inside a .zip', async () => {
  const z = await zip({
    'layer/sites.shp': shpPoints([[668000, 1520000], [662000, 1521000]]),
    'layer/sites.dbf': dbf(['สถานีหนึ่ง', 'Station 2']),
    'layer/sites.prj': 'PROJCS["WGS_1984_UTM_Zone_47N",GEOGCS["GCS_WGS_1984"]]',
    'layer/sites.cpg': 'UTF-8',
  });
  const r = await importCoordFiles([file('sites.zip', z)]);
  assert.equal(r.places.length, 2, JSON.stringify(r.warnings));
  assert.equal(r.places[0].name, 'สถานีหนึ่ง');
  near(r.places[1].lon, 100.5, 0.02); near(r.places[1].lat, 13.75, 0.02);
  assert.ok(r.formats.includes('Shapefile'));
});

test('Shapefile polygon picked as separate files, WGS84 without .prj', async () => {
  const ring: [number, number][] = [[100, 14], [100.1, 14], [100.1, 14.1], [100, 14.1], [100, 14]];
  const r = await importCoordFiles([file('plots.shp', shpPolygon(ring)), file('plots.dbf', dbf(['แปลง A']))]);
  assert.equal(r.places.length, 1);
  assert.equal(r.places[0].kind, 'polygon');
  assert.equal(r.places[0].name, 'แปลง A');
});

// ---------------------------------------------------------------- helpers

test('placePolygon: point boxes, row sizes, line extents; swap; duplicates; old .xls rejected', async () => {
  const r = importCoordText('name,lat,lon,km\nA,13,100,4\nB,13.5,100.5,\nA2,13,100,\n');
  assert.equal(r.places.length, 2); // A2 duplicates A
  const pa = placePolygon(r.places[0], 2).coordinates[0];
  near((pa[2][1] - pa[0][1]) * 110.574, 4, 1e-3);
  const pb = placePolygon(r.places[1], 2).coordinates[0];
  near((pb[2][1] - pb[0][1]) * 110.574, 2, 1e-3);
  const line = importCoordText('LINESTRING(100 13, 100.001 13.001)').places[0];
  const pl = placePolygon(line, 5).coordinates[0];
  near((pl[2][1] - pl[0][1]) * 110.574, 5, 1e-3);
  assert.equal(swapLatLon(r.places[0]), null); // lon 100 cannot become a latitude
  const sw = swapLatLon(importCoordText('13.5, 45.25').places[0])!;
  near(sw.lat, 45.25, 1e-9); near(sw.lon, 13.5, 1e-9);
  const xls = await importCoordFiles([file('old.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]))]);
  assert.equal(xls.places.length, 0);
  assert.ok(xls.warnings[0].en.includes('.xls'));
});
