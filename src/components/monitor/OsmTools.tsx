// OpenStreetMap tools for the watch map (© OpenStreetMap contributors, ODbL):
//  · base map: satellite imagery (default) or the OSM street map
//  · roads / tracks / paths and village / place names in the current view, via the public Overpass API
//    (loaded only when zoomed in, re-loaded when the view moves outside what was loaded)
//  · place search (Nominatim, Thailand + Cambodia) that flies the map there
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useLang } from '../../i18n';
import { Cesium } from '../../lib/cesium';
import { overpass } from '../../lib/overpass';
import { geocode, type GeocodeHit } from '../../lib/geo';
import { cx } from '../ui';

const useL = () => {
  const lang = useLang((s) => s.lang);
  return (th: string, en: string) => (lang === 'th' ? th : en);
};

// ---------------------------------------------------------------- settings (remembered in this browser)
export interface OsmPrefs {
  basemap: 'imagery' | 'osm';
  roads: boolean;
  places: boolean;
}
const OSM_DEFAULT: OsmPrefs = { basemap: 'imagery', roads: false, places: false };
const KEY = 'ov.monitor.osm.v1';
const loadPrefs = (): OsmPrefs => {
  try {
    return { ...OSM_DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return OSM_DEFAULT;
  }
};
export const useOsm = create<{ prefs: OsmPrefs; set: (p: Partial<OsmPrefs>) => void }>((set) => ({
  prefs: loadPrefs(),
  set: (p) =>
    set((s) => {
      const prefs = { ...s.prefs, ...p };
      try {
        localStorage.setItem(KEY, JSON.stringify(prefs));
      } catch {
        /* storage unavailable */
      }
      return { prefs };
    }),
}));

// ---------------------------------------------------------------- styles
type RoadClass = 'major' | 'minor' | 'local' | 'track' | 'path';
const ROAD_CLASS: Record<string, RoadClass> = {
  motorway: 'major', trunk: 'major', primary: 'major', motorway_link: 'major', trunk_link: 'major', primary_link: 'major',
  secondary: 'minor', tertiary: 'minor', secondary_link: 'minor', tertiary_link: 'minor',
  unclassified: 'local', residential: 'local', service: 'local', living_street: 'local',
  track: 'track',
  path: 'path', footway: 'path', bridleway: 'path', cycleway: 'path', steps: 'path',
};
const ROAD_STYLE: Record<RoadClass, { color: string; width: number; dashed: boolean; th: string; en: string }> = {
  major: { color: '#f97316', width: 3.5, dashed: false, th: 'ถนนสายหลัก', en: 'Main road' },
  minor: { color: '#fde047', width: 2.5, dashed: false, th: 'ถนนสายรอง', en: 'Secondary road' },
  local: { color: '#f8fafc', width: 1.6, dashed: false, th: 'ถนนในชุมชน', en: 'Local road' },
  track: { color: '#d6a35c', width: 1.8, dashed: true, th: 'ทางลูกรัง/ทางเกวียน', en: 'Track (unpaved)' },
  path: { color: '#a3e635', width: 1.4, dashed: true, th: 'ทางเดินเท้า', en: 'Footpath' },
};
type PlaceKind = 'town' | 'village' | 'hamlet' | 'border' | 'school' | 'temple' | 'police' | 'health';
const PLACE_STYLE: Record<PlaceKind, { px: number; color: string; prefix: string; maxM: number }> = {
  town: { px: 16, color: '#ffffff', prefix: '', maxM: 4e5 },
  village: { px: 14, color: '#fef3c7', prefix: '', maxM: 8e4 },
  hamlet: { px: 12, color: '#fde68a', prefix: '', maxM: 3e4 },
  border: { px: 14, color: '#fca5a5', prefix: '🛂 ', maxM: 2e5 },
  police: { px: 12, color: '#93c5fd', prefix: '👮 ', maxM: 4e4 },
  school: { px: 12, color: '#c4b5fd', prefix: '🏫 ', maxM: 3e4 },
  temple: { px: 12, color: '#fcd34d', prefix: '🛕 ', maxM: 3e4 },
  health: { px: 12, color: '#86efac', prefix: '🏥 ', maxM: 3e4 },
};

// how far in the view may be before loading (degrees of the view's larger side)
const ROADS_MAX_SPAN = 0.4; // ≈ 45 km
const PLACES_MAX_SPAN = 1.6; // ≈ 180 km

type BB = [number, number, number, number]; // w s e n
const inside = (a: BB, b: BB) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];
const pad = (b: BB, f: number): BB => {
  const dx = (b[2] - b[0]) * f, dy = (b[3] - b[1]) * f;
  return [b[0] - dx, b[1] - dy, b[2] + dx, b[3] + dy];
};
const span = (b: BB) => Math.max(b[2] - b[0], b[3] - b[1]);
const nameOf = (t: Record<string, string>) => t['name:th'] || t.name || t['name:en'] || '';

function viewBox(v: Cesium.Viewer): BB | null {
  const r = v.camera.computeViewRectangle(v.scene.globe.ellipsoid);
  if (!r) return null;
  const d = Cesium.Math.toDegrees;
  return [d(r.west), d(r.south), d(r.east), d(r.north)];
}

/** The current view rectangle, updated when the camera stops moving. */
function useViewBox(viewer: Cesium.Viewer | null, active: boolean) {
  const [box, setBox] = useState<BB | null>(null);
  useEffect(() => {
    if (!viewer || !active) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const upd = () => {
      clearTimeout(t);
      t = setTimeout(() => !viewer.isDestroyed() && setBox(viewBox(viewer)), 600);
    };
    upd();
    const off = viewer.camera.moveEnd.addEventListener(upd);
    return () => {
      clearTimeout(t);
      off();
    };
  }, [viewer, active]);
  return box;
}

type Status = { state: 'idle' | 'zoom' | 'loading' | 'ok' | 'error'; n?: number; msg?: string };

// ---------------------------------------------------------------- roads
function useRoads(viewer: Cesium.Viewer | null, on: boolean, box: BB | null, setStatus: (s: Status) => void) {
  const loaded = useRef<{ box: BB; prim: Cesium.PolylineCollection } | null>(null);
  const clear = () => {
    if (loaded.current && viewer && !viewer.isDestroyed()) viewer.scene.primitives.remove(loaded.current.prim);
    loaded.current = null;
  };
  useEffect(() => () => clear(), [viewer]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!on) {
      clear();
      viewer?.scene.requestRender();
      return setStatus({ state: 'idle' });
    }
    if (!viewer || !box) return;
    if (span(box) > ROADS_MAX_SPAN) return setStatus({ state: 'zoom' });
    if (loaded.current && inside(box, loaded.current.box)) return;
    const ask = pad(box, 0.3);
    const ctrl = new AbortController();
    setStatus({ state: 'loading' });
    const [w, s, e, n] = ask;
    const q = `[out:json][timeout:40];way["highway"~"^(${Object.keys(ROAD_CLASS).join('|')})$"](${s},${w},${n},${e});out geom tags qt;`;
    overpass(q, 50000, ctrl.signal)
      .then((j) => {
        if (ctrl.signal.aborted || viewer.isDestroyed()) return;
        const prim = new Cesium.PolylineCollection();
        const mats = new Map<RoadClass, Cesium.Material>();
        const mat = (c: RoadClass) => {
          let m = mats.get(c);
          if (!m) {
            const st = ROAD_STYLE[c];
            const color = Cesium.Color.fromCssColorString(st.color);
            m = st.dashed ? Cesium.Material.fromType('PolylineDash', { color, dashLength: 10 }) : Cesium.Material.fromType('PolylineOutline', { color, outlineColor: Cesium.Color.BLACK.withAlpha(0.6), outlineWidth: 1 });
            mats.set(c, m);
          }
          return m;
        };
        let count = 0;
        // draw minor classes first so main roads sit on top
        const order: RoadClass[] = ['path', 'track', 'local', 'minor', 'major'];
        const els = (j.elements || []).filter((el: any) => Array.isArray(el.geometry) && el.geometry.length > 1);
        for (const c of order)
          for (const el of els) {
            if (ROAD_CLASS[el.tags?.highway] !== c) continue;
            const st = ROAD_STYLE[c];
            prim.add({ positions: Cesium.Cartesian3.fromDegreesArray(el.geometry.flatMap((g: any) => [g.lon, g.lat])), width: st.width + (st.dashed ? 0 : 1), material: mat(c) });
            count++;
          }
        clear();
        viewer.scene.primitives.add(prim);
        loaded.current = { box: ask, prim };
        viewer.scene.requestRender();
        setStatus({ state: 'ok', n: count });
      })
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setStatus({ state: 'error', msg: String((err as Error)?.message ?? err) });
      });
    return () => ctrl.abort();
  }, [viewer, on, box?.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ---------------------------------------------------------------- places
function placeKind(t: Record<string, string>): PlaceKind | null {
  if (t.barrier === 'border_control') return 'border';
  if (t.place === 'city' || t.place === 'town') return 'town';
  if (t.place === 'village' || t.place === 'suburb') return 'village';
  if (t.place === 'hamlet' || t.place === 'isolated_dwelling') return 'hamlet';
  if (t.amenity === 'police') return 'police';
  if (t.amenity === 'school') return 'school';
  if (t.amenity === 'place_of_worship') return 'temple';
  if (t.amenity === 'hospital' || t.amenity === 'clinic') return 'health';
  return null;
}

function usePlaces(viewer: Cesium.Viewer | null, on: boolean, box: BB | null, setStatus: (s: Status) => void) {
  const loaded = useRef<{ box: BB; ds: Cesium.CustomDataSource } | null>(null);
  const clear = () => {
    if (loaded.current && viewer && !viewer.isDestroyed()) viewer.dataSources.remove(loaded.current.ds, true);
    loaded.current = null;
  };
  useEffect(() => () => clear(), [viewer]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!on) {
      clear();
      viewer?.scene.requestRender();
      return setStatus({ state: 'idle' });
    }
    if (!viewer || !box) return;
    if (span(box) > PLACES_MAX_SPAN) return setStatus({ state: 'zoom' });
    if (loaded.current && inside(box, loaded.current.box)) return;
    const ask = pad(box, 0.3);
    const ctrl = new AbortController();
    setStatus({ state: 'loading' });
    const [w, s, e, n] = ask;
    const bb = `(${s},${w},${n},${e})`;
    const q = `[out:json][timeout:40];(
node["place"~"^(city|town|village|suburb|hamlet|isolated_dwelling)$"]${bb};
nwr["barrier"="border_control"]${bb};
nwr["amenity"~"^(police|school|place_of_worship|hospital|clinic)$"]["name"]${bb};
);out center tags qt;`;
    overpass(q, 50000, ctrl.signal)
      .then((j) => {
        if (ctrl.signal.aborted || viewer.isDestroyed()) return;
        const ds = new Cesium.CustomDataSource('osm-places');
        const black = Cesium.Color.BLACK;
        let count = 0;
        for (const el of j.elements || []) {
          const t = el.tags || {};
          const k = placeKind(t);
          const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
          if (!k || lat == null || lon == null) continue;
          const nm = nameOf(t) || (k === 'border' ? 'ด่าน' : '');
          if (!nm) continue;
          const st = PLACE_STYLE[k];
          const col = Cesium.Color.fromCssColorString(st.color);
          const dist = new Cesium.DistanceDisplayCondition(0, st.maxM);
          ds.entities.add({
            position: Cesium.Cartesian3.fromDegrees(lon, lat),
            point: { pixelSize: k === 'town' ? 7 : 5, color: col, outlineColor: black, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: dist },
            label: {
              text: st.prefix + nm,
              font: `bold ${st.px}px "IBM Plex Sans Thai", "Sarabun", "Tahoma", sans-serif`,
              fillColor: col,
              outlineColor: black,
              outlineWidth: 4,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              showBackground: true,
              backgroundColor: Cesium.Color.fromCssColorString('#0b0f12').withAlpha(0.7),
              backgroundPadding: new Cesium.Cartesian2(5, 3),
              pixelOffset: new Cesium.Cartesian2(0, -14),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: dist,
            },
          });
          count++;
        }
        clear();
        void viewer.dataSources.add(ds);
        loaded.current = { box: ask, ds };
        viewer.scene.requestRender();
        setStatus({ state: 'ok', n: count });
      })
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setStatus({ state: 'error', msg: String((err as Error)?.message ?? err) });
      });
    return () => ctrl.abort();
  }, [viewer, on, box?.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ---------------------------------------------------------------- base map
function useBasemap(viewer: Cesium.Viewer | null, mode: OsmPrefs['basemap']) {
  useEffect(() => {
    if (!viewer || mode !== 'osm') return;
    const p = new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' });
    // just above the satellite base (index 0), below imagery results and swipe layers added later
    const layer = viewer.imageryLayers.addImageryProvider(p, Math.min(1, viewer.imageryLayers.length));
    viewer.scene.requestRender();
    return () => {
      if (!viewer.isDestroyed()) {
        viewer.imageryLayers.remove(layer, true);
        viewer.scene.requestRender();
      }
    };
  }, [viewer, mode]);
}

// ---------------------------------------------------------------- UI
export default function OsmTools({ viewer }: { viewer: Cesium.Viewer | null }) {
  const L = useL();
  const lang = useLang((s) => s.lang);
  const prefs = useOsm((s) => s.prefs);
  const setPrefs = useOsm((s) => s.set);
  const [open, setOpen] = useState(false);
  const [roadSt, setRoadSt] = useState<Status>({ state: 'idle' });
  const [placeSt, setPlaceSt] = useState<Status>({ state: 'idle' });
  const box = useViewBox(viewer, prefs.roads || prefs.places);
  useBasemap(viewer, prefs.basemap);
  useRoads(viewer, prefs.roads, box, setRoadSt);
  usePlaces(viewer, prefs.places, box, setPlaceSt);

  // search
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<GeocodeHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pinId = 'osm-search-pin';
  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setErr('');
    try {
      const r = await geocode(q.trim(), { lang: lang === 'th' ? 'th' : 'en', countrycodes: 'th,kh' });
      setHits(r);
      if (r.length === 1) go(r[0]);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const go = (h: GeocodeHit) => {
    if (!viewer) return;
    setHits(null);
    const prev = viewer.entities.getById(pinId);
    if (prev) viewer.entities.remove(prev);
    viewer.entities.add({
      id: pinId,
      position: Cesium.Cartesian3.fromDegrees(h.lon, h.lat),
      point: { pixelSize: 12, color: Cesium.Color.fromCssColorString('#ef4444'), outlineColor: Cesium.Color.WHITE, outlineWidth: 2.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: {
        text: h.label.split(',')[0], font: 'bold 14px "IBM Plex Sans Thai", "Sarabun", sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE, showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('#7f1d1d').withAlpha(0.85),
        pixelOffset: new Cesium.Cartesian2(0, -20), disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    // small places come back as a point or a tiny box: show at least ~6 km around them
    const [w, s, e, n] = h.bbox ?? [h.lon, h.lat, h.lon, h.lat];
    const m = 0.03;
    const r = Cesium.Rectangle.fromDegrees(Math.min(w, h.lon - m), Math.min(s, h.lat - m), Math.max(e, h.lon + m), Math.max(n, h.lat + m));
    viewer.camera.flyTo({ destination: r, duration: 1.6 });
  };
  const clearPin = () => {
    const prev = viewer?.entities.getById(pinId);
    if (prev && viewer) viewer.entities.remove(prev);
    viewer?.scene.requestRender();
  };

  const stText = (st: Status, zoomKm: number) =>
    st.state === 'zoom' ? L(`ซูมเข้าให้กรอบภาพเล็กกว่า ~${zoomKm} กม. เพื่อโหลด`, `Zoom in below ~${zoomKm} km to load`)
      : st.state === 'loading' ? L('กำลังโหลด…', 'Loading…')
        : st.state === 'ok' ? L(`${st.n} รายการในบริเวณนี้`, `${st.n} in this area`)
          : st.state === 'error' ? L('โหลดไม่ได้ (เซิร์ฟเวอร์ OSM ไม่ว่าง ลองเลื่อนแผนที่ใหม่)', 'Failed (OSM server busy — move the map to retry)')
            : '';

  return (
    <>
      <span className="mx-0.5 h-4 w-px bg-line" />
      <form className="relative flex items-center" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={L('🔍 ค้นหาหมู่บ้าน/สถานที่', '🔍 Find a village/place')}
          className="w-44 rounded border border-line bg-ink-900/80 px-2 py-1 text-[11px] text-slate-100 placeholder:text-muted focus:border-cyan-400 focus:outline-none"
        />
        {busy && <span className="absolute right-2 text-muted">…</span>}
        {(hits || err) && (
          <div className="absolute left-0 top-full z-40 mt-1 w-[320px] rounded-md border border-line bg-ink-950/95 p-1 text-[11px] shadow-lg">
            {err && <div className="p-1 text-bad">{err}</div>}
            {hits && !hits.length && <div className="p-1 text-muted">{L('ไม่พบใน OpenStreetMap (ไทย/กัมพูชา) · ลองสะกดอื่น หรือพิมพ์พิกัด', 'Nothing found in OpenStreetMap (TH/KH) — try another spelling or type coordinates')}</div>}
            {hits?.map((h, i) => (
              <button key={i} type="button" onClick={() => go(h)} className="block w-full rounded px-1.5 py-1 text-left text-slate-200 hover:bg-cyan-400/10">{h.label}</button>
            ))}
            <div className="flex justify-between px-1 pt-1 text-[10px] text-muted">
              <span>Nominatim · © OpenStreetMap contributors</span>
              <button type="button" className="hover:text-white" onClick={() => { setHits(null); setErr(''); }}>✕</button>
            </div>
          </div>
        )}
      </form>
      <button type="button" onClick={clearPin} className="rounded px-1 py-1 text-muted hover:text-white" title={L('ลบหมุดค้นหา', 'Remove the search pin')}>📍✕</button>
      <button type="button" onClick={() => setOpen(!open)} className={cx('rounded px-2 py-1', open || prefs.basemap === 'osm' || prefs.roads || prefs.places ? 'bg-cyan-400/15 text-cyan-300' : 'text-slate-200 hover:text-white')} title={L('แผนที่ฐาน ถนน และชื่อสถานที่จาก OpenStreetMap', 'Base map, roads and place names from OpenStreetMap')}>
        🗺 OSM
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-[320px] space-y-2 rounded-md border border-line bg-ink-950/95 p-2 text-[11px] text-slate-200 shadow-lg">
          <div className="flex items-center justify-between">
            <span className="font-semibold">OpenStreetMap</span>
            <button className="text-muted hover:text-white" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="rounded border border-line p-1.5">
            <div className="mb-1 font-semibold">{L('แผนที่ฐาน', 'Base map')}</div>
            <div className="flex gap-1">
              {([['imagery', L('ภาพดาวเทียม', 'Satellite')], ['osm', L('แผนที่ถนน OSM', 'OSM street map')]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setPrefs({ basemap: k })} className={cx('flex-1 rounded border px-2 py-1', prefs.basemap === k ? 'border-cyan-400 text-cyan-300' : 'border-line hover:border-cyan-400/50')}>{l}</button>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-muted">{L('ภาพผลการตรวจและภาพเทียบก่อน/หลังยังแสดงทับแผนที่ฐานตามปกติ', 'Check results and before/after scenes still draw on top')}</p>
          </div>
          <div className="rounded border border-line p-1.5">
            <label className="flex items-center gap-1 font-semibold">
              <input type="checkbox" checked={prefs.roads} onChange={(e) => setPrefs({ roads: e.target.checked })} />
              {L('ถนน / ทางเดิน', 'Roads / paths')}
            </label>
            <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
              {(Object.keys(ROAD_STYLE) as RoadClass[]).map((c) => (
                <span key={c} className="flex items-center gap-1">
                  <i className={cx('inline-block w-4', ROAD_STYLE[c].dashed ? 'border-t-2 border-dashed' : 'h-[3px]')} style={ROAD_STYLE[c].dashed ? { borderColor: ROAD_STYLE[c].color } : { background: ROAD_STYLE[c].color }} />
                  {L(ROAD_STYLE[c].th, ROAD_STYLE[c].en)}
                </span>
              ))}
            </div>
            {prefs.roads && <p className={cx('mt-1 text-[10px]', roadSt.state === 'error' ? 'text-bad' : roadSt.state === 'zoom' ? 'text-warn' : 'text-muted')}>{stText(roadSt, 45)}</p>}
          </div>
          <div className="rounded border border-line p-1.5">
            <label className="flex items-center gap-1 font-semibold">
              <input type="checkbox" checked={prefs.places} onChange={(e) => setPrefs({ places: e.target.checked })} />
              {L('ชื่อหมู่บ้าน / สถานที่', 'Village / place names')}
            </label>
            <p className="mt-0.5 text-[10px] text-muted">{L('หมู่บ้าน ชุมชน · 🛂 ด่าน · 👮 ตำรวจ · 🏫 โรงเรียน · 🛕 วัด · 🏥 รพ./อนามัย (ชื่อเล็กขึ้นเมื่อซูมเข้า)', 'Villages · 🛂 border posts · 👮 police · 🏫 schools · 🛕 temples · 🏥 health (small ones appear as you zoom in)')}</p>
            {prefs.places && <p className={cx('mt-1 text-[10px]', placeSt.state === 'error' ? 'text-bad' : placeSt.state === 'zoom' ? 'text-warn' : 'text-muted')}>{stText(placeSt, 180)}</p>}
          </div>
          <p className="text-[10px] leading-relaxed text-muted">
            {L('ข้อมูล © OpenStreetMap contributors (ODbL) · อาสาสมัครเป็นผู้ทำแผนที่ บางพื้นที่ชายแดนอาจไม่ครบหรือไม่เป็นปัจจุบัน ใช้ประกอบการดูภาพ ไม่ใช่ข้อมูลทางการ', 'Data © OpenStreetMap contributors (ODbL) · volunteer-mapped; border areas may be incomplete or outdated — a viewing aid, not official data')}
          </p>
        </div>
      )}
    </>
  );
}
