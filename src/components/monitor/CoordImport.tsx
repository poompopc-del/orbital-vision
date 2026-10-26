// Import many watch points / areas at once from files (CSV, Excel, KML/KMZ, GeoJSON, GPX, Shapefile, WKT)
// or pasted text, preview them on the globe, pick which to keep, then add them all to the watchlist.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../../i18n';
import { Cesium, flyToBbox, flyToPolygon } from '../../lib/cesium';
import {
  ACCEPT, approxKm2, bbox, filesFromInput, importCoordFiles, importCoordText, placePolygon, swapLatLon, TEMPLATE_CSV,
  type ImportedPlace, type ImportResult, type InputFile,
} from '../../lib/coordImport';
import { PURPOSES, REGIONS, SATELLITES, type Purpose, type Region, type SensorMode } from '../../lib/monitor';
import { Badge, Button, Field, Input, Notice, Panel, Select, Spinner, cx } from '../ui';

const useL = () => {
  const lang = useLang((s) => s.lang);
  return (th: string, en: string) => (lang === 'th' ? th : en);
};

export interface ImportedArea { name: string; geometry: GeoJSON.Polygon }

const ZONES = [46, 47, 48, 49];
const SHOW_MAX = 300; // rows rendered in the list (all of them are still added)

export default function CoordImport({
  viewer, onAdd,
}: {
  viewer: Cesium.Viewer | null;
  onAdd: (areas: ImportedArea[], region: Region, purpose: Purpose, freq: number, sat: SensorMode) => void;
}) {
  const L = useL();
  const lang = useLang((s) => s.lang);
  const fileRef = useRef<HTMLInputElement>(null);
  const [src, setSrc] = useState<{ files: InputFile[] } | { text: string } | null>(null);
  const [paste, setPaste] = useState<string | null>(null);
  const [zone, setZone] = useState(47);
  const [res, setRes] = useState<ImportResult | null>(null);
  const [places, setPlaces] = useState<ImportedPlace[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState(false);
  const [pointKm, setPointKm] = useState(2);
  const [prefix, setPrefix] = useState('');
  const [region, setRegion] = useState<Region>('TH');
  const [purpose, setPurpose] = useState<Purpose>('clearing');
  const [freq, setFreq] = useState(7);
  const [sat, setSat] = useState<SensorMode>('auto');
  const [filter, setFilter] = useState('');

  // (re)parse whenever the input or the assumed UTM zone changes
  useEffect(() => {
    if (!src) return;
    let alive = true;
    setBusy(true);
    setErr('');
    const opts = { utmZone: zone, utmNorth: true };
    const run = 'files' in src ? importCoordFiles(src.files, opts) : Promise.resolve(importCoordText(src.text, opts, L('จุดที่', 'Point')));
    run
      .then((r) => {
        if (!alive) return;
        setRes(r);
        setPlaces(r.places);
        setSel(new Set(r.places.map((p) => p.id)));
        if (!r.places.length) setErr(L('ไม่พบพิกัดที่อ่านได้', 'No readable coordinates found'));
      })
      .catch((e) => alive && setErr(String(e?.message ?? e)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, zone]);

  const polys = useMemo(() => new Map(places.map((p) => [p.id, placePolygon(p, pointKm)])), [places, pointKm]);

  // fly to everything once per new result
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !places.length) return;
    const [w, s, e, n] = bbox([...polys.values()].flatMap((g) => g.coordinates[0] as [number, number][]));
    flyToBbox(viewer, w, s, e, n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, res]);

  // preview on the globe: selected = cyan, left out = grey
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !places.length) return;
    const ds = new Cesium.CustomDataSource('coord-import');
    const on = Cesium.Color.fromCssColorString('#22d3ee'), off = Cesium.Color.fromCssColorString('#94a3b8');
    places.slice(0, 3000).forEach((p) => {
      const g = polys.get(p.id)!;
      const c = sel.has(p.id) ? on : off;
      ds.entities.add({ id: `imp:${p.id}`, polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray(g.coordinates[0].flat()), material: c.withAlpha(sel.has(p.id) ? 0.22 : 0.06), height: 0 } });
      ds.entities.add({ polyline: { positions: g.coordinates[0].map(([x, y]) => Cesium.Cartesian3.fromDegrees(x, y)), width: 1.5, material: c } });
      if (p.kind === 'point') ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat), point: { pixelSize: 6, color: c, outlineColor: Cesium.Color.BLACK, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    });
    void viewer.dataSources.add(ds);
    viewer.scene.requestRender();
    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, places, polys, sel]);

  const pickFiles = async (list: FileList | File[] | null | undefined) => {
    if (!list || !list.length) return;
    setErr('');
    try {
      const files = await filesFromInput(list);
      const big = files.find((f) => f.bytes.length > 60 * 1024 * 1024);
      if (big) return setErr(L(`ไฟล์ ${big.name} ใหญ่เกิน 60 MB`, `${big.name} is larger than 60 MB`));
      setSrc({ files });
      setPaste(null);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  };

  const reset = () => {
    setSrc(null);
    setRes(null);
    setPlaces([]);
    setSel(new Set());
    setErr('');
    setFilter('');
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? places.filter((p) => p.name.toLowerCase().includes(q) || p.source.toLowerCase().includes(q)) : places;
  }, [places, filter]);

  const chosen = places.filter((p) => sel.has(p.id));
  const totalKm2 = chosen.reduce((a, p) => a + approxKm2(polys.get(p.id)!), 0);
  const counts = { point: chosen.filter((p) => p.kind === 'point').length, polygon: chosen.filter((p) => p.kind === 'polygon').length, line: chosen.filter((p) => p.kind === 'line').length };
  const swappable = places.length > 0 && places.every((p) => Math.abs(p.lon) <= 90);

  const add = () => {
    const pre = prefix.trim();
    onAdd(chosen.map((p) => ({ name: pre ? `${pre} ${p.name}` : p.name, geometry: polys.get(p.id)! })), region, purpose, freq, sat);
    reset();
  };

  const downloadTemplate = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' }));
    a.download = 'orbital-vision-coordinates-template.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const kindLabel = (k: ImportedPlace['kind']) => (k === 'point' ? L('จุด', 'point') : k === 'polygon' ? L('แปลง', 'polygon') : L('เส้น', 'line'));

  return (
    <Panel title={L('นำเข้าพิกัดจากไฟล์ / ข้อความ', 'Import coordinates from files / text')}>
      {!res && (
        <>
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); void pickFiles(e.dataTransfer.files); }}
            onClick={() => fileRef.current?.click()}
            className={cx('cursor-pointer rounded border border-dashed px-3 py-4 text-center transition', drag ? 'border-cyan-400 bg-cyan-400/10' : 'border-line hover:border-cyan-400/50')}
          >
            <div className="text-xs text-slate-200">{busy ? <Spinner /> : L('ลากไฟล์มาวาง หรือคลิกเพื่อเลือก (เลือกได้หลายไฟล์)', 'Drop files here or click to choose (several at once is fine)')}</div>
            <div className="mt-1 text-[10px] leading-relaxed text-muted">
              CSV · Excel (.xlsx) · KML / KMZ · GeoJSON · GPX · Shapefile (.zip {L('หรือ', 'or')} .shp+.dbf+.prj) · WKT · TXT
            </div>
            <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { const f = e.target.files ? [...e.target.files] : []; e.target.value = ''; void pickFiles(f); }} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Button onClick={() => setPaste(paste == null ? '' : null)} variant={paste != null ? 'active' : 'ghost'}>{L('วางพิกัดเป็นข้อความ', 'Paste coordinates')}</Button>
            <Button onClick={downloadTemplate}>{L('ไฟล์ตัวอย่าง CSV', 'CSV template')}</Button>
          </div>
          {paste != null && (
            <div className="mt-1.5 space-y-1">
              <textarea
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                rows={6}
                placeholder={L(
                  `หนึ่งบรรทัดต่อหนึ่งจุด เช่น\nฝายบ้านหนองบัว 13.7563, 100.5018\n13°45'22"N 100°30'06"E\n47P 668000 1520000\nhttps://maps.google.com/?q=14.02,99.53`,
                  `One place per line, e.g.\nCheck dam 13.7563, 100.5018\n13°45'22"N 100°30'06"E\n47P 668000 1520000\nhttps://maps.google.com/?q=14.02,99.53`,
                )}
                className="w-full rounded border border-line bg-ink-900 px-2 py-1.5 font-mono text-[11px] text-white placeholder:text-muted focus:border-cyan-400/60 focus:outline-none"
              />
              <Button variant="primary" className="w-full" disabled={!paste.trim() || busy} onClick={() => setSrc({ text: paste })}>{L('อ่านพิกัด', 'Read coordinates')}</Button>
            </div>
          )}
          <p className="mt-1.5 text-[10px] leading-relaxed text-muted">
            {L(
              'ตาราง (CSV/Excel) ต้องมีหัวคอลัมน์ เช่น name, lat, lon (หรือ ชื่อ, ละติจูด, ลองจิจูด) · รองรับองศาทศนิยม, องศา-ลิปดา-ฟิลิปดา, UTM (WGS84 / Indian 1975), Web Mercator และลิงก์ Google Maps · จุดจะถูกขยายเป็นกรอบสี่เหลี่ยมตามขนาดที่เลือก แปลงใช้รูปร่างจริง',
              'Tables (CSV/Excel) need a header row such as name, lat, lon · decimal degrees, deg-min-sec, UTM (WGS84 / Indian 1975), Web Mercator and Google Maps links are understood · points become square boxes of the chosen size; polygons keep their shape',
            )}
          </p>
        </>
      )}

      {err && <p className="mt-1.5 text-[11px] text-bad">{err}</p>}

      {res && places.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-200">
            {busy && <Spinner />}
            <span>{L(`พบ ${places.length} รายการ`, `${places.length} found`)}</span>
            {res.formats.map((f) => <Badge key={f} tone="cyan">{f}</Badge>)}
            <button className="ml-auto text-[10px] text-muted hover:text-white" onClick={reset}>{L('เริ่มใหม่', 'Start over')}</button>
          </div>

          {res.warnings.length > 0 && (
            <Notice tone="warn">
              <ul className="list-disc space-y-0.5 pl-4">{res.warnings.map((w, i) => <li key={i}>{lang === 'th' ? w.th : w.en}</li>)}</ul>
            </Notice>
          )}

          {res.usedDefaultZone && (
            <Field label={L('โซน UTM ของค่าที่ไม่ระบุโซน', 'UTM zone for values without one')}>
              <Select value={zone} onChange={(e) => setZone(+e.target.value)}>
                {ZONES.map((z) => <option key={z} value={z}>{z}N{z === 47 ? L(' (ไทยฝั่งตะวันตกของ 102°E)', ' (Thailand west of 102°E)') : z === 48 ? L(' (ไทยฝั่งตะวันออกของ 102°E)', ' (Thailand east of 102°E)') : ''}</option>)}
              </Select>
            </Field>
          )}

          <div className="flex flex-wrap items-center gap-1">
            <Button onClick={() => setSel(new Set(places.map((p) => p.id)))}>{L('เลือกทั้งหมด', 'Select all')}</Button>
            <Button onClick={() => setSel(new Set())}>{L('ไม่เลือก', 'None')}</Button>
            {swappable && (
              <Button onClick={() => setPlaces((l) => l.map((p) => swapLatLon(p) ?? p))} title={L('ใช้เมื่อจุดไปตกผิดที่เพราะไฟล์ใส่ lon,lat กลับกัน', 'Use when points land in the wrong place because the file has lon,lat reversed')}>
                ⇄ {L('สลับ lat/lon', 'Swap lat/lon')}
              </Button>
            )}
          </div>
          {places.length > 8 && <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={L('กรองตามชื่อ / ไฟล์', 'Filter by name / file')} className="!py-1 text-xs" />}

          <ul className="max-h-56 overflow-y-auto rounded border border-line scroll-thin">
            {shown.slice(0, SHOW_MAX).map((p) => (
              <li key={p.id} className="flex items-center gap-1.5 border-b border-white/5 px-2 py-1 text-xs last:border-0">
                <input
                  type="checkbox"
                  checked={sel.has(p.id)}
                  onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })}
                  className="accent-cyan-400"
                />
                <button className="min-w-0 flex-1 text-left" onClick={() => viewer && !viewer.isDestroyed() && flyToPolygon(viewer, polys.get(p.id)!)} title={p.source}>
                  <div className="truncate text-slate-200">{p.name}</div>
                  <div className="truncate font-mono text-[10px] text-muted">{p.lat.toFixed(5)}, {p.lon.toFixed(5)}</div>
                </button>
                <span className="shrink-0 text-[10px] text-muted">{kindLabel(p.kind)}{p.sizeKm ? ` ${p.sizeKm} km` : ''}</span>
              </li>
            ))}
            {shown.length > SHOW_MAX && <li className="px-2 py-1 text-[10px] text-muted">{L(`… และอีก ${shown.length - SHOW_MAX} รายการ (แสดงบนแผนที่)`, `… and ${shown.length - SHOW_MAX} more (shown on the map)`)}</li>}
          </ul>

          <div className="grid grid-cols-2 gap-1.5">
            <Field label={L('ขนาดกรอบรอบจุด', 'Box around points')}>
              <Select value={pointKm} onChange={(e) => setPointKm(+e.target.value)}>
                {[0.5, 1, 2, 5, 10].map((k) => <option key={k} value={k}>{k} × {k} km</option>)}
              </Select>
            </Field>
            <Field label={L('คำนำหน้าชื่อ (ถ้ามี)', 'Name prefix (optional)')}><Input value={prefix} onChange={(e) => setPrefix(e.target.value)} /></Field>
            <Field label={L('รอบตรวจ', 'Cycle')}>
              <Select value={freq} onChange={(e) => setFreq(+e.target.value)}>{[7, 14, 30].map((d) => <option key={d} value={d}>{L(`ทุก ${d} วัน`, `every ${d} days`)}</option>)}</Select>
            </Field>
            <Field label={L('พื้นที่', 'Region')}>
              <Select value={region} onChange={(e) => setRegion(e.target.value as Region)}>{REGIONS.map((r) => <option key={r.id} value={r.id}>{L(r.labelTh, r.label)}</option>)}</Select>
            </Field>
            <Field label={L('สิ่งที่เฝ้าดู', 'Watch for')}>
              <Select value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>{PURPOSES.map((p) => <option key={p.id} value={p.id}>{L(p.labelTh, p.label)}</option>)}</Select>
            </Field>
            <Field label={L('ดาวเทียม', 'Satellite')}>
              <Select value={sat} onChange={(e) => setSat(e.target.value as SensorMode)}>{SATELLITES.map((x) => <option key={x.id} value={x.id}>{L(x.th, x.en)}</option>)}</Select>
            </Field>
          </div>
          <p className="text-[10px] text-muted">
            {L(
              `เลือก ${chosen.length} รายการ (จุด ${counts.point} · แปลง ${counts.polygon}${counts.line ? ` · เส้น ${counts.line} — ใช้กรอบครอบเส้น` : ''}) · รวมประมาณ ${totalKm2.toLocaleString(undefined, { maximumFractionDigits: 1 })} km²`,
              `${chosen.length} selected (${counts.point} points · ${counts.polygon} polygons${counts.line ? ` · ${counts.line} lines — their extent is used` : ''}) · about ${totalKm2.toLocaleString(undefined, { maximumFractionDigits: 1 })} km² in total`,
            )}
          </p>
          {chosen.length > 100 && <Notice tone="warn">{L('พื้นที่จำนวนมาก การตรวจแต่ละรอบจะใช้เวลานานและเรียกข้อมูลภาพหลายครั้ง', 'Many areas — each check round will take a while and fetch a lot of imagery')}</Notice>}
          {chosen.some((p) => approxKm2(polys.get(p.id)!) > 100) && <Notice tone="warn">{L('บางแปลงใหญ่กว่า ~100 km² ภาพจะถูกย่อก่อนเปรียบเทียบ (ละเอียดน้อยกว่า 10 m) — ถ้าต้องการรายละเอียด แบ่งเป็นแปลงย่อย', 'Some areas are larger than ~100 km² — imagery is downsampled before comparison (coarser than 10 m); split them if you need detail')}</Notice>}
          <Button variant="primary" className="w-full" disabled={!chosen.length || busy} onClick={add}>
            {L(`เพิ่ม ${chosen.length} พื้นที่เข้ารายการเฝ้าระวัง`, `Add ${chosen.length} area(s) to the watchlist`)}
          </Button>
        </div>
      )}
    </Panel>
  );
}
