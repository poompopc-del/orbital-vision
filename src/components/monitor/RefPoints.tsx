// Imported reference points on the map (boundary pillars, hills, passes) + the import box.
// <RefPointsLayer> draws them and stays mounted; <RefPointsBox> is the settings UI.
import { useEffect, useState } from 'react';
import { useLang } from '../../i18n';
import { Cesium } from '../../lib/cesium';
import { clearRefPoints, getRefSet, importRefFiles, onRefChange, REF_KINDS, type RefSet } from '../../lib/refpoints';
import { cx } from '../ui';

const useL = () => {
  const lang = useLang((s) => s.lang);
  return (th: string, en: string) => (lang === 'th' ? th : en);
};

// display settings, kept per browser
const SHOW_KEY = 'ov.refpoints.show.v1';
type Show = { points: boolean; labels: boolean };
const readShow = (): Show => {
  try {
    return { points: true, labels: true, ...JSON.parse(localStorage.getItem(SHOW_KEY) || '{}') };
  } catch {
    return { points: true, labels: true };
  }
};
const showListeners = new Set<() => void>();
function useShow(): [Show, (s: Partial<Show>) => void] {
  const [s, setS] = useState(readShow);
  useEffect(() => {
    const f = () => setS(readShow());
    showListeners.add(f);
    return () => void showListeners.delete(f);
  }, []);
  const set = (p: Partial<Show>) => {
    try {
      localStorage.setItem(SHOW_KEY, JSON.stringify({ ...readShow(), ...p }));
    } catch {
      /* storage blocked: this session only */
    }
    showListeners.forEach((f) => f());
  };
  return [s, set];
}
function useRefSet() {
  const [set, setSet] = useState<RefSet | null>(null);
  useEffect(() => {
    const load = () => void getRefSet().then(setSet);
    load();
    return onRefChange(load);
  }, []);
  return set;
}

export function RefPointsLayer({ viewer }: { viewer: Cesium.Viewer | null }) {
  const set = useRefSet();
  const [show] = useShow();
  useEffect(() => {
    if (!viewer || !set?.points.length || !show.points) return;
    const ds = new Cesium.CustomDataSource('ref-points');
    const colours = Object.fromEntries(REF_KINDS.map((k) => [k.id, Cesium.Color.fromCssColorString(k.color)]));
    for (const p of set.points) {
      ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
        point: { pixelSize: p.kind === 'marker' ? 8 : 6, color: colours[p.kind], outlineColor: Cesium.Color.BLACK, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: show.labels
          ? {
              text: p.name, font: '12px "Noto Sans Thai", sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE, horizontalOrigin: Cesium.HorizontalOrigin.LEFT, pixelOffset: new Cesium.Cartesian2(8, 0),
              // names only when zoomed in (≲ 150 km camera height), otherwise a long border is a wall of text
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 150_000), disableDepthTestDistance: Number.POSITIVE_INFINITY,
            }
          : undefined,
      });
    }
    void viewer.dataSources.add(ds);
    viewer.scene.requestRender();
    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, set, show.points, show.labels]);
  return null;
}

export function RefPointsBox() {
  const L = useL();
  const set = useRefSet();
  const [show, setShow] = useShow();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState('');
  const doImport = async (list: File[]) => {
    setBusy(true);
    setErr('');
    setWarn('');
    try {
      const r = await importRefFiles(list);
      if (r.warnings.length) setWarn(r.warnings.map((w) => L(w.th, w.en)).join(' · '));
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  const counts = REF_KINDS.map((k) => ({ ...k, n: set?.points.filter((p) => p.kind === k.id).length ?? 0 })).filter((k) => k.n);
  return (
    <div className="rounded border border-line p-1.5 text-[10px] leading-relaxed">
      <div className="font-semibold">{L('จุดอ้างอิง (หลักเขต เนิน ช่องทาง)', 'Reference points (pillars, hills, passes)')}</div>
      {set ? (
        <>
          <div className="text-ok">✓ {set.points.length.toLocaleString()} {L('จุด', 'points')} · {set.name}</div>
          <div className="flex flex-wrap gap-x-2">
            {counts.map((k) => <span key={k.id} className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full" style={{ background: k.color }} />{L(k.th, k.en)} {k.n}</span>)}
          </div>
          <div className="mt-0.5 flex gap-3">
            <label className="flex items-center gap-1"><input type="checkbox" checked={show.points} onChange={(e) => setShow({ points: e.target.checked })} />{L('แสดงบนแผนที่', 'Show on map')}</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={show.labels} disabled={!show.points} onChange={(e) => setShow({ labels: e.target.checked })} />{L('ชื่อจุด', 'Names')}</label>
          </div>
          <div className="text-muted">{L('ผลตรวจครั้งต่อไปจะบอกตำแหน่งเทียบจุดที่ใกล้ที่สุด (ไม่เกิน 15 กม.) · เก็บในเบราว์เซอร์นี้เท่านั้น ไม่ได้อัปโหลด', 'New results describe each detection from the nearest point (≤ 15 km) · kept in this browser only, never uploaded')}</div>
          <button className="text-bad hover:underline" onClick={() => void clearRefPoints()}>{L('ลบจุดอ้างอิงทั้งหมด', 'Remove all reference points')}</button>
        </>
      ) : (
        <div className="text-muted">{L('นำเข้ารายการจุดจากแผนที่ของหน่วย เพื่อแสดงบนแผนที่และใช้บอกตำแหน่งผลตรวจ เช่น “1.6 กม. ทางทิศตะวันตกของหลักเขตหมายเลข 7” · เก็บในเบราว์เซอร์นี้เท่านั้น', 'Import your own list of points to show them and describe detections, e.g. “1.6 km west of pillar 7” · kept in this browser only')}</div>
      )}
      <label className={cx('mt-1 inline-block cursor-pointer rounded border border-line px-2 py-0.5 hover:border-cyan-400/50', busy && 'opacity-50')}>
        {busy ? L('กำลังนำเข้า…', 'Importing…') : set ? L('นำเข้าไฟล์ใหม่แทน', 'Replace file') : L('นำเข้าจุดอ้างอิง', 'Import points')}
        <input type="file" multiple accept=".csv,.tsv,.txt,.xlsx,.json,.geojson,.kml,.kmz,.gpx,.zip,.shp,.dbf,.prj,.cpg,.wkt" className="hidden" disabled={busy} onChange={(e) => { const f = e.target.files ? [...e.target.files] : []; e.target.value = ''; if (f.length) void doImport(f); }} />
      </label>
      <div className="text-[9px] text-muted">{L('CSV/Excel (ชื่อ, ละติจูด, ลองจิจูด หรือ UTM), KML/KMZ, GeoJSON, GPX, Shapefile · ชนิดจุดดูจากชื่อ: “หลักเขต…”, “เนิน…/ภู…”, “ช่อง…”', 'CSV/Excel (name, lat, lon or UTM), KML/KMZ, GeoJSON, GPX, Shapefile · kind from the name: “หลักเขต…”, “เนิน…/ภู…”, “ช่อง…”')}</div>
      {warn && <div className="text-warn">{warn}</div>}
      {err && <div className="text-bad">{err}</div>}
    </div>
  );
}
