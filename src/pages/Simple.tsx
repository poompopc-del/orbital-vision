// ORBITAL VISION — simple before/after viewer for general staff.
//  ① pick a target from the imported list (or type a coordinate / click the map)
//  ② the two clearest images are found automatically (before / after, chosen gap); either can be changed
//  ③ swipe between them on the map in a band combination; ④ optionally highlight what changed; download
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import GlobeHost from '../components/GlobeHost';
import SwipeView from '../components/imagery/SwipeView';
import { useGisHost } from '../components/gis/useGisHost';
import { imageProvider } from '../components/gis/sceneLayer';
import { Spinner, cx } from '../components/ui';
import { Cesium, flyToPolygon, showAoi } from '../lib/cesium';
import { ACCEPT, importCoordText } from '../lib/coordImport';
import { displayTemplate } from '../lib/export';
import { aoiFromPolygon, compareScenes, getImage, measureAoiCloud, rai, type MonitorRun, type Purpose } from '../lib/monitor';
import { outlineDataUrl } from '../lib/outline';
import type { AoiCloud } from '../lib/qc';
import { compositeAvailability, compositeTileUrl, DEFAULT_STRETCH, type Role } from '../lib/spectral';
import { searchArchive, type ImageryItem } from '../lib/stac';
import { BOX_SIZES, DEFAULT_BOX_KM, importTargetFiles, loadTargets, saveTargets, targetAoi, type Target, type TargetSet } from '../lib/targets';

// ---------------------------------------------------------------- settings in plain words

const COLOURS: { id: string; name: string; what: string; rgb: [Role, Role, Role] | null }[] = [
  { id: 'true', name: 'สีจริง', what: 'เหมือนที่ตาเห็น', rgb: null },
  { id: 'cir', name: 'พืชเป็นสีแดง', what: 'ป่าและพืชเป็นสีแดง ที่ถูกถางหรือทางตัดใหม่เห็นเป็นแนวสีฟ้า-น้ำตาลชัดเจน', rgb: ['nir', 'red', 'green'] },
  { id: 'urban', name: 'ดินโล่ง / สิ่งปลูกสร้าง', what: 'ดินเปิดใหม่ ลานดิน หลังคา ถนน เด่นออกมาจากพืช', rgb: ['swir2', 'swir1', 'red'] },
  { id: 'agri', name: 'ความสมบูรณ์ของพืช', what: 'พืชสมบูรณ์เป็นเขียวสด ดินโล่งเป็นชมพู-ม่วง', rgb: ['swir1', 'nir', 'blue'] },
  { id: 'water', name: 'แยกน้ำ', what: 'น้ำเป็นสีดำ / น้ำเงินเข้ม เห็นแนวน้ำและที่ชื้นชัด', rgb: ['nir', 'swir1', 'red'] },
];
const GAPS = [
  { days: 30, name: '1 เดือน' },
  { days: 91, name: '3 เดือน' },
  { days: 182, name: '6 เดือน' },
  { days: 365, name: '1 ปี' },
];
const LOOK_FOR: { id: Purpose; name: string }[] = [
  { id: 'clearing', name: 'ป่า / พืชถูกถาง' },
  { id: 'track', name: 'ทาง / ถนนใหม่' },
  { id: 'construction', name: 'สิ่งปลูกสร้าง / ลานดิน' },
  { id: 'general', name: 'พืชเปลี่ยนทั้งหมด' },
];
/** cloud + shadow over the area: up to CLEAR is "clear", up to SOME "some cloud" */
const CLEAR = 10, SOME = 30;
const SEARCH_YEARS = 2;

type Cl = AoiCloud | null | 'err';
const pctOf = (c: Cl | undefined) => (c && c !== 'err' ? c.cloudPct + c.shadowPct : null);
const day = (s: string) => s.slice(0, 10);
const thDate = (s: string) => new Date(s).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// ---------------------------------------------------------------- small UI pieces

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-4">
      <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-white">
        <span className={cx('flex h-6 w-6 items-center justify-center rounded-full text-[13px]', done ? 'bg-emerald-500 text-ink-950' : 'bg-cyan-400 text-ink-950')}>{done ? '✓' : n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}
function Chip({ on, onClick, children, title, disabled }: { on?: boolean; onClick: () => void; children: ReactNode; title?: string; disabled?: boolean }) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'rounded-md border px-3 py-1.5 text-[13px] transition disabled:opacity-40',
        on ? 'border-cyan-400 bg-cyan-400/20 text-white' : 'border-line text-slate-300 hover:border-cyan-400/60 hover:text-white',
      )}
    >
      {children}
    </button>
  );
}
function BigButton({ onClick, children, disabled }: { onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="w-full rounded-md bg-cyan-400 px-4 py-2.5 text-[14px] font-semibold text-ink-950 hover:bg-cyan-300 disabled:opacity-40">
      {children}
    </button>
  );
}
function CloudTag({ c }: { c: Cl | undefined }) {
  const p = pctOf(c);
  if (c === undefined) return <span className="text-[11px] text-muted">ยังไม่ตรวจเมฆ</span>;
  if (p == null) return <span className="text-[11px] text-muted">ตรวจเมฆไม่ได้</span>;
  return (
    <span className={cx('rounded px-1.5 py-0.5 text-[11px]', p <= CLEAR ? 'bg-emerald-500/20 text-emerald-300' : p <= SOME ? 'bg-amber-500/20 text-amber-300' : 'bg-rose-500/20 text-rose-300')}>
      {p <= CLEAR ? 'ใส' : p <= SOME ? 'มีเมฆบ้าง' : 'เมฆมาก'} {p.toFixed(0)}%
    </span>
  );
}

// ---------------------------------------------------------------- page

interface Place { name: string; aoi: GeoJSON.Polygon; lon: number; lat: number; target?: Target }

export default function Simple() {
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const g = useGisHost(viewer);
  const mapRef = useRef<HTMLDivElement>(null);

  // ① target list (this browser only) / typed coordinate
  const [set, setSet] = useState<TargetSet | null>(null);
  const [tab, setTab] = useState<'list' | 'coord'>('list');
  const [q, setQ] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const [coordText, setCoordText] = useState('');
  const [boxKm, setBoxKm] = useState(DEFAULT_BOX_KM);
  const [clickMode, setClickMode] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  useEffect(() => void loadTargets().then(setSet), []);

  const choose = (t: Target) => {
    setPlace({ name: t.name, aoi: targetAoi(t), lon: t.lon, lat: t.lat, target: t });
    setBoxKm(t.sizeKm);
  };
  const resize = (km: number) => {
    setBoxKm(km);
    if (!place) return;
    if (place.target?.ring) return; // file outline: kept
    const t = { lon: place.lon, lat: place.lat, sizeKm: km };
    setPlace({ ...place, aoi: targetAoi(t), target: place.target ? { ...place.target, sizeKm: km } : undefined });
    if (set && place.target) {
      const next = { ...set, targets: set.targets.map((x) => (x.id === place.target!.id ? { ...x, sizeKm: km } : x)) };
      setSet(next);
      void saveTargets(next);
    }
  };
  const goCoord = (text = coordText) => {
    const p = text.trim() ? importCoordText(text.trim()).places[0] : undefined;
    if (!p) return setImportMsg('อ่านพิกัดไม่ได้ — ลองแบบ 13.97, 104.13 หรือ 13 58 12 N 104 08 03 E หรือ UTM');
    const { lat, lon } = p;
    setImportMsg('');
    setPlace({ name: 'พิกัดที่ใส่', aoi: targetAoi({ lon, lat, sizeKm: boxKm }), lon, lat });
  };
  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setImportMsg('กำลังอ่านไฟล์…');
    try {
      const r = await importTargetFiles([...files]);
      setSet(r.set);
      setImportMsg(`นำเข้า ${r.set.targets.length} เป้าแล้ว${r.warnings.length ? ` · ${r.warnings.join(' · ')}` : ''}`);
    } catch (e: any) {
      setImportMsg(e?.message ?? String(e));
    }
  };
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (set?.targets ?? []).filter((t) => !k || t.name.toLowerCase().includes(k));
  }, [set, q]);

  // targets on the map (click a dot to pick it)
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const ds = new Cesium.CustomDataSource('targets');
    for (const t of set?.targets ?? []) {
      ds.entities.add({
        id: `tgt:${t.id}`,
        position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat),
        point: { pixelSize: 8, color: Cesium.Color.fromCssColorString('#f59e0b'), outlineColor: Cesium.Color.BLACK, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: {
          text: t.name, font: '12px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -14), disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 250000),
        },
      });
    }
    void viewer.dataSources.add(ds);
    viewer.scene.requestRender();
    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, set]);
  // map clicks: a target dot, or (in click mode) a new coordinate
  const clickRef = useRef({ clickMode, set, boxKm });
  clickRef.current = { clickMode, set, boxKm };
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const h = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    h.setInputAction((e: { position: Cesium.Cartesian2 }) => {
      const { clickMode: cm, set: st, boxKm: km } = clickRef.current;
      const hit = viewer.scene.pick(e.position);
      const id = hit?.id?.id as string | undefined;
      if (id?.startsWith('tgt:')) {
        const t = st?.targets.find((x) => `tgt:${x.id}` === id);
        if (t) choose(t);
        return;
      }
      if (!cm) return;
      const c = viewer.camera.pickEllipsoid(e.position, viewer.scene.globe.ellipsoid);
      if (!c) return;
      const cg = Cesium.Cartographic.fromCartesian(c);
      const lat = Cesium.Math.toDegrees(cg.latitude), lon = Cesium.Math.toDegrees(cg.longitude);
      setCoordText(`${lat.toFixed(5)}, ${lon.toFixed(5)}`);
      setPlace({ name: 'จุดที่คลิกบนแผนที่', aoi: targetAoi({ lon, lat, sizeKm: km }), lon, lat });
      setClickMode(false);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return () => h.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer]);

  // start over Thailand and its neighbours
  useEffect(() => {
    if (viewer && !viewer.isDestroyed()) viewer.camera.setView({ destination: Cesium.Rectangle.fromDegrees(96, 4, 108, 22) });
  }, [viewer]);
  // the area box on the map
  const akey = place ? JSON.stringify(place.aoi.coordinates) : '';
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    showAoi(viewer, place?.aoi ?? null, 'simple-aoi', place ? [place.lon, place.lat] : null);
    viewer.scene.requestRender();
  }, [viewer, akey]);
  const placeKey = place ? `${place.lon.toFixed(5)},${place.lat.toFixed(5)}` : '';
  useEffect(() => {
    if (place && viewer && !viewer.isDestroyed()) flyToPolygon(viewer, place.aoi);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, placeKey]);

  // ② images: search, cloud over the area, automatic before / after
  const [items, setItems] = useState<ImageryItem[] | null>(null);
  const [cl, setCl] = useState<Record<string, Cl>>({});
  const clRef = useRef<Record<string, Cl>>({});
  const [A, setA] = useState<ImageryItem | null>(null);
  const [B, setB] = useState<ImageryItem | null>(null);
  const [gap, setGap] = useState(365);
  const [imgBusy, setImgBusy] = useState('');
  const [imgErr, setImgErr] = useState('');
  const [showList, setShowList] = useState(false);
  const [listPick, setListPick] = useState<'A' | 'B'>('A');
  const imgAbort = useRef<AbortController | null>(null);

  const measure = async (xs: ImageryItem[], aoi: GeoJSON.Polygon, signal: AbortSignal) => {
    const todo = xs.filter((x) => !(x.id in clRef.current));
    await Promise.all(
      todo.map(async (x) => {
        let v: Cl;
        try {
          v = await measureAoiCloud(x, aoi, signal);
        } catch (e) {
          if (signal.aborted) throw e;
          v = 'err';
        }
        clRef.current = { ...clRef.current, [x.id]: v };
      }),
    );
    setCl(clRef.current);
  };
  /** first scene (in the given order) that is clear; else the least cloudy "some cloud" one */
  const firstClear = async (order: ImageryItem[], aoi: GeoJSON.Polygon, signal: AbortSignal, max = 24) => {
    let fallback: ImageryItem | null = null;
    for (let i = 0; i < Math.min(order.length, max); i += 4) {
      const batch = order.slice(i, i + 4);
      await measure(batch, aoi, signal);
      for (const x of batch) {
        const p = pctOf(clRef.current[x.id]);
        if (p != null && p <= CLEAR) return x;
        if (p != null && p <= SOME && (!fallback || p < (pctOf(clRef.current[fallback.id]) ?? 100))) fallback = x;
      }
    }
    return fallback;
  };
  const findBefore = async (after: ImageryItem, list: ImageryItem[], gapDays: number, aoi: GeoJSON.Polygon, signal: AbortSignal) => {
    const want = Date.parse(after.datetime) - gapDays * 864e5;
    const win = Math.max(20, gapDays * 0.5) * 864e5;
    const order = list
      .filter((x) => Date.parse(x.datetime) < Date.parse(after.datetime) - 10 * 864e5 && Math.abs(Date.parse(x.datetime) - want) <= win)
      .sort((a, b) => Math.abs(Date.parse(a.datetime) - want) - Math.abs(Date.parse(b.datetime) - want));
    return firstClear(order, aoi, signal);
  };

  useEffect(() => {
    imgAbort.current?.abort();
    setItems(null); setA(null); setB(null); setImgErr(''); setRun(null); setShowList(false);
    clRef.current = {};
    setCl({});
    if (!place) return;
    const ac = new AbortController();
    imgAbort.current = ac;
    const aoi = place.aoi;
    (async () => {
      try {
        setImgBusy('กำลังหาภาพดาวเทียม…');
        const to = new Date(), from = new Date(Date.now() - SEARCH_YEARS * 365 * 864e5);
        const found = (await searchArchive({ aoi, collections: ['sentinel-2-l2a'], from: day(from.toISOString()), to: day(to.toISOString()), maxCloud: 80, limit: 500 }))
          .filter((x) => x.coveragePct == null || x.coveragePct >= 95);
        if (ac.signal.aborted) return;
        setItems(found);
        if (!found.length) throw new Error('ไม่พบภาพที่ครอบคลุมพื้นที่นี้ในช่วง 2 ปี');
        setImgBusy('ตรวจเมฆในพื้นที่ของภาพล่าสุด…');
        const after = await firstClear(found, aoi, ac.signal);
        if (ac.signal.aborted) return;
        if (!after) throw new Error('ภาพช่วงหลังมีเมฆในพื้นที่มาก — กด "เลือกวันเอง" เพื่อเลือกภาพเอง');
        setB(after);
        setImgBusy('หาภาพก่อนที่ใสที่สุด…');
        const before = await findBefore(after, found, gap, aoi, ac.signal);
        if (ac.signal.aborted) return;
        setA(before);
        if (!before) setImgErr('หาภาพก่อนที่ใสในช่วงนั้นไม่ได้ — ลองเปลี่ยนระยะห่าง หรือเลือกวันเอง');
      } catch (e: any) {
        if (!ac.signal.aborted) setImgErr(e?.message ?? String(e));
      } finally {
        if (!ac.signal.aborted) setImgBusy('');
      }
    })();
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [akey]);

  const changeGap = async (d: number) => {
    setGap(d);
    if (!B || !items || !place) return;
    imgAbort.current?.abort();
    const ac = new AbortController();
    imgAbort.current = ac;
    setImgErr(''); setRun(null);
    setImgBusy('หาภาพก่อนที่ใสที่สุด…');
    try {
      const before = await findBefore(B, items, d, place.aoi, ac.signal);
      if (ac.signal.aborted) return;
      setA(before);
      if (!before) setImgErr('หาภาพก่อนที่ใสในช่วงนั้นไม่ได้ — ลองเปลี่ยนระยะห่าง หรือเลือกวันเอง');
    } catch (e: any) {
      if (!ac.signal.aborted) setImgErr(e?.message ?? String(e));
    } finally {
      if (!ac.signal.aborted) setImgBusy('');
    }
  };
  const pickFromList = (x: ImageryItem) => {
    setRun(null);
    if (listPick === 'A') {
      if (B && x.datetime >= B.datetime) { setA(B); setB(x); } else setA(x);
      setListPick('B');
    } else {
      if (A && x.datetime <= A.datetime) { setB(A); setA(x); } else setB(x);
    }
    if (place && !(x.id in clRef.current)) void measure([x], place.aoi, new AbortController().signal).catch(() => undefined);
  };
  // measure the cloud of the scenes shown in the list (newest first, a few at a time)
  const [listN, setListN] = useState(20);
  useEffect(() => {
    if (!showList || !items || !place) return;
    const ac = new AbortController();
    void measure(items.slice(0, listN), place.aoi, ac.signal).catch(() => undefined);
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showList, listN, items]);

  // ③ colours
  const [colour, setColour] = useState('cir');
  const col = COLOURS.find((c) => c.id === colour)!;
  const template = (it: ImageryItem) => (col.rgb && compositeAvailability(it, col.rgb).ok ? compositeTileUrl(it, col.rgb, DEFAULT_STRETCH) : displayTemplate(it));

  // ④ change highlight
  const [lookFor, setLookFor] = useState<Purpose>('clearing');
  const [run, setRun] = useState<MonitorRun | null>(null);
  const [chBusy, setChBusy] = useState('');
  const chAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    ['change-result', 'change-outline', 'change-spots'].forEach((id) => g.removeLayer(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [A?.id, B?.id, akey]);
  const detect = async () => {
    if (!A || !B || !place) return;
    chAbort.current?.abort();
    const ac = new AbortController();
    chAbort.current = ac;
    setRun(null);
    try {
      const a = aoiFromPolygon(place.name, place.aoi, 'TH', lookFor);
      const r = await compareScenes(a, A, B, (m) => setChBusy(m), ac.signal, {
        clA: cl[A.id] === 'err' ? null : cl[A.id] ?? null, clB: cl[B.id] === 'err' ? null : cl[B.id] ?? null, mode: 'manual',
      });
      if (ac.signal.aborted) return;
      setRun(r);
    } catch (e: any) {
      if (!ac.signal.aborted) setRun({ id: 'err', aoiId: '', aoiName: '', purpose: lookFor, at: '', status: 'error', reason: e?.message ?? String(e), windows: { before: ['', ''], after: ['', ''] } });
    } finally {
      if (!ac.signal.aborted) setChBusy('');
    }
  };
  // draw the result (fill + hidden outline + numbered spots)
  useEffect(() => {
    if (!run || run.status !== 'ok' || !run.overlayBounds) return;
    let dead = false;
    void getImage(`${run.id}:change`).then(async (url) => {
      if (!url || dead) return;
      const b = run.overlayBounds!;
      const prov = await imageProvider(url, b.west, b.south, b.east, b.north);
      if (dead) return;
      g.putImagery('change-result', 'ส่วนที่เปลี่ยน', prov, { alpha: 0.85 });
      if (run.hotspots?.length) {
        const ds = new Cesium.CustomDataSource('change-spots');
        for (const h of run.hotspots) {
          ds.entities.add({
            id: `spot-${h.n}`,
            position: Cesium.Cartesian3.fromDegrees(h.lon, h.lat),
            point: { pixelSize: 7, color: Cesium.Color.fromCssColorString('#ef4444'), outlineColor: Cesium.Color.WHITE, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
            label: {
              text: `${h.n}`, font: '600 12px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -14), disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            properties: { n: h.n, lengthKm: h.shape === 'linear' ? h.lengthKm ?? null : null, km2: h.areaKm2 ?? h.areaHa / 100 },
          });
        }
        g.putDataSource('change-spots', 'หมายเลขจุดที่เปลี่ยน', ds);
      }
      const edge = await outlineDataUrl(url).catch(() => null);
      if (!edge || dead) return;
      const eprov = await imageProvider(edge, b.west, b.south, b.east, b.north);
      if (dead) return;
      g.putImagery('change-outline', 'ขอบส่วนที่เปลี่ยน', eprov, { alpha: 1 });
      g.setLayer('change-outline', { show: false });
    });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id]);
  const flyTo = (lon: number, lat: number) => viewer && !viewer.isDestroyed() && viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lon, lat, 1500), duration: 0.9 });

  const spots = run?.hotspots ?? [];
  const interestRai = run?.stats ? rai(run.stats.interestKm2) : 0;

  return (
    <div className="flex h-screen flex-col bg-ink-950 text-slate-200">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2">
        <span className="font-mono text-[13px] tracking-[0.3em] text-white">ORBITAL VISION</span>
        <span className="text-[12px] text-muted">เทียบภาพดาวเทียมก่อน / หลัง · Sentinel-2 ความละเอียด 10 ม.</span>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-[380px] shrink-0 overflow-y-auto border-r border-line">
          {/* ① */}
          <Step n={1} title="เลือกเป้า / พื้นที่" done={!!place}>
            <div className="mb-3 flex gap-1">
              <Chip on={tab === 'list'} onClick={() => setTab('list')}>รายชื่อเป้า{set ? ` (${set.targets.length})` : ''}</Chip>
              <Chip on={tab === 'coord'} onClick={() => setTab('coord')}>ใส่พิกัด</Chip>
            </div>
            {tab === 'list' && (
              <div className="space-y-2">
                {set ? (
                  <>
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหาชื่อเป้า…" className="w-full rounded-md border border-line bg-ink-900 px-3 py-2 text-[13px] outline-none focus:border-cyan-400" />
                    <div className="max-h-56 overflow-y-auto rounded-md border border-line">
                      {shown.map((t) => (
                        <button key={t.id} onClick={() => choose(t)} className={cx('block w-full border-b border-white/5 px-3 py-1.5 text-left text-[13px] hover:bg-cyan-400/10', place?.target?.id === t.id && 'bg-cyan-400/20 text-white')}>
                          {t.name}
                        </button>
                      ))}
                      {!shown.length && <div className="px-3 py-2 text-[12px] text-muted">ไม่พบชื่อนี้</div>}
                    </div>
                    <div className="text-[11px] text-muted">หรือคลิกจุดสีส้มบนแผนที่ · รายชื่ออยู่ในเครื่องนี้เท่านั้น ไม่ขึ้นเซิร์ฟเวอร์</div>
                  </>
                ) : (
                  <p className="text-[13px] text-slate-300">ยังไม่มีรายชื่อเป้า — นำเข้าไฟล์ที่มีพิกัด (CSV, Excel, KML/KMZ, Shapefile .zip, GeoJSON)</p>
                )}
                <label className="block cursor-pointer rounded-md border border-dashed border-line px-3 py-2 text-center text-[13px] text-cyan-300 hover:border-cyan-400">
                  {set ? 'นำเข้าไฟล์เป้าใหม่ (แทนรายชื่อเดิม)' : '📂 นำเข้าไฟล์เป้า'}
                  <input type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} />
                </label>
                {set && <button className="text-[11px] text-muted hover:text-rose-300" onClick={() => { void saveTargets(null); setSet(null); }}>ลบรายชื่อเป้าออกจากเครื่องนี้</button>}
              </div>
            )}
            {tab === 'coord' && (
              <div className="space-y-2">
                <div className="flex gap-1">
                  <input value={coordText} onChange={(e) => setCoordText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && goCoord()} placeholder="เช่น 13.97, 104.13" className="min-w-0 flex-1 rounded-md border border-line bg-ink-900 px-3 py-2 text-[13px] outline-none focus:border-cyan-400" />
                  <button onClick={() => goCoord()} className="rounded-md bg-cyan-400 px-3 text-[13px] font-semibold text-ink-950">ไป</button>
                </div>
                <Chip on={clickMode} onClick={() => setClickMode(!clickMode)}>{clickMode ? 'คลิกจุดบนแผนที่ได้เลย…' : '🖱 หรือคลิกเลือกบนแผนที่'}</Chip>
              </div>
            )}
            {importMsg && <p className="mt-2 text-[12px] text-amber-300">{importMsg}</p>}
            {place && (
              <div className="mt-3 rounded-md border border-cyan-400/40 bg-cyan-400/5 p-3">
                <div className="text-[14px] font-semibold text-white">{place.name}</div>
                <div className="font-mono text-[11px] text-muted">{place.lat.toFixed(5)}, {place.lon.toFixed(5)}</div>
                {!place.target?.ring && (
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <span className="mr-1 text-[12px] text-muted">ขนาดกรอบ</span>
                    {BOX_SIZES.map((k) => (
                      <Chip key={k} on={boxKm === k} onClick={() => resize(k)}>{k} กม.</Chip>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Step>

          {/* ② */}
          {place && (
            <Step n={2} title="ภาพก่อน / หลัง" done={!!A && !!B}>
              <div className="mb-2 flex flex-wrap items-center gap-1">
                <span className="mr-1 text-[12px] text-muted">ภาพก่อนห่างจากภาพหลัง</span>
                {GAPS.map((x) => (
                  <Chip key={x.days} on={gap === x.days} disabled={!B || !!imgBusy} onClick={() => void changeGap(x.days)}>{x.name}</Chip>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {([['ก่อน', A], ['หลัง', B]] as const).map(([lbl, it]) => (
                  <div key={lbl} className="rounded-md border border-line p-2">
                    <div className="text-[11px] text-muted">ภาพ{lbl}</div>
                    {it ? (
                      <>
                        <div className="text-[15px] font-semibold text-white">{thDate(it.datetime)}</div>
                        <CloudTag c={cl[it.id]} />
                      </>
                    ) : (
                      <div className="text-[13px] text-muted">{imgBusy ? '…' : '—'}</div>
                    )}
                  </div>
                ))}
              </div>
              {A && B && <div className="mt-1 text-[11px] text-muted">ห่างกัน {daysBetween(A.datetime, B.datetime)} วัน</div>}
              {imgBusy && <div className="mt-2 flex items-center gap-2 text-[12px] text-cyan-300"><Spinner />{imgBusy}</div>}
              {imgErr && <p className="mt-2 text-[12px] text-amber-300">{imgErr}</p>}
              {items && items.length > 0 && (
                <button className="mt-2 text-[12px] text-cyan-300 hover:underline" onClick={() => setShowList(!showList)}>
                  {showList ? '▾ ซ่อนรายการวัน' : `▸ เลือกวันเอง (มี ${items.length} ภาพใน 2 ปี)`}
                </button>
              )}
              {showList && items && (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center gap-1 text-[12px]">
                    <span className="text-muted">กดวันที่เพื่อตั้งเป็น</span>
                    <Chip on={listPick === 'A'} onClick={() => setListPick('A')}>ภาพก่อน</Chip>
                    <Chip on={listPick === 'B'} onClick={() => setListPick('B')}>ภาพหลัง</Chip>
                  </div>
                  <div className="max-h-64 overflow-y-auto rounded-md border border-line">
                    {items.slice(0, listN).map((x) => (
                      <button key={x.id} onClick={() => pickFromList(x)} className={cx('flex w-full items-center justify-between border-b border-white/5 px-3 py-1.5 text-left text-[13px] hover:bg-cyan-400/10', (A?.id === x.id || B?.id === x.id) && 'bg-cyan-400/15')}>
                        <span>
                          {thDate(x.datetime)}
                          {A?.id === x.id && <span className="ml-2 text-[11px] text-cyan-300">ก่อน</span>}
                          {B?.id === x.id && <span className="ml-2 text-[11px] text-cyan-300">หลัง</span>}
                        </span>
                        <CloudTag c={cl[x.id]} />
                      </button>
                    ))}
                    {listN < items.length && <button className="w-full px-3 py-1.5 text-[12px] text-cyan-300 hover:underline" onClick={() => setListN(listN + 20)}>แสดงเพิ่ม…</button>}
                  </div>
                </div>
              )}
            </Step>
          )}

          {/* ③ */}
          {A && B && (
            <Step n={3} title="ดูภาพ — เลื่อนเส้นกลางจอเพื่อเทียบ">
              <div className="flex flex-wrap gap-1">
                {COLOURS.map((c) => (
                  <Chip key={c.id} on={colour === c.id} onClick={() => setColour(c.id)}>{c.name}</Chip>
                ))}
              </div>
              <p className="mt-2 text-[12px] text-slate-300">{col.what}</p>
              <p className="mt-1 text-[11px] text-muted">ซ้ายของเส้น = ภาพก่อน · ขวา = ภาพหลัง · ปุ่มดาวน์โหลดอยู่แถบล่างของแผนที่</p>
            </Step>
          )}

          {/* ④ */}
          {A && B && (
            <Step n={4} title="ไฮไลต์ส่วนที่เปลี่ยน (ไม่บังคับ)" done={run?.status === 'ok'}>
              <div className="mb-2 flex flex-wrap gap-1">
                {LOOK_FOR.map((x) => (
                  <Chip key={x.id} on={lookFor === x.id} onClick={() => { setLookFor(x.id); setRun(null); }}>{x.name}</Chip>
                ))}
              </div>
              <BigButton disabled={!!chBusy} onClick={() => void detect()}>{chBusy ? 'กำลังหา…' : '🔍 หาส่วนที่เปลี่ยน'}</BigButton>
              {chBusy && <div className="mt-2 flex items-center gap-2 text-[12px] text-cyan-300"><Spinner />{chBusy}</div>}
              {run && run.status !== 'ok' && <p className="mt-2 text-[12px] text-amber-300">ทำไม่ได้: {run.reason ?? 'ไม่ทราบสาเหตุ'}</p>}
              {run?.status === 'ok' && (
                <div className="mt-3 space-y-2">
                  <div className={cx('text-[15px] font-semibold', spots.length ? 'text-rose-300' : 'text-emerald-300')}>
                    {spots.length ? `พบ ${spots.length} จุด · รวม ${interestRai.toFixed(1)} ไร่` : 'ไม่พบการเปลี่ยนแปลงที่เด่นชัด'}
                  </div>
                  {run.note && <p className="text-[11px] text-amber-300">{run.note}</p>}
                  {spots.length > 0 && (
                    <div className="max-h-56 overflow-y-auto rounded-md border border-line">
                      {spots.map((h) => (
                        <button key={h.n} onClick={() => flyTo(h.lon, h.lat)} className="flex w-full items-center justify-between border-b border-white/5 px-3 py-1.5 text-left text-[13px] hover:bg-cyan-400/10">
                          <span><b className="text-white">{h.n}</b> · {rai(h.areaKm2 ?? h.areaHa / 100).toFixed(1)} ไร่{h.shape === 'linear' && h.lengthKm ? ` · แนวยาว ${(h.lengthKm * 1000).toFixed(0)} ม.` : ''}</span>
                          <span className="font-mono text-[10px] text-muted">{h.lat.toFixed(5)}, {h.lon.toFixed(5)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="text-[11px] text-muted">กดแถวเพื่อบินไปดู · เปิด/ปิดไฮไลต์ได้ที่แถบล่างของแผนที่ · ผลเป็นการชี้เป้า ควรดูภาพยืนยันทุกจุด</p>
                </div>
              )}
            </Step>
          )}
        </aside>

        <div ref={mapRef} className="relative min-h-[360px] flex-1">
          <GlobeHost onReady={setViewer} />
          {A && B && <SwipeView viewer={viewer} A={A} B={B} containerRef={mapRef} g={g} template={template} templateKey={colour} />}
          {!place && (
            <div className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-md border border-line bg-ink-950/90 px-4 py-2 text-[13px] text-white">
              เริ่มจาก ① เลือกเป้าทางซ้าย
            </div>
          )}
          {clickMode && (
            <div className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-md border border-cyan-400 bg-ink-950/90 px-4 py-2 text-[13px] text-cyan-200">
              คลิกจุดที่ต้องการบนแผนที่
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
