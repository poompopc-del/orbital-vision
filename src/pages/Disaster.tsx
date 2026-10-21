import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { create } from 'zustand';
import { useLang } from '../i18n';
import GlobeHost from '../components/GlobeHost';
import { Badge, Button, Notice, Panel, Select, Spinner, cx } from '../components/ui';
import { Cesium } from '../lib/cesium';
import {
  fetchAll, FRESH_TH, HAZARDS, hazardOf, provinceLabel, REGISTRY, STATUS_TH,
  type DEvent, type Hazard, type Snapshot, type SourceState,
} from '../lib/disaster';
import { thProvince } from '../lib/provinces';
import { aoiFromPolygon, landCoverShares, narrative, runMonitor, type MonitorRun, type Purpose } from '../lib/monitor';
import { useMonitor } from './Monitor';
import { esc, esri, fit, NORTH, px, reportShell, scaleBar, zulu, type BBox } from '../lib/report';

// ---------------------------------------------------------------- shared state

interface DState {
  snap: Snapshot | null;
  loading: boolean;
  live: Record<string, SourceState>;
  days: number;
  error: string;
  load: (days: number) => Promise<void>;
}
export const useDisaster = create<DState>((set, get) => ({
  snap: null,
  loading: false,
  live: {},
  days: 1,
  error: '',
  load: async (days) => {
    if (get().loading) return;
    set({ loading: true, days, error: '', live: {} });
    try {
      const snap = await fetchAll(days, (s) => set((st) => ({ live: { ...st.live, [s.id]: s } })));
      set({ snap, loading: false });
    } catch (e: any) {
      set({ loading: false, error: e?.message ?? String(e) });
    }
  },
}));

const useL = () => {
  const lang = useLang((s) => s.lang);
  return (th: string, en: string) => (lang === 'th' ? th : en);
};
const tTime = (iso?: string) => (iso ? new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }) : '—');
const ago = (iso?: string) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 60 ? `${m} นาทีที่แล้ว` : m < 48 * 60 ? `${Math.round(m / 60)} ชม.ที่แล้ว` : `${Math.round(m / 1440)} วันที่แล้ว`;
};
const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'idle' | 'cyan'> = { ok: 'ok', error: 'bad', 'needs-key': 'warn', 'no-api': 'idle', loading: 'cyan', idle: 'idle' };

// ---------------------------------------------------------------- filters

interface Filter {
  hazards: Set<Hazard>;
  province: string;
  inThai: boolean;
  activeOnly: boolean;
}
function applyFilter(evs: DEvent[], f: Filter) {
  return evs.filter((e) => f.hazards.has(e.hazard) && (!f.inThai || !!e.province) && (!f.province || e.province === f.province) && (!f.activeOnly || e.status !== 'closed'));
}

// ---------------------------------------------------------------- map page

export function DisasterMap() {
  const L = useL();
  const { snap, loading, live, load, days, error } = useDisaster();
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const [f, setF] = useState<Filter>({ hazards: new Set(HAZARDS.map((h) => h.id)), province: '', inThai: true, activeOnly: true });
  const [sel, setSel] = useState<DEvent | null>(null);
  const [layers, setLayers] = useState({ hotspots: true, wl: false, rain: false, pm: false });

  useEffect(() => {
    if (!snap && !loading) void load(days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (viewer) viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(100.9, 12.5, 2.6e6) });
  }, [viewer]);

  const events = useMemo(() => (snap ? applyFilter(snap.events, f) : []), [snap, f]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    (snap?.events ?? []).filter((e) => (!f.inThai || e.province) && (!f.province || e.province === f.province)).forEach((e) => (c[e.hazard] = (c[e.hazard] ?? 0) + 1));
    return c;
  }, [snap, f.inThai, f.province]);
  const hotspotsShown = useMemo(() => {
    if (!snap) return [];
    return snap.hotspots.filter((h) => {
      if (!f.inThai && !f.province) return true;
      const pr = snap.provinces?.find((p) => h.lon >= p.bbox[0] && h.lon <= p.bbox[2] && h.lat >= p.bbox[1] && h.lat <= p.bbox[3]);
      return f.province ? pr?.en === f.province || false : !!pr;
    });
  }, [snap, f.inThai, f.province]);

  // ---- events + layers on the globe
  useEffect(() => {
    if (!viewer || !snap) return;
    const ds = new Cesium.CustomDataSource('disaster');
    const pts = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    if (layers.hotspots && f.hazards.has('fire'))
      hotspotsShown.forEach((h) => pts.add({ position: Cesium.Cartesian3.fromDegrees(h.lon, h.lat), pixelSize: 4, color: Cesium.Color.fromCssColorString('#ff5a1f').withAlpha(0.85) }));
    const wlCol = ['#990000', '#990000', '#FFC000', '#00B050', '#003CFA', '#FF0000'];
    snap.stations.forEach((s) => {
      if (s.kind === 'wl' && layers.wl) pts.add({ position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat), pixelSize: 6, color: Cesium.Color.fromCssColorString(wlCol[s.level ?? 3] ?? '#888'), outlineColor: Cesium.Color.BLACK, outlineWidth: 1 });
      if (s.kind === 'rain' && layers.rain) pts.add({ position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat), pixelSize: Math.min(14, 4 + s.value / 15), color: Cesium.Color.fromCssColorString('#06b6d4').withAlpha(0.8) });
      if (s.kind === 'pm' && layers.pm) pts.add({ position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat), pixelSize: 7, color: Cesium.Color.fromCssColorString(s.value > 75 ? '#dc2626' : s.value > 37.5 ? '#f59e0b' : '#22c55e'), outlineColor: Cesium.Color.BLACK, outlineWidth: 1 });
    });
    events.forEach((e) => {
      const col = Cesium.Color.fromCssColorString(hazardOf(e.hazard).color);
      ds.entities.add({
        id: `ev:${e.id}`,
        position: Cesium.Cartesian3.fromDegrees(e.lon, e.lat),
        point: { pixelSize: 8 + e.severity * 4, color: col.withAlpha(e.status === 'closed' ? 0.4 : 0.95), outlineColor: e.id === sel?.id ? Cesium.Color.WHITE : Cesium.Color.BLACK, outlineWidth: e.id === sel?.id ? 3 : 1, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
    });
    if (f.province && snap.provinces) {
      const pr = snap.provinces.find((p) => p.en === f.province);
      const polys = pr ? (pr.geometry.type === 'Polygon' ? [pr.geometry.coordinates] : pr.geometry.coordinates) : [];
      polys.forEach((rings) => ds.entities.add({ polyline: { positions: rings[0].map(([x, y]) => Cesium.Cartesian3.fromDegrees(x, y)), width: 2.5, material: Cesium.Color.YELLOW } }));
    }
    void viewer.dataSources.add(ds);
    viewer.scene.requestRender();
    return () => {
      if (!viewer.isDestroyed()) {
        viewer.dataSources.remove(ds, true);
        viewer.scene.primitives.remove(pts);
      }
    };
  }, [viewer, snap, events, hotspotsShown, layers, sel?.id, f.province, f.hazards]);

  useEffect(() => {
    if (!viewer) return;
    const h = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    h.setInputAction((m: any) => {
      const p = viewer.scene.pick(m.position);
      const id: string | undefined = p?.id?.id;
      if (id?.startsWith('ev:')) setSel(useDisaster.getState().snap?.events.find((e) => `ev:${e.id}` === id) ?? null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return () => h.destroy();
  }, [viewer]);

  const flyTo = (e: DEvent) => {
    setSel(e);
    viewer?.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(e.lon, e.lat, e.hazard === 'quake' ? 600000 : 120000), duration: 1.2 });
  };
  const flyProvince = (en: string) => {
    setF({ ...f, province: en });
    const pr = snap?.provinces?.find((p) => p.en === en);
    if (pr && viewer) viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(pr.bbox[0] - 0.2, pr.bbox[1] - 0.2, pr.bbox[2] + 0.2, pr.bbox[3] + 0.2), duration: 1.2 });
  };

  const states = snap ? { ...snap.states, ...live } : live;
  const okN = Object.values(states).filter((s) => s.status === 'ok').length;
  const badN = Object.values(states).filter((s) => s.status === 'error').length;

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-2.5 overflow-y-auto border-line p-3 scroll-thin lg:w-[420px] lg:border-r">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400">THAILAND · DISASTER INTELLIGENCE</div>
          <h2 className="text-lg font-semibold text-white">{L('แผนที่สถานการณ์ภัยพิบัติ', 'Disaster situation map')}</h2>
          <p className="text-[11px] text-muted">{L('รวมข้อมูลเปิดจากหน่วยงานไทยและนานาชาติ ทุกจุดลิงก์กลับไปยังแหล่งต้นทาง', 'Open data from Thai and international agencies; every item links back to its source')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {[1, 7, 30].map((d) => <Button key={d} variant={days === d ? 'active' : 'ghost'} disabled={loading} onClick={() => load(d)}>{d === 1 ? L('24 ชม.', '24 h') : L(`${d} วัน`, `${d} days`)}</Button>)}
          <Button onClick={() => load(days)} disabled={loading}>{loading ? <Spinner /> : `↻ ${L('ดึงข้อมูลใหม่', 'Refresh')}`}</Button>
        </div>
        <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted">
          <Link to="/disaster?tab=sources" className="hover:text-white"><Badge tone={badN ? 'warn' : 'ok'}>{L(`แหล่งข้อมูลใช้ได้ ${okN}`, `${okN} sources ok`)}{badN ? ` · ${L('ขัดข้อง', 'failing')} ${badN}` : ''}</Badge></Link>
          {snap && <span>{L('ดึงล่าสุด', 'Fetched')} {tTime(snap.at)}</span>}
        </div>
        {error && <Notice tone="bad">{error}</Notice>}

        <Panel title={L('ประเภทภัย', 'Hazards')}>
          <div className="grid grid-cols-2 gap-1">
            {HAZARDS.filter((h) => h.id !== 'other' || counts.other).map((h) => {
              const on = f.hazards.has(h.id);
              return (
                <button
                  key={h.id}
                  onClick={() => { const s = new Set(f.hazards); on ? s.delete(h.id) : s.add(h.id); setF({ ...f, hazards: s }); }}
                  className={cx('flex items-center gap-1.5 rounded border px-2 py-1 text-left text-[11px]', on ? 'border-white/20 bg-white/5 text-white' : 'border-line text-muted line-through')}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: h.color }} />
                  <span className="flex-1">{h.icon} {L(h.th, h.en)}</span>
                  <span className="font-mono">{counts[h.id] ?? 0}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <Select value={f.province} onChange={(e) => (e.target.value ? flyProvince(e.target.value) : setF({ ...f, province: '' }))} className="!py-1 text-xs">
              <option value="">{L('ทุกจังหวัด', 'All provinces')}</option>
              {[...(snap?.provinces ?? [])].sort((a, b) => a.th.localeCompare(b.th, 'th')).map((p) => <option key={p.en} value={p.en}>{L(p.th, p.en)}</option>)}
            </Select>
            <div className="flex flex-col gap-0.5 text-[11px] text-slate-300">
              <label className="flex items-center gap-1"><input type="checkbox" checked={f.inThai} onChange={(e) => setF({ ...f, inThai: e.target.checked })} />{L('เฉพาะในไทย', 'Thailand only')}</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={f.activeOnly} onChange={(e) => setF({ ...f, activeOnly: e.target.checked })} />{L('ยังดำเนินอยู่', 'Ongoing only')}</label>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
            <span className="label pr-1">{L('ชั้นข้อมูล', 'Layers')}</span>
            {([['hotspots', L('จุดความร้อนทุกจุด', 'All hotspots')], ['wl', L('สถานีระดับน้ำ', 'Water-level stations')], ['rain', L('ฝน ≥ 35 มม.', 'Rain ≥ 35 mm')], ['pm', 'PM2.5']] as const).map(([k, l]) => (
              <Button key={k} variant={layers[k] ? 'active' : 'ghost'} onClick={() => setLayers({ ...layers, [k]: !layers[k] })}>{l}</Button>
            ))}
          </div>
        </Panel>

        {loading && (
          <Panel>
            <div className="space-y-0.5 text-[11px]">
              {REGISTRY.filter((r) => r.via !== '—').map((r) => {
                const s = live[r.id];
                return <div key={r.id} className="flex items-center justify-between"><span className="text-slate-300">{r.name}</span><span className={s?.status === 'ok' ? 'text-ok' : s?.status === 'error' ? 'text-bad' : 'text-muted'}>{s ? (s.status === 'loading' ? '…' : s.status === 'ok' ? `✓ ${s.count}` : '✕') : '…'}</span></div>;
              })}
            </div>
          </Panel>
        )}

        <Panel title={L(`เหตุการณ์ (${events.length})`, `Events (${events.length})`)} bodyClass="p-0">
          {!events.length && !loading && <p className="p-3 text-[11px] text-muted">{L('ไม่มีเหตุการณ์ตามตัวกรอง', 'No events for these filters')}</p>}
          <ul className="max-h-[38vh] overflow-y-auto scroll-thin">
            {events.slice(0, 200).map((e) => (
              <li key={e.id}>
                <button onClick={() => flyTo(e)} className={cx('flex w-full items-start gap-2 border-b border-white/5 px-3 py-1.5 text-left hover:bg-white/5', sel?.id === e.id && 'bg-cyan-400/10')}>
                  <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: hazardOf(e.hazard).color, opacity: 0.4 + e.severity * 0.2 }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] text-white">{e.title}</span>
                    <span className="block truncate text-[10px] text-muted">{provinceLabel(e.province)} · {tTime(e.time)} · {e.source.toUpperCase()}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>

        {!!snap?.bulletins.length && (
          <Panel title={L('ประกาศ / คำเตือนล่าสุด', 'Latest warnings & bulletins')} bodyClass="p-0">
            <ul className="max-h-56 overflow-y-auto scroll-thin">
              {snap.bulletins.slice(0, 25).map((b, i) => (
                <li key={i} className="border-b border-white/5 px-3 py-1.5 text-[11px]">
                  <div className="text-[10px] text-muted">{b.source === 'tmd' ? 'กรมอุตุนิยมวิทยา' : b.source === 'cems' ? 'Copernicus EMS' : 'ThaiWater'} · {tTime(b.time)}</div>
                  <div className="whitespace-pre-line text-slate-200">{b.text.slice(0, 400)}</div>
                  {b.url && <a href={b.url} target="_blank" rel="noreferrer" className="text-[10px] text-cyan-300 hover:underline">{L('ต้นฉบับ ↗', 'Source ↗')}</a>}
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </aside>

      <div className="relative min-h-[360px] flex-1">
        <GlobeHost onReady={setViewer} />
        <div className="absolute bottom-8 left-3 z-10 rounded-md border border-line bg-ink-950/85 p-2 text-[10px] text-slate-200 backdrop-blur">
          {HAZARDS.filter((h) => h.id !== 'other').map((h) => <div key={h.id} className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: h.color }} />{L(h.th, h.en)}</div>)}
          <div className="mt-1 text-muted">{L('จุดใหญ่ = ระดับสูงกว่า (ดูเกณฑ์ในรายละเอียด)', 'Bigger = higher level (criteria in detail)')}</div>
        </div>
        {sel && <DetailPanel e={sel} onClose={() => setSel(null)} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- detail + impact

const PURPOSE_FOR: Partial<Record<Hazard, Purpose>> = { flood: 'water', storm: 'water', fire: 'fire', drought: 'general', quake: 'general' };
const KM = (lat: number) => ({ dy: 1 / 110.574, dx: 1 / (111.32 * Math.cos((lat * Math.PI) / 180)) });
function aoiForEvent(e: DEvent): GeoJSON.Polygon {
  const k = KM(e.lat);
  let [w, s, ee, n] = e.bbox ?? [e.lon, e.lat, e.lon, e.lat];
  const half = e.bbox ? 2 : e.hazard === 'quake' ? 10 : 5;
  w -= half * k.dx; ee += half * k.dx; s -= half * k.dy; n += half * k.dy;
  return { type: 'Polygon', coordinates: [[[w, s], [ee, s], [ee, n], [w, n], [w, s]]] };
}

function DetailPanel({ e, onClose }: { e: DEvent; onClose: () => void }) {
  const L = useL();
  const hz = hazardOf(e.hazard);
  const { setAois, addRun, aois } = useMonitor();
  const [busy, setBusy] = useState('');
  const [run, setRun] = useState<MonitorRun | null>(null);
  const [lc, setLc] = useState<{ label: string; labelTh: string; km2: number }[] | null | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    setRun(null);
    setLc(undefined);
    abort.current?.abort();
  }, [e.id]);
  const purpose = PURPOSE_FOR[e.hazard];
  const existing = aois.find((a) => a.notes === `event:${e.id}`);

  const makeAoi = () => {
    if (existing) return existing;
    const a = { ...aoiFromPolygon(`${hz.th} · ${e.title.slice(0, 40)}`, aoiForEvent(e), 'TH', purpose ?? 'general', 7), notes: `event:${e.id}` };
    setAois((l) => [...l, a]);
    return a;
  };
  const assess = async () => {
    const a = makeAoi();
    const ac = new AbortController();
    abort.current = ac;
    try {
      setBusy(L('อ่านสิ่งปกคลุมดิน…', 'Reading land cover…'));
      setLc(await landCoverShares(a.geometry, ac.signal).catch(() => null));
      const daysSince = Math.max(7, Math.ceil((Date.now() - new Date(e.time).getTime()) / 86400e3) + 1);
      const r = await runMonitor(a, Math.min(daysSince, 60), (m) => setBusy(m), ac.signal);
      addRun(r);
      setRun(r);
    } catch (err: any) {
      if (err?.name !== 'AbortError') setBusy(String(err?.message ?? err));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="absolute right-3 top-3 z-20 max-h-[calc(100%-1.5rem)] w-[380px] overflow-y-auto rounded-md border border-line bg-navy-900/95 p-3 text-xs shadow-2xl scroll-thin">
      <div className="mb-1 flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider" style={{ color: hz.color }}>{hz.icon} {L(hz.th, hz.en)}</div>
          <div className="text-sm font-semibold text-white">{e.title}</div>
        </div>
        <button onClick={onClose} className="text-muted hover:text-white">✕</button>
      </div>
      <div className="flex flex-wrap gap-1">
        <Badge tone={e.status === 'confirmed' ? 'ok' : e.status === 'closed' ? 'idle' : 'warn'}>{L(STATUS_TH[e.status], e.status)}</Badge>
        <Badge tone="cyan">{e.severityText}</Badge>
      </div>
      <dl className="mt-2 grid grid-cols-[110px_1fr] gap-x-2 gap-y-0.5 text-[11px]">
        <dt className="text-muted">{L('ตำแหน่ง', 'Location')}</dt><dd className="font-mono text-slate-200">{e.lat.toFixed(4)}, {e.lon.toFixed(4)}</dd>
        <dt className="text-muted">{L('จังหวัด', 'Province')}</dt><dd className="text-slate-200">{provinceLabel(e.province)}</dd>
        <dt className="text-muted">{L('เวลาเกิด / ตรวจวัด', 'Event / measured')}</dt><dd className="text-slate-200">{tTime(e.time)} <span className="text-muted">({ago(e.time)})</span></dd>
        {e.reported && <><dt className="text-muted">{L('เวลารายงาน', 'Reported')}</dt><dd className="text-slate-200">{tTime(e.reported)}</dd></>}
        <dt className="text-muted">{L('ดึงเข้าระบบ', 'Fetched')}</dt><dd className="text-slate-200">{tTime(e.fetchedAt)}</dd>
        <dt className="text-muted">{L('แหล่งข้อมูล', 'Source')}</dt><dd className="text-slate-200">{REGISTRY.find((r) => r.id === e.source)?.org} · <span className="font-mono text-[10px]">{e.sourceId}</span></dd>
        {Object.entries(e.details).filter(([, v]) => v != null && v !== '').map(([k, v]) => <FragmentKV key={k} k={k} v={String(v)} />)}
        {e.alsoIn?.length ? <><dt className="text-muted">{L('พบในแหล่งอื่น', 'Also in')}</dt><dd className="text-slate-200">{e.alsoIn.join(', ')}</dd></> : null}
      </dl>
      {e.url && <a href={e.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[11px] text-cyan-300 hover:underline">{L('เปิดข้อมูลต้นฉบับ ↗', 'Open original source ↗')}</a>}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {purpose && <Button variant="primary" disabled={!!busy} onClick={assess}>{busy ? <Spinner /> : L('วิเคราะห์ผลกระทบจากภาพดาวเทียม', 'Assess impact from imagery')}</Button>}
        {purpose && <Button onClick={() => { makeAoi(); }}>{existing ? L('อยู่ในรายการเฝ้าระวังแล้ว', 'In watchlist') : L('+ เพิ่มเป็น AOI เฝ้าระวัง', '+ Add as watch AOI')}</Button>}
        {busy && <Button variant="danger" onClick={() => abort.current?.abort()}>{L('หยุด', 'Stop')}</Button>}
      </div>
      {!purpose && <p className="mt-2 text-[10px] text-muted">{L('ฝุ่น PM2.5 วัดจากสถานีภาคพื้น ไม่ได้วิเคราะห์ด้วยภาพดาวเทียม', 'PM2.5 is a ground-station measurement; no imagery analysis applies.')}</p>}
      {busy && <p className="mt-1 text-[10px] text-cyan-300">{busy}</p>}

      {(lc !== undefined || run) && (
        <div className="mt-3 space-y-2 border-t border-line pt-2">
          <Section n="1" title={L('ข้อเท็จจริงจากแหล่งข้อมูล', 'Facts from the source')}>
            <p>{e.title} — {e.severityText} ({L(STATUS_TH[e.status], e.status)}, {REGISTRY.find((r) => r.id === e.source)?.org})</p>
          </Section>
          <Section n="2" title={L('ผลจากภาพดาวเทียม', 'From satellite imagery')}>
            {run ? <ul className="list-disc pl-4">{narrative(run, 'th').map((x) => <li key={x}>{x}</li>)}</ul> : <p className="text-muted">…</p>}
            {run?.note && <p className="text-[10px] text-warn">{run.note}</p>}
          </Section>
          <Section n="3" title={L('ซ้อนทับข้อมูล GIS (ESA WorldCover 2021)', 'GIS overlay (ESA WorldCover 2021)')}>
            {lc ? <ul>{lc.map((x) => <li key={x.label}>{L(x.labelTh, x.label)}: <b>{x.km2.toFixed(2)}</b> km² ({(x.km2 * 625).toFixed(0)} {L('ไร่', 'rai')})</li>)}</ul> : <p className="text-muted">{lc === null ? L('อ่านข้อมูลสิ่งปกคลุมดินไม่ได้', 'Land cover unavailable') : '…'}</p>}
            <p className="text-[10px] text-muted">{L('เป็นสิ่งที่อยู่ “ภายในขอบเขต” ไม่ได้แปลว่าได้รับความเสียหาย', 'What lies inside the area — not what was damaged')}</p>
          </Section>
          <Section n="4" title={L('ต้องตรวจสอบเพิ่มเติม', 'Needs verification')}>
            <ul className="list-disc pl-4">
              <li>{L('ขอบเขตพื้นที่วิเคราะห์เป็นกรอบรอบจุดเหตุการณ์ ไม่ใช่ขอบเขตผลกระทบจริง', 'The analysis box is drawn around the event point, not the true affected extent')}</li>
              {e.hazard === 'fire' && <li>{L('จำนวนจุดความร้อนไม่ใช่ขนาดพื้นที่เผาไหม้', 'Hotspot count is not burned area')}</li>}
              {e.hazard === 'flood' && <li>{L('ระดับน้ำล้นตลิ่งที่สถานี ไม่ได้บอกขนาดพื้นที่น้ำท่วม', 'A station over its bank does not give the flooded area')}</li>}
              <li>{L('ไม่มีการประเมินจำนวนผู้ประสบภัยหรือความเสียหายทางเศรษฐกิจ', 'No estimate of people affected or economic loss is made')}</li>
            </ul>
          </Section>
          {run && <Link to="/monitor?tab=watch" className="text-[11px] text-cyan-300 hover:underline">{L('ดูภาพก่อน–หลังและรายละเอียดในหน้าเฝ้าระวัง →', 'See before/after images in the watchlist →')}</Link>}
        </div>
      )}
    </div>
  );
}

const DETAIL_TH: Record<string, string> = {
  magnitude: 'ขนาด', depth_km: 'ความลึก (กม.)', mag_type: 'ชนิดขนาด', felt_reports: 'รายงานความรู้สึก', tsunami_flag: 'ธงสึนามิ', review: 'สถานะตรวจทาน',
  hotspots: 'จำนวนจุดความร้อน', first_detection: 'ตรวจพบครั้งแรก (UTC)', last_detection: 'ตรวจพบล่าสุด (UTC)', max_frp_mw: 'FRP สูงสุด (MW)', high_conf: 'ความเชื่อมั่นสูง (จุด)', sensors: 'เซนเซอร์',
  station: 'สถานี', river_capacity_pct: '% ความจุลำน้ำ', water_level_msl_m: 'ระดับน้ำ (ม.รทก.)', previous_msl_m: 'ระดับก่อนหน้า (ม.รทก.)', bank_left_m: 'ตลิ่งซ้าย (ม.)', bank_right_m: 'ตลิ่งขวา (ม.)', basin: 'ลุ่มน้ำ', amphoe: 'อำเภอ', agency: 'หน่วยงาน',
  rain_24h_mm: 'ฝน 24 ชม. (มม.)', rain_1h_mm: 'ฝน 1 ชม. (มม.)', area: 'พื้นที่', pm25_ugm3: 'PM2.5 (µg/m³)', aqi: 'AQI', country: 'ประเทศ', alert: 'ระดับเตือน', from: 'เริ่ม', to: 'ถึง', severity: 'ความรุนแรง',
};
function FragmentKV({ k, v }: { k: string; v: string }) {
  const lang = useLang((s) => s.lang);
  return (<><dt className="text-muted">{lang === 'th' ? DETAIL_TH[k] ?? k : k}</dt><dd className="break-words text-slate-200">{v}</dd></>);
}
function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div className="text-[11px] text-slate-200">
      <div className="mb-0.5 font-semibold text-cyan-300">{n}. {title}</div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- sources page

export function DisasterSources() {
  const L = useL();
  const { snap, live, loading, load, days } = useDisaster();
  const states = snap ? { ...snap.states, ...live } : live;
  return (
    <div className="h-full overflow-y-auto scroll-thin">
      <div className="mx-auto max-w-6xl space-y-3 p-4">
        <div className="flex items-end justify-between gap-2">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400">DATA PROVIDER REGISTRY</div>
            <h2 className="text-lg font-semibold text-white">{L('แหล่งข้อมูลและสถานะการเชื่อมต่อ', 'Data sources & connection health')}</h2>
          </div>
          <Button onClick={() => load(days)} disabled={loading}>{loading ? <Spinner /> : `↻ ${L('ตรวจทุกแหล่งใหม่', 'Re-check all')}`}</Button>
        </div>
        <div className="overflow-x-auto rounded border border-line scroll-thin">
          <table className="w-full min-w-[980px] text-left text-[11px]">
            <thead className="label bg-white/5"><tr><th className="px-2 py-1.5">{L('แหล่งข้อมูล', 'Source')}</th><th>{L('สถานะ', 'Status')}</th><th>{L('ความสด', 'Freshness')}</th><th>{L('ข้อมูลต้นทางล่าสุด', 'Upstream time')}</th><th>{L('ดึงเข้าระบบ', 'Fetched')}</th><th>{L('จำนวน', 'Items')}</th><th>{L('รูปแบบ / ทาง', 'Format / via')}</th><th className="pr-2">{L('เงื่อนไข / หมายเหตุ', 'Terms / note')}</th></tr></thead>
            <tbody>
              {REGISTRY.map((r) => {
                const s = states[r.id];
                return (
                  <tr key={r.id} className="border-t border-white/5 align-top">
                    <td className="px-2 py-1.5"><div className="text-white">{r.name}</div><div className="text-muted">{r.org}</div><div className="font-mono text-[10px] text-muted">{r.endpoint}</div></td>
                    <td><Badge tone={STATUS_TONE[s?.status ?? 'idle']}>{s?.status ?? '—'}</Badge></td>
                    <td className="text-slate-200">{s ? L(FRESH_TH[s.freshness], s.freshness) : '—'}</td>
                    <td className="text-slate-200">{tTime(s?.upstreamTime)}</td>
                    <td className="text-slate-200">{tTime(s?.fetchedAt)}</td>
                    <td className="font-mono text-slate-200">{s?.count ?? 0}</td>
                    <td className="text-muted">{r.format} · {r.via} · {r.cadence}</td>
                    <td className="pr-2 text-muted">{s?.message ?? r.terms}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Notice>
          {L(
            'ไม่มีแหล่งใดถูกสมมติว่าใช้งานได้: ทุกแหล่งถูกเรียกจริงทุกครั้งที่ดึงข้อมูล ถ้าล้มเหลวจะแสดง “error” และไม่แสดงข้อมูลเก่าเป็นข้อมูลปัจจุบัน · GISTDA ต้องสมัคร API key (ฟรี) ก่อนจึงจะเชื่อมได้ · ปภ. ยังไม่พบ API สาธารณะแบบเครื่องอ่านได้',
            'No source is assumed to work: each is called on every refresh; failures show “error” and old data is never shown as current · GISTDA needs a (free) API key before it can be connected · No machine-readable public API was found for DDPM.',
          )}
        </Notice>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- situation report

export function DisasterReport() {
  const L = useL();
  const lang0 = useLang((s) => s.lang);
  const { snap, loading, load, days } = useDisaster();
  const { aois, runs } = useMonitor();
  const [lang, setLang] = useState<'th' | 'en'>(lang0);
  const [title, setTitle] = useState('รายงานสถานการณ์ภัยพิบัติประเทศไทย');
  const [hz, setHz] = useState<Set<Hazard>>(new Set(HAZARDS.map((h) => h.id)));
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!snap && !loading) void load(days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = () => {
    if (!snap) return;
    setErr('');
    const html = buildDisasterReport(snap, { title, lang, hazards: hz }, aois.filter((a) => a.notes?.startsWith('event:')).map((a) => ({ name: a.name, run: runs.find((r) => r.aoiId === a.id) })));
    const w = window.open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank');
    if (!w) setErr(L('เบราว์เซอร์บล็อกหน้าต่างใหม่ — อนุญาตป๊อปอัปแล้วลองอีกครั้ง', 'Pop-up blocked — allow pop-ups and try again'));
  };
  const csv = () => {
    if (!snap) return;
    const rows = snap.events.filter((e) => hz.has(e.hazard)).map((e) => [e.hazard, `"${e.title.replace(/"/g, "'")}"`, e.lat.toFixed(5), e.lon.toFixed(5), e.province ?? '', `"${thProvince(e.province)}"`, e.time, e.reported ?? '', e.fetchedAt, e.status, `"${e.severityText}"`, e.source, e.sourceId, e.url ?? ''].join(','));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿hazard,title,lat,lon,province_en,province_th,event_time_utc,reported_utc,fetched_utc,status,severity,source,source_id,url\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = 'thailand-disaster-events.csv';
    a.click();
  };

  return (
    <div className="h-full overflow-y-auto scroll-thin">
      <div className="mx-auto max-w-3xl space-y-3 p-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400">SITUATION REPORT</div>
          <h2 className="text-lg font-semibold text-white">{L('รายงานสถานการณ์ภัยพิบัติ', 'Disaster situation report')}</h2>
          <p className="text-[11px] text-muted">{L('สรุปจากข้อมูลที่ดึงล่าสุด: ภาพรวม → แผนที่ → ตารางรายจังหวัด → เหตุการณ์สำคัญ → ประกาศเตือนภัย → ผลวิเคราะห์ภาพดาวเทียม → แหล่งข้อมูลและเวลา', 'From the latest fetch: overview → map → by province → key events → warnings → imagery assessments → sources & times')}</p>
        </div>
        <Panel>
          <div className="space-y-2">
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded border border-line bg-ink-900 px-2 py-1.5 text-sm text-white" />
            <div className="flex flex-wrap gap-1">
              <Button variant={lang === 'th' ? 'active' : 'ghost'} onClick={() => setLang('th')}>ไทย</Button>
              <Button variant={lang === 'en' ? 'active' : 'ghost'} onClick={() => setLang('en')}>English</Button>
              <span className="mx-1 w-px bg-line" />
              {HAZARDS.filter((h) => h.id !== 'other').map((h) => <Button key={h.id} variant={hz.has(h.id) ? 'active' : 'ghost'} onClick={() => { const s = new Set(hz); s.has(h.id) ? s.delete(h.id) : s.add(h.id); setHz(s); }}>{h.icon} {L(h.th, h.en)}</Button>)}
            </div>
            <p className="text-[11px] text-muted">{snap ? `${L('ข้อมูลช่วง', 'Window')} ${snap.days === 1 ? '24 ชม.' : `${snap.days} วัน`} · ${L('ดึงเมื่อ', 'fetched')} ${tTime(snap.at)}` : L('กำลังโหลดข้อมูล…', 'Loading…')}</p>
          </div>
        </Panel>
        <div className="flex flex-wrap gap-1.5">
          <Button variant="primary" disabled={!snap} onClick={open}>📄 {L('เปิดรายงาน (บันทึกเป็น PDF ได้)', 'Open report (save as PDF)')}</Button>
          <Button disabled={!snap} onClick={csv}>{L('ตารางเหตุการณ์ CSV', 'Events CSV')}</Button>
        </div>
        {err && <Notice tone="bad">{err}</Notice>}
        <Notice>{L('ภาพก่อน–หลังรายพื้นที่ของการวิเคราะห์ผลกระทบ ใช้รายงานในหน้า “เฝ้าระวังพื้นที่ → รายงาน” ซึ่งมีหน้าละ 1 พื้นที่', 'Per-area before/after pages are in “Monitor areas → Report”.')}</Notice>
      </div>
    </div>
  );
}

function buildDisasterReport(snap: Snapshot, o: { title: string; lang: 'th' | 'en'; hazards: Set<Hazard> }, impacts: { name: string; run?: MonitorRun }[]) {
  const th = o.lang === 'th';
  const L = (a: string, b: string) => (th ? a : b);
  const now = new Date();
  const evs = snap.events.filter((e) => o.hazards.has(e.hazard) && e.province);
  const hzName = (h: Hazard) => L(hazardOf(h).th, hazardOf(h).en);
  const prov = (en?: string) => (th ? provinceLabel(en) : en ?? '—');
  const win = snap.days === 1 ? L('24 ชั่วโมงล่าสุด', 'last 24 hours') : L(`${snap.days} วันล่าสุด`, `last ${snap.days} days`);
  const foot = (n: number) => `<div class="foot"><span>${esc(o.title)}</span><span class="warn">${L('รวบรวมจากข้อมูลเปิด ไม่ใช่ประกาศทางการ · ตรวจสอบกับหน่วยงานต้นทางก่อนใช้', 'Compiled from open data, not an official declaration · verify with the issuing agency')}</span><span>${n}</span></div>`;
  const by = (h: Hazard) => evs.filter((e) => e.hazard === h);
  const top = (arr: DEvent[]) => {
    const m = new Map<string, number>();
    arr.forEach((e) => m.set(e.province ?? '', (m.get(e.province ?? '') ?? 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const hotTh = snap.hotspots.filter((h) => snap.provinces?.some((p) => h.lon >= p.bbox[0] && h.lon <= p.bbox[2] && h.lat >= p.bbox[1] && h.lat <= p.bbox[3]));
  const pages: string[] = [];

  // 1 cover
  const ov = HAZARDS.filter((h) => o.hazards.has(h.id) && h.id !== 'other').map((h) => `${hzName(h.id)} ${by(h.id).length}`).join(' · ');
  pages.push(`<section class="page cover"><h1>${esc(o.title)}</h1><div class="rule"></div>
  <h2>${L('ความต้องการข้อมูล', 'Query Requirements')}</h2><p>${L(`สถานการณ์ภัยพิบัติในประเทศไทย ${win} จากแหล่งข้อมูลเปิด`, `Disaster situation in Thailand, ${win}, from open data sources.`)}</p>
  <h2>${L('วันเวลาออกรายงาน', 'Product Release Date / Time')}</h2><p class="mono">${zulu(now)}</p>
  <h2>${L('ภาพรวม (จำนวนเหตุการณ์ตามประเภท)', 'Overview (events by hazard)')}</h2><p>– ${ov}</p>
  <div class="disc">${L('รายงานนี้รวบรวมอัตโนมัติจากข้อมูลเปิดของหน่วยงานต่าง ๆ แต่ละรายการมีแหล่งที่มาและเวลากำกับ ไม่ใช่ประกาศภัยพิบัติอย่างเป็นทางการ และไม่มีการประเมินจำนวนผู้ประสบภัยหรือมูลค่าความเสียหาย', 'This product is compiled automatically from open agency data; each item carries its source and time. It is not an official disaster declaration and does not estimate people affected or losses.')}</div>${foot(1)}</section>`);

  // 2 summary + map
  const bullets: string[] = [];
  const fl = by('flood').filter((e) => e.source === 'thaiwater_wl');
  if (o.hazards.has('flood')) bullets.push(L(`สถานีวัดระดับน้ำ “ล้นตลิ่ง” ${fl.length} สถานี ใน ${new Set(fl.map((e) => e.province)).size} จังหวัด${fl.length ? ` (มากที่สุด: ${top(fl).slice(0, 3).map(([p, n]) => `${prov(p)} ${n}`).join(', ')})` : ''} — ThaiWater`, `${fl.length} water-level stations over their banks in ${new Set(fl.map((e) => e.province)).size} provinces — ThaiWater`));
  if (o.hazards.has('storm')) bullets.push(L(`ฝนหนักมาก ≥ 90.1 มม./24 ชม. ${by('storm').filter((e) => e.source === 'thaiwater_rain').length} สถานี — ThaiWater`, `${by('storm').filter((e) => e.source === 'thaiwater_rain').length} stations with ≥ 90.1 mm / 24 h — ThaiWater`));
  if (o.hazards.has('drought')) bullets.push(L(`สถานี “น้ำน้อยวิกฤติ” ${by('drought').length} สถานี — ThaiWater`, `${by('drought').length} stations at critically low water — ThaiWater`));
  if (o.hazards.has('fire')) bullets.push(L(`จุดความร้อน VIIRS ในไทย ${hotTh.length} จุด (กลุ่ม ≥ 3 จุด: ${by('fire').length} กลุ่ม) — NASA FIRMS · จำนวนจุดไม่ใช่ขนาดพื้นที่เผาไหม้`, `${hotTh.length} VIIRS hotspots in Thailand (${by('fire').length} clusters ≥ 3) — NASA FIRMS · counts are not burned area`));
  if (o.hazards.has('quake')) {
    const q = by('quake').sort((a, b) => +(b.details.magnitude ?? 0) - +(a.details.magnitude ?? 0));
    bullets.push(L(`แผ่นดินไหวขนาด ≥ 2.5 ในไทย ${q.length} ครั้ง${q[0] ? ` ใหญ่สุด ${q[0].severityText} (${prov(q[0].province)})` : ''} — USGS`, `${q.length} earthquakes ≥ M2.5 in Thailand${q[0] ? `, largest ${q[0].severityText}` : ''} — USGS`));
  }
  if (o.hazards.has('air')) bullets.push(L(`สถานี PM2.5 เกิน 75 µg/m³ ${by('air').length} สถานี — คพ. (Air4Thai)`, `${by('air').length} PM2.5 stations above 75 µg/m³ — PCD Air4Thai`));
  const tmdB = snap.bulletins.filter((b) => b.source === 'tmd');
  if (tmdB.length) bullets.push(L(`ประกาศกรมอุตุนิยมวิทยาที่มีผล: ${tmdB.map((b) => b.text.split(' — ')[0]).join(' ; ')}`, `TMD warnings in force: ${tmdB.length}`));
  const tb: BBox = { west: 97.3, east: 105.7, south: 5.5, north: 20.6 };
  const frame = fit(tb, 120 / 128, 0.02);
  const marks = evs.slice(0, 400).map((e) => { const [x, y] = px(frame, e.lon, e.lat); return `<div class="dot" style="left:${x}%;top:${y}%;background:${hazardOf(e.hazard).color};width:${1.6 + e.severity * 0.7}mm;height:${1.6 + e.severity * 0.7}mm"></div>`; }).join('');
  const leg = HAZARDS.filter((h) => o.hazards.has(h.id) && h.id !== 'other').map((h) => `<span><i style="background:${h.color}"></i>${hzName(h.id)}</span>`).join('');
  pages.push(`<section class="page"><h1>${L('สรุปสถานการณ์', 'Executive Summary')}</h1><div class="rule"></div>
  <div class="two"><div><ul class="lim">${bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
  <p class="note">${L('ข้อมูลแต่ละชนิดแสดงแยกกัน ไม่ได้นำมารวมเป็นคะแนนเดียว · “ยืนยันจากการตรวจวัด” = ค่าจากสถานีตรวจวัด, “รายงาน/ตรวจพบ” = การตรวจจับจากดาวเทียมหรือประกาศเหตุการณ์', 'Each data type is shown separately, never merged into one score · “confirmed” = station measurement, “reported” = satellite detection or event alert')}</p></div>
  <div class="map ov"><img src="${esri(frame, 900, 960)}" alt=""/>${marks}${NORTH}${scaleBar(frame, 120)}<div class="legend small">${leg}</div></div></div>${foot(2)}</section>`);

  // 3 by province
  const provs = [...new Set(evs.map((e) => e.province!))];
  const cols: Hazard[] = (['flood', 'storm', 'drought', 'fire', 'quake', 'air'] as Hazard[]).filter((h) => o.hazards.has(h));
  const hotBy = new Map<string, number>();
  if (snap.provinces) for (const h of hotTh) { const p = snap.provinces.find((p2) => h.lon >= p2.bbox[0] && h.lon <= p2.bbox[2] && h.lat >= p2.bbox[1] && h.lat <= p2.bbox[3]); if (p) hotBy.set(p.en, (hotBy.get(p.en) ?? 0) + 1); }
  const rows = provs
    .map((p) => ({ p, c: cols.map((h) => evs.filter((e) => e.province === p && e.hazard === h).length), hot: hotBy.get(p) ?? 0 }))
    .sort((a, b) => b.c.reduce((s, x) => s + x, 0) - a.c.reduce((s, x) => s + x, 0))
    .slice(0, 22);
  pages.push(`<section class="page"><h1>${L('สรุปรายจังหวัด', 'By Province')}</h1><div class="rule"></div>
  <table class="kf small"><thead><tr><th>${L('จังหวัด', 'Province')}</th>${cols.map((h) => `<th>${hzName(h)}</th>`).join('')}${o.hazards.has('fire') ? `<th>${L('จุดความร้อน (จุด)', 'Hotspots (count)')}</th>` : ''}</tr></thead>
  <tbody>${rows.map((r) => `<tr><td>${esc(prov(r.p))}</td>${r.c.map((x) => `<td class="c">${x || ''}</td>`).join('')}${o.hazards.has('fire') ? `<td class="c">${r.hot || ''}</td>` : ''}</tr>`).join('')}</tbody></table>
  <p class="note">${L('ตัวเลขคือจำนวน “เหตุการณ์/สถานี” ตามเกณฑ์ของแต่ละแหล่ง (เช่น สถานีล้นตลิ่ง, สถานีฝน ≥ 90.1 มม., กลุ่มจุดความร้อน ≥ 3 จุด) ไม่ใช่ขนาดพื้นที่ · แสดง 22 จังหวัดแรก', 'Numbers are counts of events/stations by each source’s criterion — not areas · top 22 provinces shown')}</p>${foot(3)}</section>`);

  // 4 key events
  const keyEv = [...evs].sort((a, b) => b.severity - a.severity || b.time.localeCompare(a.time)).slice(0, 18);
  pages.push(`<section class="page"><h1>${L('เหตุการณ์สำคัญ', 'Key Events')}</h1><div class="rule"></div>
  <table class="kf small"><thead><tr><th>${L('ประเภท', 'Hazard')}</th><th>${L('เหตุการณ์', 'Event')}</th><th>${L('จังหวัด', 'Province')}</th><th>${L('เวลา (ไทย)', 'Time (TH)')}</th><th>${L('สถานะ', 'Status')}</th><th>${L('แหล่งข้อมูล', 'Source')}</th></tr></thead>
  <tbody>${keyEv.map((e) => `<tr><td>${esc(hzName(e.hazard))}</td><td>${esc(e.title)}<br><span class="muted">${esc(e.severityText)}</span></td><td>${esc(prov(e.province))}</td><td class="mono">${tTime(e.time)}</td><td>${esc(th ? STATUS_TH[e.status] : e.status)}</td><td>${esc(e.source.toUpperCase())}${e.url ? `<br><span class="muted">${esc(e.url.slice(0, 60))}</span>` : ''}</td></tr>`).join('')}</tbody></table>${foot(4)}</section>`);

  // 5 bulletins
  const bl = snap.bulletins.slice(0, 14);
  pages.push(`<section class="page"><h1>${L('ประกาศและคำเตือน', 'Warnings & Bulletins')}</h1><div class="rule"></div>
  ${bl.length ? `<table class="kf small"><thead><tr><th>${L('หน่วยงาน', 'Agency')}</th><th>${L('เวลา', 'Time')}</th><th>${L('ข้อความ', 'Text')}</th></tr></thead><tbody>${bl.map((b) => `<tr><td>${b.source === 'tmd' ? L('กรมอุตุนิยมวิทยา', 'TMD') : b.source === 'cems' ? 'Copernicus EMS' : 'ThaiWater (สสน.)'}</td><td class="mono">${tTime(b.time)}</td><td>${esc(b.text.slice(0, 380))}</td></tr>`).join('')}</tbody></table>` : `<p>${L('ไม่มีประกาศที่ดึงได้ในรอบนี้', 'No bulletins retrieved this time')}</p>`}${foot(5)}</section>`);

  // 6 imagery assessments
  pages.push(`<section class="page"><h1>${L('ผลวิเคราะห์จากภาพดาวเทียม', 'Satellite Impact Assessments')}</h1><div class="rule"></div>
  ${impacts.length ? `<table class="kf small"><thead><tr><th>${L('พื้นที่', 'Area')}</th><th>${L('ผล', 'Result')}</th><th>${L('ภาพที่ใช้', 'Images')}</th><th>${L('ความเชื่อมั่น', 'Confidence')}</th></tr></thead><tbody>${impacts.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.run ? narrative(x.run, o.lang).slice(0, 2).join(' · ') : L('ยังไม่ได้วิเคราะห์', 'not analysed'))}</td><td class="mono">${x.run?.A ? `${x.run.A.datetime.slice(0, 10)} → ${x.run.B?.datetime.slice(0, 10)}` : '—'}</td><td>${x.run?.confidence ?? '—'}</td></tr>`).join('')}</tbody></table>` : `<p>${L('ยังไม่มีการวิเคราะห์ผลกระทบจากเหตุการณ์ในรอบนี้ (กด “วิเคราะห์ผลกระทบ” ในรายละเอียดเหตุการณ์)', 'No impact assessments yet (use “Assess impact” in an event’s detail)')}</p>`}
  <p class="note">${L('วิเคราะห์ในกรอบรอบจุดเหตุการณ์ ไม่ใช่ขอบเขตผลกระทบจริง · ภาพก่อน–หลังรายพื้นที่อยู่ในรายงานของหน้าเฝ้าระวังพื้นที่', 'Analysed in a box around the event point, not the true affected extent · per-area before/after pages are in the monitoring report')}</p>${foot(6)}</section>`);

  // 7 sources
  const srows = REGISTRY.map((r) => { const s = snap.states[r.id]; return `<tr><td>${esc(r.name)}<br><span class="muted">${esc(r.org)}</span></td><td>${esc(s?.status ?? '—')}</td><td>${esc(s ? (th ? FRESH_TH[s.freshness] : s.freshness) : '—')}</td><td class="mono">${tTime(s?.upstreamTime)}</td><td class="mono">${tTime(s?.fetchedAt)}</td><td class="mono small">${esc(r.endpoint)}</td></tr>`; }).join('');
  pages.push(`<section class="page"><h1>${L('แหล่งข้อมูล เวลา และข้อจำกัด', 'Sources, Times & Limitations')}</h1><div class="rule"></div>
  <table class="kf small"><thead><tr><th>${L('แหล่งข้อมูล', 'Source')}</th><th>${L('สถานะ', 'Status')}</th><th>${L('ความสด', 'Freshness')}</th><th>${L('ข้อมูลต้นทาง', 'Upstream')}</th><th>${L('ดึงเข้าระบบ', 'Fetched')}</th><th>Endpoint</th></tr></thead><tbody>${srows}</tbody></table>
  <ul class="lim"><li>${L('จุดความร้อนคือความร้อนผิดปกติที่ดาวเทียมตรวจพบ อาจเป็นการเผาในที่โล่ง ไม่ใช่ไฟป่าทุกจุด', 'Hotspots are thermal anomalies; many are open burning, not wildfire')}</li><li>${L('สถานะระดับน้ำมาจากสถานีตรวจวัด ไม่ได้บอกขนาดพื้นที่น้ำท่วม', 'Water-level status is from stations and does not give flooded area')}</li><li>${L('ข้อมูลแผ่นดินไหวในอดีตไม่ใช้ทำนายเวลาหรือขนาดของแผ่นดินไหวในอนาคต', 'Past earthquakes are not used to predict future ones')}</li></ul>${foot(7)}</section>`);

  return reportShell(o.title, o.lang, pages).replace('</style>', '.dot{position:absolute;transform:translate(-50%,-50%);border-radius:50%;border:.3mm solid rgba(0,0,0,.6)}.note{font-size:8pt;color:#555;margin-top:2mm}.muted{color:#777;font-size:7pt}.legend.small{padding-left:3mm}td.small,.small td{font-size:7.3pt}</style>');
}
