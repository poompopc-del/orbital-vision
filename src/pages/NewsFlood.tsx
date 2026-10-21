// Flood news → map → satellite check → report.
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useLang } from '../i18n';
import GlobeHost from '../components/GlobeHost';
import { Button, Notice, Panel, Spinner, cx } from '../components/ui';
import { Cesium } from '../lib/cesium';
import {
  aoiForPlace, extractPlaces, FEEDS, loadGaz, fetchNews, loadPins, placeArticles, placeKey, PRECISION_COLOR, PRECISION_TH, readArticle, savePins,
  type FeedState, type NewsArticle, type NewsPlace, type NewsSnapshot,
} from '../lib/newsflood';
import { thProvince } from '../lib/provinces';
import { aoiFromPolygon, getImage, landCoverShares, narrative, runMonitor, type MonitorRun } from '../lib/monitor';
import { useMonitor } from './Monitor';
import { useDisaster } from './Disaster';
import { imageProvider } from '../components/gis/sceneLayer';
import { dmy, esc, esri, f1, fit, NORTH, placed, px, reportShell, scaleBar, zulu, type BBox } from '../lib/report';

// ---------------------------------------------------------------- state

const RUNS_KEY = 'ov.newsRuns.v1';
const LC_KEY = 'ov.newsLc.v1';
const readJ = <T,>(k: string, d: T): T => {
  try {
    return JSON.parse(localStorage.getItem(k) || '') as T;
  } catch {
    return d;
  }
};
const writeJ = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* ignore */
  }
};
type LandCover = { label: string; labelTh: string; km2: number }[];

interface NState {
  snap: NewsSnapshot | null;
  loading: boolean;
  progress: string;
  feeds: Record<string, FeedState>;
  days: number;
  error: string;
  pins: NewsPlace[];
  /** place key → monitoring run id */
  runOf: Record<string, string>;
  lcOf: Record<string, LandCover | null>;
  load: (days: number) => Promise<void>;
  addArticle: (a: NewsArticle) => Promise<void>;
  pin: (articleIds: string[], lat: number, lon: number, label: string) => Promise<NewsPlace>;
  removePin: (key: string) => Promise<void>;
  setRun: (key: string, runId: string, lc: LandCover | null) => void;
}

const regroup = async (snap: NewsSnapshot, pins: NewsPlace[]) => {
  const { places, unplaced } = await placeArticles(snap.articles, () => {}, pins);
  return { ...snap, places, unplaced };
};

export const useNews = create<NState>((set, get) => ({
  snap: null,
  loading: false,
  progress: '',
  feeds: {},
  days: 3,
  error: '',
  pins: loadPins(),
  runOf: readJ(RUNS_KEY, {}),
  lcOf: readJ(LC_KEY, {}),
  load: async (days) => {
    if (get().loading) return;
    set({ loading: true, days, error: '', feeds: {}, progress: '' });
    try {
      let snap = await fetchNews(days, (s) => set((st) => ({ feeds: { ...st.feeds, [s.id]: s } })), (m) => set({ progress: m }));
      // keep articles the user added by hand
      const manual = get().snap?.articles.filter((a) => a.feed === 'manual') ?? [];
      if (manual.length) snap = { ...snap, articles: [...manual, ...snap.articles] };
      snap = await regroup(snap, get().pins);
      set({ snap, loading: false, progress: '' });
    } catch (e: any) {
      set({ loading: false, progress: '', error: e?.message ?? String(e) });
    }
  },
  addArticle: async (a) => {
    const snap = get().snap ?? { articles: [], places: [], unplaced: [], feeds: [], fetchedAt: new Date().toISOString(), days: get().days };
    const articles = [a, ...snap.articles.filter((x) => x.link !== a.link)];
    set({ snap: await regroup({ ...snap, articles }, get().pins) });
  },
  pin: async (articleIds, lat, lon, label) => {
    const prov = useDisaster.getState().snap?.provinces;
    const { provinceAt, loadProvinces } = await import('../lib/provinces');
    const pr = provinceAt(prov ?? (await loadProvinces()), lon, lat);
    const p: NewsPlace = {
      key: `pin|${lat.toFixed(4)}|${lon.toFixed(4)}`, labelTh: label || `หมุด ${lat.toFixed(3)}, ${lon.toFixed(3)}`, province: pr?.en ?? '', precision: 'pin', lat, lon,
      geocoder: 'ปักหมุดโดยผู้ใช้ (จากภาพ/เนื้อข่าว)', articleIds,
    };
    const pins = [...get().pins.filter((x) => x.key !== p.key), p];
    savePins(pins);
    set({ pins });
    const snap = get().snap;
    if (snap) set({ snap: await regroup(snap, pins) });
    return p;
  },
  removePin: async (key) => {
    const pins = get().pins.filter((x) => x.key !== key);
    savePins(pins);
    set({ pins });
    const snap = get().snap;
    if (snap) set({ snap: await regroup(snap, pins) });
  },
  setRun: (key, runId, lc) => {
    const runOf = { ...get().runOf, [key]: runId };
    const lcOf = { ...get().lcOf, [key]: lc };
    writeJ(RUNS_KEY, runOf);
    writeJ(LC_KEY, lcOf);
    set({ runOf, lcOf });
  },
}));

const useL = () => {
  const lang = useLang((s) => s.lang);
  return (th: string, en: string) => (lang === 'th' ? th : en);
};
const tTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }) : '—');
const ago = (iso?: string | null) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 60 ? `${m} นาทีที่แล้ว` : m < 48 * 60 ? `${Math.round(m / 60)} ชม.ที่แล้ว` : `${Math.round(m / 1440)} วันที่แล้ว`;
};
const FEED_TH: Record<string, string> = { gnews: 'สำนักข่าว', gnews_gov: 'หน่วยงานรัฐ', gdelt: 'GDELT', reliefweb: 'ReliefWeb', manual: 'เพิ่มเอง' };
const levelColor = (r?: MonitorRun) => (!r ? '#64748b' : r.status !== 'ok' ? '#94a3b8' : r.level === 'significant' ? '#ef4444' : r.level === 'minor' ? '#f5b84b' : '#4fd18b');
const levelText = (r?: MonitorRun) => (!r ? 'ยังไม่วิเคราะห์' : r.status !== 'ok' ? 'ภาพไม่พอ' : r.level === 'significant' ? 'พบน้ำใหม่ชัดเจน' : r.level === 'minor' ? 'พบน้ำใหม่เล็กน้อย' : 'ไม่พบน้ำใหม่');

// ---------------------------------------------------------------- analysis

async function analysePlace(p: NewsPlace, progress: (m: string) => void, signal?: AbortSignal) {
  const geom = aoiForPlace(p);
  if (!geom) throw new Error('ตำแหน่งระดับจังหวัดกว้างเกินไป — ปักหมุดตำแหน่งก่อน');
  const a = { ...aoiFromPolygon(`ข่าวน้ำท่วม · ${p.labelTh}`, geom, 'TH', 'water', 7), notes: `news:${p.key}` };
  progress('อ่านสิ่งปกคลุมดิน…');
  const lc = await landCoverShares(geom, signal).catch(() => null);
  const r = await runMonitor(a, 14, progress, signal);
  useMonitor.getState().addRun(r);
  useNews.getState().setRun(p.key, r.id, lc);
  return r;
}

// ---------------------------------------------------------------- page

export function NewsFloodMap() {
  const L = useL();
  const { snap, loading, progress, feeds, days, load, error, runOf } = useNews();
  const runs = useMonitor((s) => s.runs);
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const [selKey, setSelKey] = useState<string>('');
  const [pinFor, setPinFor] = useState<string[] | null>(null);
  const [showUnplaced, setShowUnplaced] = useState(false);
  const [batch, setBatch] = useState('');
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!snap && !loading) void load(days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (viewer) viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(100.9, 13.2, 2.2e6) });
  }, [viewer]);

  const runFor = (k: string) => runs.find((r) => r.id === runOf[k]);
  const places = snap?.places ?? [];
  const sel = places.find((p) => p.key === selKey) ?? null;
  const artById = useMemo(() => new Map((snap?.articles ?? []).map((a) => [a.id, a])), [snap]);

  // ---- markers
  useEffect(() => {
    if (!viewer) return;
    const ds = new Cesium.CustomDataSource('news');
    places.forEach((p) => {
      const r = runFor(p.key);
      ds.entities.add({
        id: `np:${p.key}`,
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
        point: {
          pixelSize: Math.min(26, 9 + p.articleIds.length * 3),
          color: Cesium.Color.fromCssColorString(PRECISION_COLOR[p.precision]).withAlpha(p.precision === 'province' ? 0.55 : 0.9),
          outlineColor: p.key === selKey ? Cesium.Color.WHITE : Cesium.Color.fromCssColorString(r ? levelColor(r) : '#000'),
          outlineWidth: p.key === selKey ? 3 : r ? 3 : 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: p.precision !== 'province' || p.key === selKey ? {
          text: p.labelTh.replace(/ จ\..*$/, ''), font: '12px Sarabun, sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -18), disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 900000),
        } : undefined,
      });
    });
    if (sel) {
      const g = aoiForPlace(sel);
      if (g) ds.entities.add({ polyline: { positions: g.coordinates[0].map(([x, y]) => Cesium.Cartesian3.fromDegrees(x, y)), width: 2, material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.CYAN }) } });
    }
    void viewer.dataSources.add(ds);
    viewer.scene.requestRender();
    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, places, selKey, runOf, runs]);

  // ---- change overlay of the selected place
  const selRun = sel ? runFor(sel.key) : undefined;
  useEffect(() => {
    if (!viewer || !selRun || selRun.status !== 'ok' || !selRun.overlayBounds) return;
    let layers: Cesium.ImageryLayer[] = [];
    let dead = false;
    void (async () => {
      const [after, change] = await Promise.all([getImage(`${selRun.id}:after`), getImage(`${selRun.id}:change`)]);
      for (const [url, b] of [[after, selRun.bounds], [change, selRun.overlayBounds]] as const) {
        if (!url || !b || dead || viewer.isDestroyed()) continue;
        const prov = await imageProvider(url, b.west, b.south, b.east, b.north);
        if (dead || viewer.isDestroyed()) return;
        layers.push(viewer.imageryLayers.addImageryProvider(prov));
      }
      viewer.scene.requestRender();
    })();
    return () => {
      dead = true;
      if (!viewer.isDestroyed()) layers.forEach((l) => viewer.imageryLayers.remove(l, true));
      layers = [];
    };
  }, [viewer, selRun?.id]);

  // ---- clicks: select, or drop a pin
  const pinRef = useRef(pinFor);
  pinRef.current = pinFor;
  useEffect(() => {
    if (!viewer) return;
    const h = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    h.setInputAction(async (m: any) => {
      if (pinRef.current) {
        const ray = viewer.camera.getPickRay(m.position);
        const c = ray && viewer.scene.globe.pick(ray, viewer.scene);
        if (!c) return;
        const carto = Cesium.Cartographic.fromCartesian(c);
        const lat = Cesium.Math.toDegrees(carto.latitude), lon = Cesium.Math.toDegrees(carto.longitude);
        const ids = pinRef.current;
        setPinFor(null);
        const p = await useNews.getState().pin(ids, lat, lon, '');
        setSelKey(p.key);
        return;
      }
      const p = viewer.scene.pick(m.position);
      const id: string | undefined = p?.id?.id;
      if (id?.startsWith('np:')) setSelKey(id.slice(3));
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return () => h.destroy();
  }, [viewer]);

  const flyTo = (p: NewsPlace) => {
    setSelKey(p.key);
    const alt = p.precision === 'province' ? 300000 : p.precision === 'amphoe' ? 60000 : 30000;
    viewer?.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, alt), duration: 1.2 });
  };

  const analyseAll = async () => {
    const list = places.filter((p) => p.precision !== 'province' && !runFor(p.key)).slice(0, 12);
    if (!list.length) return;
    const ac = new AbortController();
    abort.current = ac;
    try {
      for (let i = 0; i < list.length; i++) {
        if (ac.signal.aborted) break;
        setBatch(`${i + 1}/${list.length} ${list[i].labelTh}`);
        await analysePlace(list[i], (m) => setBatch(`${i + 1}/${list.length} ${list[i].labelTh} — ${m}`), ac.signal).catch((e) => {
          if (e?.name === 'AbortError') throw e;
        });
      }
    } catch {
      /* stopped */
    } finally {
      setBatch('');
    }
  };

  const nPrec = (k: string) => places.filter((p) => p.precision === k).length;
  const feedList = FEEDS.map((f) => feeds[f.id] ?? snap?.feeds.find((x) => x.id === f.id)).filter(Boolean) as FeedState[];

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-2.5 overflow-y-auto border-line p-3 scroll-thin lg:w-[420px] lg:border-r">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400">FLOOD NEWS · GEOLOCATE · VERIFY</div>
          <h2 className="text-lg font-semibold text-white">{L('ข่าวน้ำท่วม → พิกัด → ภาพดาวเทียม', 'Flood news → location → imagery')}</h2>
          <p className="text-[11px] text-muted">{L('ดึงข่าวจากสำนักข่าวและหน่วยงานรัฐ อ่านชื่อตำบล/อำเภอ/จังหวัดในข่าวเพื่อหาพิกัด แล้วตรวจน้ำท่วมด้วยภาพดาวเทียมล่าสุด', 'News from outlets and government sites, located from the place names in the story, then checked against the latest satellite images')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {[1, 3, 7].map((d) => <Button key={d} variant={days === d ? 'active' : 'ghost'} disabled={loading} onClick={() => load(d)}>{d === 1 ? L('24 ชม.', '24 h') : L(`${d} วัน`, `${d} days`)}</Button>)}
          <Button onClick={() => load(days)} disabled={loading}>{loading ? <Spinner /> : `↻ ${L('ดึงข่าวใหม่', 'Refresh')}`}</Button>
        </div>
        <div className="flex flex-wrap gap-1 text-[10px]">
          {feedList.map((f) => (
            <span key={f.id} title={f.error ?? f.source} className={cx('rounded border px-1.5 py-0.5', f.status === 'ok' ? 'border-ok/40 text-ok' : f.status === 'error' ? 'border-bad/40 text-bad' : 'border-line text-muted')}>
              {f.status === 'ok' ? '✓' : f.status === 'error' ? '✕' : '…'} {FEED_TH[f.id] ?? f.label} {f.status === 'ok' ? f.count : ''}
            </span>
          ))}
        </div>
        {progress && <p className="text-[10px] text-cyan-300">{progress}</p>}
        {error && <Notice tone="bad">{error}</Notice>}

        <AddLink />

        {snap && (
          <Panel title={L('สรุป', 'Summary')}>
            <div className="grid grid-cols-3 gap-1 text-center text-[11px]">
              <Stat n={snap.articles.length} t={L('ข่าวน้ำท่วม', 'stories')} />
              <Stat n={places.length} t={L('ตำแหน่ง', 'places')} />
              <Stat n={places.filter((p) => runFor(p.key)?.status === 'ok' && runFor(p.key)?.level !== 'none').length} t={L('พบน้ำใหม่', 'new water')} />
            </div>
            <div className="mt-1.5 flex flex-wrap gap-2 text-[10px] text-muted">
              {(['pin', 'tambon', 'amphoe', 'province'] as const).map((k) => <span key={k}><i className="mr-1 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: PRECISION_COLOR[k] }} />{PRECISION_TH[k]} {nPrec(k)}</span>)}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button variant="primary" disabled={!!batch || !places.some((p) => p.precision !== 'province' && !runFor(p.key))} onClick={analyseAll}>{batch ? <Spinner /> : L('วิเคราะห์ภาพดาวเทียมทุกตำแหน่ง', 'Analyse all places')}</Button>
              {batch && <Button variant="danger" onClick={() => abort.current?.abort()}>{L('หยุด', 'Stop')}</Button>}
            </div>
            {batch && <p className="mt-1 text-[10px] text-cyan-300">{batch}</p>}
            <p className="mt-1 text-[10px] text-muted">{L('วิเคราะห์เฉพาะตำแหน่งระดับตำบล/อำเภอ/หมุด (สูงสุด 12 จุดต่อครั้ง) ระดับจังหวัดกว้างเกินไป ให้ปักหมุดก่อน', 'Tambon/amphoe/pin places only (max 12 per run); province-level places need a pin first')}</p>
          </Panel>
        )}

        <div className="rounded-md border border-line">
          <div className="border-b border-line px-2 py-1 text-[10px] uppercase tracking-wider text-muted">{L('ตำแหน่งจากข่าว', 'Places from news')} ({places.length})</div>
          <div className="max-h-[380px] overflow-y-auto scroll-thin">
            {places.map((p) => {
              const r = runFor(p.key);
              const latest = p.articleIds.map((id) => artById.get(id)?.published ?? '').sort().pop();
              return (
                <button key={p.key} onClick={() => flyTo(p)} className={cx('flex w-full items-start gap-2 border-b border-line/50 px-2 py-1.5 text-left hover:bg-white/5', p.key === selKey && 'bg-white/10')}>
                  <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PRECISION_COLOR[p.precision] }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-white">{p.labelTh}</span>
                    <span className="block text-[10px] text-muted">{PRECISION_TH[p.precision]} · {p.articleIds.length} {L('ข่าว', 'stories')} · {ago(latest)}</span>
                  </span>
                  <span className="shrink-0 rounded px-1 text-[10px]" style={{ color: levelColor(r) }}>{levelText(r)}</span>
                </button>
              );
            })}
            {!places.length && <p className="p-2 text-[11px] text-muted">{loading ? L('กำลังดึงข่าว…', 'Loading…') : L('ยังไม่มีตำแหน่ง', 'No places yet')}</p>}
          </div>
        </div>

        {snap && snap.unplaced.length > 0 && (
          <div className="rounded-md border border-line">
            <button onClick={() => setShowUnplaced(!showUnplaced)} className="w-full px-2 py-1 text-left text-[10px] uppercase tracking-wider text-muted hover:text-white">
              {showUnplaced ? '▾' : '▸'} {L('ข่าวที่ยังหาตำแหน่งไม่ได้', 'Stories without a place')} ({snap.unplaced.length})
            </button>
            {showUnplaced && (
              <div className="max-h-[300px] overflow-y-auto scroll-thin">
                {snap.unplaced.map((id) => artById.get(id)).filter(Boolean).map((a) => (
                  <div key={a!.id} className="border-t border-line/50 px-2 py-1.5 text-[11px]">
                    <a href={a!.realUrl ?? a!.link} target="_blank" rel="noreferrer" className="text-slate-200 hover:underline">{a!.title}</a>
                    <div className="flex items-center justify-between gap-2 text-[10px] text-muted">
                      <span>{a!.outlet} · {ago(a!.published)}</span>
                      <button className={cx('shrink-0 hover:text-white', pinFor?.[0] === a!.id ? 'text-pink-400' : 'text-cyan-300')} onClick={() => setPinFor(pinFor?.[0] === a!.id ? null : [a!.id])}>{pinFor?.[0] === a!.id ? L('คลิกบนแผนที่…', 'Click map…') : L('📍 ปักหมุดเอง', '📍 Pin')}</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </aside>

      <div className="relative min-h-[360px] flex-1">
        <GlobeHost onReady={setViewer} />
        {pinFor && <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-md border border-pink-400 bg-ink-950/90 px-3 py-1.5 text-xs text-pink-200">{L('คลิกบนแผนที่ตรงตำแหน่งที่เห็นในภาพ/ข่าว', 'Click the map where the photo/story shows')} · <button className="underline" onClick={() => setPinFor(null)}>{L('ยกเลิก', 'cancel')}</button></div>}
        <div className="absolute bottom-8 left-3 z-10 rounded-md border border-line bg-ink-950/85 p-2 text-[10px] text-slate-200 backdrop-blur">
          {(['pin', 'tambon', 'amphoe', 'province'] as const).map((k) => <div key={k} className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: PRECISION_COLOR[k] }} />{PRECISION_TH[k]}</div>)}
          <div className="mt-1 text-muted">{L('ขนาดจุด = จำนวนข่าว · ขอบสี = ผลภาพดาวเทียม', 'Size = stories · ring = imagery result')}</div>
          <div className="text-muted"><span style={{ color: '#ef4444' }}>●</span> {L('พบน้ำใหม่', 'new water')} <span style={{ color: '#4fd18b' }}>●</span> {L('ไม่พบ', 'none')} <span style={{ color: '#94a3b8' }}>●</span> {L('ภาพไม่พอ', 'no image')}</div>
        </div>
        {sel && <PlacePanel p={sel} articles={sel.articleIds.map((id) => artById.get(id)!).filter(Boolean)} onClose={() => setSelKey('')} onPin={(ids) => setPinFor(ids)} pinning={!!pinFor} />}
      </div>
    </div>
  );
}

function Stat({ n, t }: { n: number; t: string }) {
  return (
    <div className="rounded border border-line bg-white/5 py-1">
      <div className="font-mono text-lg text-white">{n}</div>
      <div className="text-[10px] text-muted">{t}</div>
    </div>
  );
}

function AddLink() {
  const L = useL();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const add = async () => {
    await loadGaz().catch(() => null);
    if (!/^https?:\/\//.test(url.trim())) return setMsg(L('ใส่ลิงก์ที่ขึ้นต้นด้วย http(s)://', 'Enter an http(s):// link'));
    setBusy(true);
    setMsg('');
    const a0: NewsArticle = { id: `manual:${url.trim()}`, feed: 'manual', title: url.trim(), link: url.trim(), outlet: new URL(url.trim()).hostname, published: null, places: [] };
    const a = await readArticle(a0);
    if (a.readState !== 'ok') {
      setBusy(false);
      return setMsg(L('อ่านหน้าข่าวนี้ไม่ได้ (เว็บอาจบล็อกการอ่านอัตโนมัติ)', 'Could not read this page'));
    }
    // title from the page
    const r = await fetch(`/api/news?src=article&url=${encodeURIComponent(url.trim())}`).then((x) => x.json()).catch(() => ({}));
    const art = { ...a, title: r.title || a.title, outlet: r.outlet || a.outlet, places: extractPlaces(`${r.title ?? ''} ${r.description ?? ''} ${a.text ?? ''}`) };
    await useNews.getState().addArticle(art);
    setBusy(false);
    setUrl('');
    setMsg(art.places.length ? L(`พบชื่อสถานที่ ${art.places.length} แห่งในข่าว`, `${art.places.length} place(s) found`) : L('ไม่พบชื่อตำบล/อำเภอ/จังหวัดในข่าว — ปักหมุดเองได้ในรายการ “ข่าวที่ยังหาตำแหน่งไม่ได้”', 'No place names found — pin it manually'));
  };
  return (
    <Panel title={L('เพิ่มข่าวจากลิงก์', 'Add a story by link')}>
      <div className="flex gap-1.5">
        <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="https://…" className="min-w-0 flex-1 rounded border border-line bg-ink-950 px-2 py-1 text-xs text-white" />
        <Button onClick={add} disabled={busy || !url}>{busy ? <Spinner /> : L('อ่านข่าว', 'Read')}</Button>
      </div>
      {msg && <p className="mt-1 text-[10px] text-muted">{msg}</p>}
    </Panel>
  );
}

function PlacePanel({ p, articles, onClose, onPin, pinning }: { p: NewsPlace; articles: NewsArticle[]; onClose: () => void; onPin: (ids: string[]) => void; pinning: boolean }) {
  const L = useL();
  const { runOf, lcOf, removePin } = useNews();
  const runs = useMonitor((s) => s.runs);
  const run = runs.find((r) => r.id === runOf[p.key]);
  const lc = lcOf[p.key];
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [img, setImg] = useState<{ after: string | null; change: string | null; before: string | null } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const dsnap = useDisaster((s) => s.snap);

  useEffect(() => {
    setErr('');
    abort.current?.abort();
  }, [p.key]);
  useEffect(() => {
    setImg(null);
    if (!run || run.status !== 'ok') return;
    let dead = false;
    void Promise.all([getImage(`${run.id}:after`), getImage(`${run.id}:change`), getImage(`${run.id}:before`)]).then(([after, change, before]) => !dead && setImg({ after, change, before }));
    return () => {
      dead = true;
    };
  }, [run?.id]);

  // ThaiWater stations near the place (from the disaster map's latest load)
  const near = useMemo(() => {
    if (!dsnap) return null;
    const R = p.precision === 'province' ? 60 : 20;
    const dist = (lat: number, lon: number) => Math.hypot((lat - p.lat) * 110.6, (lon - p.lon) * 111.3 * Math.cos((p.lat * Math.PI) / 180));
    return dsnap.events.filter((e) => e.source === 'thaiwater_wl' && e.hazard === 'flood' && dist(e.lat, e.lon) <= R).map((e) => ({ e, d: dist(e.lat, e.lon) })).sort((a, b) => a.d - b.d).slice(0, 5);
  }, [dsnap, p.key]);

  const go = async () => {
    const ac = new AbortController();
    abort.current = ac;
    setErr('');
    try {
      await analysePlace(p, setBusy, ac.signal);
    } catch (e: any) {
      if (e?.name !== 'AbortError') setErr(String(e?.message ?? e));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="absolute right-3 top-3 z-20 max-h-[calc(100%-1.5rem)] w-[400px] overflow-y-auto rounded-md border border-line bg-navy-900/95 p-3 text-xs shadow-2xl scroll-thin">
      <div className="mb-1 flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider" style={{ color: PRECISION_COLOR[p.precision] }}>🌊 {L('น้ำท่วมจากข่าว', 'Flood in the news')} · {PRECISION_TH[p.precision]}</div>
          <div className="text-sm font-semibold text-white">{p.labelTh}</div>
        </div>
        <button onClick={onClose} className="text-muted hover:text-white">✕</button>
      </div>
      <dl className="grid grid-cols-[100px_1fr] gap-x-2 gap-y-0.5 text-[11px]">
        <dt className="text-muted">{L('พิกัด', 'Coordinates')}</dt><dd className="font-mono text-slate-200">{p.lat.toFixed(4)}, {p.lon.toFixed(4)}</dd>
        <dt className="text-muted">{L('จังหวัด', 'Province')}</dt><dd className="text-slate-200">{p.province ? thProvince(p.province) : '—'}</dd>
        <dt className="text-muted">{L('หาพิกัดจาก', 'Located by')}</dt><dd className="text-slate-200">{p.geocoder}</dd>
        <dt className="text-muted">{L('จำนวนข่าว', 'Stories')}</dt><dd className="text-slate-200">{articles.length}</dd>
      </dl>
      {p.precision === 'province' && <Notice tone="warn">{L('ข่าวระบุแค่ระดับจังหวัด จุดนี้คือกึ่งกลางจังหวัด ไม่ใช่จุดน้ำท่วม — ดูภาพ/เนื้อข่าวแล้วกด “ปักหมุดเอง” เพื่อระบุตำแหน่งจริงก่อนวิเคราะห์', 'Province-level only: this is the province centre, not the flood. Pin the real spot before analysing.')}</Notice>}

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button variant="primary" disabled={!!busy || p.precision === 'province'} onClick={go}>{busy ? <Spinner /> : run ? L('วิเคราะห์ใหม่ด้วยภาพล่าสุด', 'Re-analyse with latest') : L('วิเคราะห์น้ำท่วมจากภาพดาวเทียม', 'Analyse flooding from imagery')}</Button>
        <Button onClick={() => onPin(articles.map((a) => a.id))}>{pinning ? L('คลิกบนแผนที่…', 'Click map…') : L('📍 ปักหมุดเอง', '📍 Pin location')}</Button>
        {p.precision === 'pin' && <Button variant="danger" onClick={() => { void removePin(p.key); onClose(); }}>{L('ลบหมุด', 'Remove pin')}</Button>}
        {busy && <Button variant="danger" onClick={() => abort.current?.abort()}>{L('หยุด', 'Stop')}</Button>}
      </div>
      {busy && <p className="mt-1 text-[10px] text-cyan-300">{busy}</p>}
      {err && <p className="mt-1 text-[10px] text-bad">{err}</p>}

      {run && (
        <div className="mt-3 space-y-2 border-t border-line pt-2">
          <Sec n="1" t={L('ภาพดาวเทียมล่าสุดของพื้นที่', 'Latest satellite image')}>
            {run.status === 'ok' ? (
              <>
                <div className="relative aspect-square w-full overflow-hidden rounded border border-line bg-black">
                  {img?.after && <img src={img.after} className="absolute inset-0 h-full w-full object-contain" alt="" />}
                  {img?.change && run.bounds && run.overlayBounds && <OverlayOnImage src={img.change} img={run.bounds} ov={run.overlayBounds} />}
                  <div className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">{run.B?.datetime.slice(0, 10)} · {run.sensor === 'sar' ? 'Sentinel-1 SAR' : 'Sentinel-2'}</div>
                  {img?.before && <div className="absolute bottom-1 right-1 w-[32%] border border-white/70 bg-black"><img src={img.before} className="block w-full" alt="" /><div className="bg-black/70 px-1 font-mono text-[9px] text-white">{L('ก่อน', 'before')} {run.A?.datetime.slice(0, 10)}</div></div>}
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted">{run.legend?.map((l) => <span key={l.id}><i className="mr-1 inline-block h-2.5 w-3 align-middle" style={{ background: l.color }} />{L(l.labelTh, l.label)}</span>)}</div>
              </>
            ) : <p className="text-muted">{L('ไม่มีภาพที่ใช้ได้ในช่วงเวลานี้', 'No usable image in the window')}: {run.reason}</p>}
          </Sec>
          <Sec n="2" t={L('ผลวิเคราะห์น้ำท่วม', 'Flood analysis')}>
            <ul className="list-disc pl-4">{narrative(run, 'th').map((x) => <li key={x}>{x}</li>)}</ul>
            {run.note && <p className="text-[10px] text-warn">{run.note}</p>}
            <p className="text-[10px] text-muted">{L('วิเคราะห์เมื่อ', 'Analysed')} {tTime(run.at)} · {run.method}</p>
          </Sec>
          <Sec n="3" t={L('พื้นที่ในกรอบวิเคราะห์ (ESA WorldCover)', 'Inside the box (ESA WorldCover)')}>
            {lc ? <ul>{lc.map((x) => <li key={x.label}>{L(x.labelTh, x.label)}: <b>{x.km2.toFixed(2)}</b> km² ({(x.km2 * 625).toFixed(0)} ไร่)</li>)}</ul> : <p className="text-muted">{L('อ่านข้อมูลสิ่งปกคลุมดินไม่ได้', 'Unavailable')}</p>}
          </Sec>
        </div>
      )}

      <div className="mt-3 border-t border-line pt-2">
        <div className="mb-1 font-semibold text-cyan-300">{L('สถานีวัดระดับน้ำใกล้เคียง (สสน.)', 'Nearby water-level stations')}</div>
        {near === null ? (
          <button className="text-[11px] text-cyan-300 hover:underline" onClick={() => void useDisaster.getState().load(1)}>{L('โหลดข้อมูลสถานี ThaiWater', 'Load ThaiWater stations')}</button>
        ) : near.length ? (
          <ul className="text-[11px] text-slate-200">{near.map(({ e, d }) => <li key={e.id}>{e.title} — {e.severityText} · {d.toFixed(1)} กม.</li>)}</ul>
        ) : <p className="text-[11px] text-muted">{L('ไม่มีสถานีน้ำล้นตลิ่งในรัศมี', 'No overflowing station within')} {p.precision === 'province' ? 60 : 20} กม.</p>}
      </div>

      <div className="mt-3 border-t border-line pt-2">
        <div className="mb-1 font-semibold text-cyan-300">{L('ข่าวที่กล่าวถึงพื้นที่นี้', 'Stories about this place')}</div>
        <div className="space-y-2">
          {articles.map((a) => {
            const ref = a.places.find((r) => placeKey(r) === p.key);
            return (
              <div key={a.id} className="flex gap-2">
                {a.image && <img src={a.image} alt="" className="h-14 w-20 shrink-0 rounded object-cover" referrerPolicy="no-referrer" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />}
                <div className="min-w-0">
                  <a href={a.realUrl ?? a.link} target="_blank" rel="noreferrer" className="text-[12px] leading-snug text-white hover:underline">{a.title}</a>
                  <div className="text-[10px] text-muted">{a.outlet} · {FEED_TH[a.feed]} · {tTime(a.published)}</div>
                  {ref && <div className="text-[10px] text-slate-400">“…{ref.quote}…”</div>}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[10px] text-muted">{L('ตำแหน่งได้จากชื่อสถานที่ที่เขียนในข่าว ไม่ได้อ่านจากภาพข่าว ถ้าภาพแสดงจุดที่ต่างออกไปให้ปักหมุดเอง', 'Location comes from place names in the text, not from the photo; pin manually if the photo shows elsewhere')}</p>
      </div>
    </div>
  );
}

function Sec({ n, t, children }: { n: string; t: string; children: React.ReactNode }) {
  return (
    <div className="text-[11px] text-slate-200">
      <div className="mb-0.5 font-semibold text-cyan-300">{n}. {t}</div>
      {children}
    </div>
  );
}

function OverlayOnImage({ src, img, ov }: { src: string; img: BBox; ov: BBox }) {
  const w = img.east - img.west, h = img.north - img.south;
  return (
    <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
      <image href={src} x={ov.west - img.west} y={img.north - ov.north} width={ov.east - ov.west} height={ov.north - ov.south} preserveAspectRatio="none" />
    </svg>
  );
}

// ---------------------------------------------------------------- report

export function NewsFloodReport() {
  const L = useL();
  const { snap, runOf, lcOf, load, loading, days } = useNews();
  const runs = useMonitor((s) => s.runs);
  const [title, setTitle] = useState('รายงานพื้นที่น้ำท่วมจากข่าวและภาพดาวเทียม');
  const [lang, setLang] = useState<'th' | 'en'>('th');
  const [onlyAnalysed, setOnlyAnalysed] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!snap && !loading) void load(days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const places = (snap?.places ?? []).filter((p) => !onlyAnalysed || runOf[p.key]);
  const open = async () => {
    if (!snap) return;
    setBusy(true);
    const w = window.open('', '_blank');
    const html = await buildNewsReport({ title, lang, snap, places, runOf, lcOf, runs });
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    if (w) w.location.href = url;
    else window.open(url, '_blank');
    setBusy(false);
  };
  const csv = () => {
    if (!snap) return;
    const rows = [['place', 'precision', 'lat', 'lon', 'stories', 'latest_story', 'satellite_result', 'new_water_ha', 'scene_after', 'headline', 'outlet', 'url']];
    places.forEach((p) => {
      const r = runs.find((x) => x.id === runOf[p.key]);
      p.articleIds.forEach((id) => {
        const a = snap.articles.find((x) => x.id === id);
        if (!a) return;
        rows.push([p.labelTh, p.precision, p.lat.toFixed(5), p.lon.toFixed(5), String(p.articleIds.length), a.published ?? '', levelText(r), r?.status === 'ok' ? ((r.stats?.interestKm2 ?? 0) * 100).toFixed(1) : '', r?.B?.datetime ?? '', a.title, a.outlet, a.realUrl ?? a.link]);
      });
    });
    const blob = new Blob(['﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `flood-news-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };
  return (
    <div className="mx-auto max-w-3xl p-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400">FLOOD NEWS REPORT</div>
      <h2 className="text-lg font-semibold text-white">{L('รายงานน้ำท่วมจากข่าวและภาพดาวเทียม', 'Flood report from news and imagery')}</h2>
      <p className="text-[11px] text-muted">{L('หน้าปก → ภาพรวมตำแหน่ง → หน้าละ 1 พื้นที่ (ข่าว + ภาพล่าสุด + ผลวิเคราะห์) → วิธีการและแหล่งข้อมูล', 'Cover → overview → one page per place (news + latest image + result) → method & sources')}</p>
      <div className="mt-3 space-y-2 rounded-md border border-line bg-white/5 p-3">
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded border border-line bg-ink-950 px-2 py-1.5 text-sm text-white" />
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant={lang === 'th' ? 'active' : 'ghost'} onClick={() => setLang('th')}>ไทย</Button>
          <Button variant={lang === 'en' ? 'active' : 'ghost'} onClick={() => setLang('en')}>English</Button>
          <label className="ml-2 flex items-center gap-1 text-[11px] text-slate-200"><input type="checkbox" checked={onlyAnalysed} onChange={(e) => setOnlyAnalysed(e.target.checked)} />{L('เฉพาะตำแหน่งที่วิเคราะห์ภาพแล้ว', 'Only analysed places')}</label>
        </div>
        <p className="text-[11px] text-muted">{snap ? L(`ข่าว ${snap.articles.length} ชิ้น · ตำแหน่งในรายงาน ${places.length} แห่ง · ดึงข่าวเมื่อ ${tTime(snap.fetchedAt)}`, `${snap.articles.length} stories · ${places.length} places · fetched ${tTime(snap.fetchedAt)}`) : L('กำลังดึงข่าว…', 'Loading…')}</p>
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" disabled={!snap || busy || !places.length} onClick={open}>{busy ? <Spinner /> : `📄 ${L('เปิดรายงาน (บันทึกเป็น PDF ได้)', 'Open report (save as PDF)')}`}</Button>
        <Button disabled={!snap || !places.length} onClick={csv}>{L('ตาราง CSV', 'CSV')}</Button>
      </div>
      {snap && !places.length && <Notice tone="warn">{L('ยังไม่มีตำแหน่งที่วิเคราะห์ภาพ — ไปที่แท็บ “ข่าวน้ำท่วม” แล้วกด “วิเคราะห์ภาพดาวเทียมทุกตำแหน่ง” ก่อน หรือเอาเครื่องหมายช่องด้านบนออก', 'No analysed places yet — analyse them on the news tab first, or untick the box')}</Notice>}
    </div>
  );
}

async function buildNewsReport(inp: { title: string; lang: 'th' | 'en'; snap: NewsSnapshot; places: NewsPlace[]; runOf: Record<string, string>; lcOf: Record<string, LandCover | null>; runs: MonitorRun[] }) {
  const th = inp.lang === 'th';
  const L = (a: string, b: string) => (th ? a : b);
  const now = new Date();
  const arts = new Map(inp.snap.articles.map((a) => [a.id, a]));
  const items = inp.places.map((p, i) => ({ p, n: i + 1, run: inp.runs.find((r) => r.id === inp.runOf[p.key]) }));
  const imgs: Record<string, { before: string | null; after: string | null; change: string | null }> = {};
  for (const { run } of items) if (run?.status === 'ok') imgs[run.id] = { before: await getImage(`${run.id}:before`), after: await getImage(`${run.id}:after`), change: await getImage(`${run.id}:change`) };
  const outlets = new Set(inp.snap.articles.map((a) => a.outlet));
  const found = items.filter((x) => x.run?.status === 'ok' && x.run.level !== 'none').length;
  const none = items.filter((x) => x.run?.status === 'ok' && x.run.level === 'none').length;
  const insuff = items.filter((x) => x.run && x.run.status !== 'ok').length;
  const notRun = items.filter((x) => !x.run).length;
  const footer = (pg: number) => `<div class="foot"><span>${esc(inp.title)}</span><span class="warn">${L('ตำแหน่งได้จากชื่อสถานที่ในข่าว · ผลจากภาพดาวเทียมแบบเปิด ยังไม่ผ่านการตรวจสอบภาคพื้นดิน', 'Places from place names in news · results from open imagery, not ground-verified')}</span><span>${pg}</span></div>`;
  const pages: string[] = [];
  const precTh = (k: string) => (th ? PRECISION_TH[k as keyof typeof PRECISION_TH] : k);
  const res = (r?: MonitorRun) => (th ? levelText(r) : !r ? 'not analysed' : r.status !== 'ok' ? 'insufficient imagery' : r.level === 'none' ? 'no new water' : `new water (${r.level})`);

  pages.push(`<section class="page cover">
  <h1>${esc(inp.title)}</h1><div class="rule"></div>
  <h2>${L('ความต้องการข้อมูล', 'Query Requirements')}</h2><p>${L(`รวบรวมข่าวน้ำท่วมย้อนหลัง ${inp.snap.days} วันจากสำนักข่าวและหน่วยงานรัฐ ระบุพิกัดพื้นที่จากข่าว และตรวจสอบด้วยภาพดาวเทียมล่าสุด`, `Flood news from the last ${inp.snap.days} days (outlets and government sites), located from the stories and checked against the latest satellite images`)}</p>
  <h2>${L('วันเวลาออกรายงาน', 'Product Release Date / Time')}</h2><p class="mono">${zulu(now)}</p>
  <h2>${L('ภาพรวมรายงาน', 'Product Overview')}</h2>
  <p>– ${L(`ข่าวน้ำท่วม ${inp.snap.articles.length} ชิ้นจาก ${outlets.size} แหล่ง ระบุตำแหน่งได้ ${inp.snap.places.length} แห่ง (ในรายงาน ${items.length} แห่ง)`, `${inp.snap.articles.length} flood stories from ${outlets.size} sources located to ${inp.snap.places.length} places (${items.length} in this report)`)}</p>
  <p>– ${L(`ภาพดาวเทียม: พบน้ำใหม่ ${found} แห่ง · ไม่พบ ${none} แห่ง · ภาพไม่พอ ${insuff} แห่ง · ยังไม่วิเคราะห์ ${notRun} แห่ง`, `Imagery: new water at ${found} · none at ${none} · insufficient imagery ${insuff} · not analysed ${notRun}`)}</p>
  <div class="disc">${L('ตำแหน่งในรายงานนี้อ่านจากชื่อตำบล/อำเภอ/จังหวัดที่เขียนในข่าว หรือปักหมุดโดยผู้ใช้ และผลวิเคราะห์มาจากภาพดาวเทียมแบบเปิด (Copernicus Sentinel) โดยอัตโนมัติ ยังไม่ผ่านการตรวจสอบภาคพื้นดิน ใช้ประกอบการวางแผนเท่านั้น', 'Locations were read from place names written in the stories or pinned by the user; imagery results are automatic from open Copernicus Sentinel data and not ground-verified. For planning support only.')}</div>
  ${footer(1)}</section>`);

  // overview
  const pts = items.map((x) => ({ lon: x.p.lon, lat: x.p.lat }));
  const allB: BBox = pts.length ? { west: Math.min(...pts.map((p) => p.lon)), east: Math.max(...pts.map((p) => p.lon)), south: Math.min(...pts.map((p) => p.lat)), north: Math.max(...pts.map((p) => p.lat)) } : { west: 97, east: 106, south: 6, north: 20 };
  const ov = fit(allB, 120 / 128, 0.25);
  const rows = items.slice(0, 14).map(({ p, n, run }) => {
    const latest = p.articleIds.map((id) => arts.get(id)?.published ?? '').sort().pop();
    return `<tr><td class="c">${n}</td><td>${esc(p.labelTh)}<br><span style="color:#666;font-size:7pt">${esc(precTh(p.precision))}</span></td><td class="c">${p.articleIds.length}</td><td class="mono c">${dmy(latest || undefined)}</td><td class="c lv-${run?.status === 'ok' ? run.level : 'x'}">${esc(res(run))}${run?.status === 'ok' && run.level !== 'none' ? `<br>${f1((run.stats?.interestKm2 ?? 0) * 100)} ha` : ''}</td></tr>`;
  }).join('');
  const marks = items.map(({ p, n }) => {
    const [x, y] = px(ov, p.lon, p.lat);
    return `<div class="mk" style="left:${x}%;top:${y}%"><b>${n}</b></div>`;
  }).join('');
  pages.push(`<section class="page">
  <h1>${L('ภาพรวมพื้นที่น้ำท่วมจากข่าว', 'Flood Places from News — Overview')}</h1><div class="rule"></div>
  <div class="two"><table class="kf"><thead><tr><th>#</th><th>${L('พื้นที่', 'Place')}</th><th>${L('ข่าว', 'News')}</th><th>${L('ข่าวล่าสุด', 'Latest')}</th><th>${L('ผลภาพดาวเทียม', 'Imagery result')}</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="map ov"><img src="${esri(ov, 900, 960)}" alt=""/>${marks}${NORTH}${scaleBar(ov, 120)}</div></div>
  ${items.length > 14 ? `<div class="src">${L(`แสดง 14 จาก ${items.length} แห่งในตาราง`, `Table shows 14 of ${items.length}`)}</div>` : ''}
  ${footer(2)}</section>`);

  // per place
  let pg = 3;
  for (const { p, n, run } of items) {
    const im = run ? imgs[run.id] : undefined;
    const g = aoiForPlace(p);
    const b: BBox = run?.bounds ?? (g ? { west: g.coordinates[0][0][0], south: g.coordinates[0][0][1], east: g.coordinates[0][2][0], north: g.coordinates[0][2][1] } : { west: p.lon - 0.1, east: p.lon + 0.1, south: p.lat - 0.1, north: p.lat + 0.1 });
    const frame = fit(b, 190 / 128, 0.08);
    const news = p.articleIds.map((id) => arts.get(id)!).filter(Boolean).slice(0, 4);
    const newsHtml = news.map((a) => `<div class="nw">${a.image ? `<img src="${esc(a.image)}" referrerpolicy="no-referrer" onerror="this.remove()" alt=""/>` : ''}<div><b>${esc(a.title)}</b><span>${esc(a.outlet)} · ${dmy(a.published ?? undefined)}</span></div></div>`).join('');
    const bullets = run ? narrative(run, inp.lang).map((x) => `<li>${esc(x)}</li>`).join('') : `<li>${L('ยังไม่ได้วิเคราะห์ภาพดาวเทียม', 'Not analysed')}</li>`;
    const hs = (run?.hotspots ?? []).slice(0, 8).map((h) => {
      const [x, y] = px(frame, h.lon, h.lat);
      return `<div class="hs" style="left:${x}%;top:${y}%">${h.n}</div>`;
    }).join('');
    const [cx_, cy_] = px(frame, p.lon, p.lat);
    const lc = inp.lcOf[p.key];
    const lcTxt = lc ? lc.slice(0, 3).map((x) => `${th ? x.labelTh : x.label} ${f1(x.km2 * 625, 0)} ${L('ไร่', 'rai')}`).join(' · ') : '';
    const legend = (run?.legend ?? []).map((l) => `<span><i style="background:${l.color}"></i>${esc(th ? l.labelTh : l.label)}</span>`).join('');
    pages.push(`<section class="page">
    <h1>${n}. ${esc(p.labelTh)}</h1><div class="rule"></div>
    <div class="aoi">
      <div class="side">
        <div class="box"><h3>${L('ข่าวที่รายงาน', 'Reported in the news')}</h3>
          <div class="meta">${esc(precTh(p.precision))} · ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)} · ${esc(p.geocoder)}</div>
          ${newsHtml}${p.articleIds.length > 4 ? `<div class="meta">+${p.articleIds.length - 4} ${L('ข่าว', 'more')}</div>` : ''}
        </div>
        <div class="box" style="flex:none"><h3>${L('ผลจากภาพดาวเทียม', 'From satellite imagery')}</h3><ul>${bullets}</ul>
          ${lcTxt ? `<div class="kv"><span>${L('ในกรอบ', 'In box')}</span><b style="font-weight:400;text-align:right">${esc(lcTxt)}</b></div>` : ''}
        </div>
      </div>
      <div class="map main">
        <img src="${esri(frame, 1140, 768)}" alt=""/>
        ${im?.after && run?.bounds ? `<img class="ov" style="${placed(frame, run.bounds)}" src="${im.after}" alt=""/>` : ''}
        ${im?.change && run?.overlayBounds ? `<img class="ov" style="${placed(frame, run.overlayBounds)}" src="${im.change}" alt=""/>` : ''}
        ${hs}
        <div class="locmk" style="left:${cx_}%;top:${cy_}%;background:#22d3ee"></div>
        <div class="tag tl mono">${run?.B ? `${dmy(run.B.datetime)} · ${run.sensor === 'sar' ? 'Sentinel-1 SAR' : 'Sentinel-2'}` : L('ภาพฐาน Esri', 'Esri basemap')}</div>
        ${im?.before ? `<div class="inset"><img src="${im.before}" alt=""/><div class="tag mono">${L('ก่อน', 'BEFORE')} ${dmy(run?.A?.datetime)}</div></div>` : ''}
        ${NORTH}${scaleBar(frame, 190)}
        <div class="legend"><b>${L('คำอธิบาย', 'LEGEND')}</b><span><i style="background:#22d3ee"></i>${L('ตำแหน่งจากข่าว', 'News location')}</span><span><i class="dot">1</i>${L('จุดที่ตรวจพบ', 'Detected patch')}</span>${legend}</div>
      </div>
    </div>
    <div class="src">${run?.status === 'ok' ? `${esc(run.A?.id ?? '')} → ${esc(run.B?.id ?? '')} · Microsoft Planetary Computer · ` : ''}${L('แผนที่ฐาน Esri World Imagery', 'Esri World Imagery basemap')}</div>
    ${footer(pg++)}</section>`);
  }

  // method
  const feedRows = inp.snap.feeds.map((f) => `<tr><td>${esc(f.label)}</td><td class="c">${f.status === 'ok' ? 'OK' : esc(f.error ?? 'error')}</td><td class="c">${f.count}</td><td class="mono">${dmy(f.fetchedAt)}</td></tr>`).join('');
  pages.push(`<section class="page">
  <h1>${L('วิธีการ แหล่งข้อมูล และข้อจำกัด', 'Method, Sources & Limitations')}</h1><div class="rule"></div>
  <table class="kf small"><thead><tr><th>${L('แหล่งข่าว', 'News feed')}</th><th>${L('สถานะ', 'Status')}</th><th>${L('จำนวน', 'Items')}</th><th>${L('ดึงเมื่อ', 'Fetched')}</th></tr></thead><tbody>${feedRows}</tbody></table>
  <h2>${L('วิธีการ', 'Method')}</h2><ul class="lim">
  <li>${L('คัดข่าวที่มีคำว่า น้ำท่วม/อุทกภัย/น้ำล้นตลิ่ง/น้ำป่า แล้วอ่านเนื้อข่าวจากเว็บต้นทาง ตัดข่าวซ้ำด้วยพาดหัว', 'Stories containing flood terms; full text read from the publisher; duplicates removed by headline')}</li>
  <li>${L('อ่านชื่อ ต./อ./จ. ในข่าว แล้วค้นพิกัดด้วย OpenStreetMap Nominatim ยอมรับเฉพาะผลที่อยู่ในจังหวัดที่ข่าวระบุ ข่าวที่กล่าวถึงมากกว่า 4 จังหวัดโดยไม่มีระดับอำเภอ (เช่น ประกาศเตือนภัย) ไม่ถูกนำมาระบุตำแหน่ง', 'Tambon/amphoe/province names geocoded with Nominatim and accepted only inside the named province; stories naming over 4 provinces without districts (e.g. warnings) are not located')}</li>
  <li>${L('กรอบวิเคราะห์: ระดับตำบล ±4 กม. ระดับอำเภอ ±8 กม. หมุด ±3 กม. รอบจุด · ตรวจน้ำใหม่ด้วยเรดาร์ Sentinel-1 (VV < −18 dB) หรือ Sentinel-2 (MNDWI) เทียบภาพก่อนหน้า 14 วัน', 'Box ±4 km (tambon), ±8 km (amphoe), ±3 km (pin); new water from Sentinel-1 (VV < −18 dB) or Sentinel-2 (MNDWI) vs. a reference image')}</li></ul>
  <h2>${L('ข้อจำกัด', 'Limitations')}</h2><ul class="lim">
  <li>${L('ตำแหน่งมาจากข้อความในข่าว ไม่ได้วิเคราะห์จากภาพข่าว ตำแหน่งระดับอำเภอ/จังหวัดเป็นจุดศูนย์กลางของเขตปกครอง ไม่ใช่จุดที่น้ำท่วม', 'Locations come from text, not photos; amphoe/province points are administrative centres, not the flood itself')}</li>
  <li>${L('เรดาร์อาจสับสนน้ำท่วมกับนาข้าวที่มีน้ำขัง พื้นผิวเรียบ หรือเงาภูเขา ภาพเมฆมากอาจทำให้ไม่มีภาพที่ใช้ได้', 'Radar can confuse flooding with flooded paddies, smooth surfaces or terrain shadow; clouds can leave no usable optical image')}</li>
  <li>${L('ไม่มีการประเมินจำนวนผู้ประสบภัยหรือความเสียหาย ใช้ตัวเลขทางการจาก ปภ. เมื่ออ้างอิง', 'No estimate of people affected or losses; use official DDPM figures')}</li></ul>
  <h2>${L('แหล่งข้อมูล', 'Sources')}</h2><ul class="lim"><li>Google News (${L('สำนักข่าวและเว็บไซต์ *.go.th', 'outlets and *.go.th')}), GDELT Project · OpenStreetMap Nominatim · geoBoundaries · Copernicus Sentinel-1/-2 via Microsoft Planetary Computer · ESA WorldCover 2021 · Esri World Imagery</li></ul>
  ${footer(pg)}</section>`);

  const extraCss = `<style>.nw{display:flex;gap:1.5mm;margin-bottom:1.2mm;font-size:7.6pt;line-height:1.25}.nw img{width:16mm;height:11mm;object-fit:cover;flex:none}.nw b{display:block;font-weight:600}.nw span{color:#555;font-size:6.8pt}</style>`;
  return reportShell(inp.title, inp.lang, pages).replace('</head>', `${extraCss}</head>`);
}
