import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useLang } from '../i18n';
import GlobeHost from '../components/GlobeHost';
import AoiPicker from '../components/AoiPicker';
import { Badge, Button, Field, Input, Notice, Panel, Select, Spinner, cx } from '../components/ui';
import { Cesium, flyToPolygon } from '../lib/cesium';
import { useWorkspace } from '../store';
import {
  aoiFromPolygon, aoiInfo, confTh, deleteImages, getImage, isDue, lastRunOf, levelTh, loadAois, loadRuns, methodText, narrative, PURPOSES, rai, REGIONS, runMonitor, saveAois, saveRuns,
  type MonitorAoi, type MonitorRun, type Purpose, type Region, type SensorMode,
} from '../lib/monitor';
import { borderLines, lineLength, NEIGHBOURS, tilesAlong, type Neighbour, type Tile } from '../lib/border';
import { imageProvider } from '../components/gis/sceneLayer';
import { buildReportHtml, hotspotsCsv, resultsGeoJson } from '../lib/report';
import { downloadJson } from '../lib/geo';

// ---------------------------------------------------------------- shared state (persisted in this browser)

interface MonState {
  aois: MonitorAoi[];
  runs: MonitorRun[];
  setAois: (f: (a: MonitorAoi[]) => MonitorAoi[]) => void;
  addRun: (r: MonitorRun) => void;
  removeRun: (id: string) => void;
}
export const useMonitor = create<MonState>((set) => ({
  aois: loadAois(),
  runs: loadRuns(),
  setAois: (f) =>
    set((s) => {
      const aois = f(s.aois);
      saveAois(aois);
      return { aois };
    }),
  addRun: (r) =>
    set((s) => {
      const runs = [r, ...s.runs];
      saveRuns(runs);
      return { runs };
    }),
  removeRun: (id) =>
    set((s) => {
      const runs = s.runs.filter((x) => x.id !== id);
      saveRuns(runs);
      void deleteImages(id);
      return { runs };
    }),
}));

const useL = () => {
  const lang = useLang((s) => s.lang);
  return (th: string, en: string) => (lang === 'th' ? th : en);
};

const LEVEL_COLOR: Record<string, string> = { significant: '#ef4444', minor: '#f5b84b', none: '#4fd18b', insufficient: '#94a3b8', error: '#94a3b8', new: '#22d3ee' };
const statusOf = (r?: MonitorRun) => (!r ? 'new' : r.status !== 'ok' ? (r.status === 'error' ? 'error' : 'insufficient') : r.level ?? 'none');

// ---------------------------------------------------------------- page: watchlist

export function MonitorWatch() {
  const L = useL();
  const lang = useLang((s) => s.lang);
  const { aois, runs, setAois, addRun } = useMonitor();
  const { aoi: wsAoi } = useWorkspace();
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [panel, setPanel] = useState<'list' | 'add' | 'border'>('list');
  const [busy, setBusy] = useState<{ cur: string; msg: string; done: number; total: number } | null>(null);
  const [period, setPeriod] = useState(30);
  const abort = useRef<AbortController | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [borderLinesState, setBorderLines] = useState<[number, number][][]>([]);

  const sel = aois.find((a) => a.id === selId) ?? null;
  const due = aois.filter((a) => isDue(a, runs));

  // ---- map: AOIs coloured by last result, border line, candidate tiles
  useEffect(() => {
    if (!viewer) return;
    const ds = new Cesium.CustomDataSource('monitor');
    borderLinesState.forEach((l) =>
      ds.entities.add({ polyline: { positions: l.map(([x, y]) => Cesium.Cartesian3.fromDegrees(x, y)), width: 2, material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.YELLOW, dashLength: 10 }), clampToGround: false } }),
    );
    tiles.forEach((tl) => {
      const on = picked.has(tl.id);
      ds.entities.add({
        id: `tile:${tl.id}`,
        polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray(tl.geometry.coordinates[0].flat()), material: Cesium.Color.fromCssColorString(on ? '#22d3ee' : '#ffffff').withAlpha(on ? 0.35 : 0.08), outline: true, outlineColor: Cesium.Color.fromCssColorString(on ? '#22d3ee' : '#ffffff'), height: 0 },
      });
    });
    aois.forEach((a, i) => {
      const st = statusOf(lastRunOf(a.id, runs));
      const col = Cesium.Color.fromCssColorString(LEVEL_COLOR[st]);
      const ring = a.geometry.coordinates[0];
      ds.entities.add({
        id: `aoi:${a.id}`,
        polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray(ring.flat()), material: col.withAlpha(a.id === selId ? 0.35 : 0.18), height: 0 },
      });
      ds.entities.add({ polyline: { positions: ring.map(([x, y]) => Cesium.Cartesian3.fromDegrees(x, y)), width: a.id === selId ? 3 : 1.5, material: col } });
      const { lon, lat } = aoiInfo(a);
      ds.entities.add({
        id: `aoil:${a.id}`,
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        label: { text: `${i + 1}`, font: '12px Inter, sans-serif', fillColor: Cesium.Color.WHITE, showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('#0b1524').withAlpha(0.85), disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3e6) },
      });
    });
    void viewer.dataSources.add(ds);
    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, aois, runs, selId, tiles, picked, borderLinesState]);

  // click: toggle a candidate tile or select an AOI
  useEffect(() => {
    if (!viewer) return;
    const h = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    h.setInputAction((e: any) => {
      const p = viewer.scene.pick(e.position);
      const id: string | undefined = p?.id?.id;
      if (!id) return;
      if (id.startsWith('tile:')) {
        const k = id.slice(5);
        setPicked((s) => {
          const n = new Set(s);
          n.has(k) ? n.delete(k) : n.add(k);
          return n;
        });
      } else if (id.startsWith('aoi:') || id.startsWith('aoil:')) setSelId(id.split(':')[1]);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return () => h.destroy();
  }, [viewer]);

  useEffect(() => {
    if (viewer && !aois.length) viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(101, 13, 3.2e6) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer]);

  // selected run overlay on the map
  const selRun = sel ? lastRunOf(sel.id, runs) : undefined;
  useEffect(() => {
    if (!viewer || !selRun || selRun.status !== 'ok' || !selRun.overlayBounds) return;
    let layer: Cesium.ImageryLayer | null = null;
    let dead = false;
    void getImage(`${selRun.id}:change`).then(async (url) => {
      if (!url || dead || viewer.isDestroyed()) return;
      const b = selRun.overlayBounds!;
      const prov = await imageProvider(url, b.west, b.south, b.east, b.north);
      if (dead || viewer.isDestroyed()) return;
      layer = viewer.imageryLayers.addImageryProvider(prov);
    });
    return () => {
      dead = true;
      if (layer && !viewer.isDestroyed()) viewer.imageryLayers.remove(layer, true);
    };
  }, [viewer, selRun?.id]);

  const runList = async (list: MonitorAoi[]) => {
    if (!list.length) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    try {
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        setBusy({ cur: a.name, msg: '', done: i, total: list.length });
        const r = await runMonitor(a, period, (msg) => setBusy({ cur: a.name, msg, done: i, total: list.length }), ac.signal);
        addRun(r);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') console.error(e);
    } finally {
      setBusy(null);
    }
  };

  const addFromWorkspace = (region: Region, purpose: Purpose, freq: number, name: string) => {
    if (!wsAoi) return;
    const a = aoiFromPolygon(name || wsAoi.name, wsAoi.geometry, region, purpose, freq);
    setAois((l) => [...l, a]);
    setSelId(a.id);
    setPanel('list');
  };

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-line p-3 scroll-thin lg:w-[440px] lg:border-r">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400">MODE · WATCH</div>
          <h2 className="text-lg font-semibold text-white">{L('เฝ้าระวังการเปลี่ยนแปลงพื้นที่', 'Area change monitoring')}</h2>
          <p className="text-[11px] text-muted">{L('ชายแดน ป่าไม้ และสาธารณภัย · เทียบภาพดาวเทียมล่าสุดกับภาพก่อนหน้าโดยอัตโนมัติ', 'Borders, forest and disasters · compares the latest imagery with an earlier reference automatically')}</p>
        </div>

        {due.length > 0 && !busy && (
          <Notice tone="warn">
            <div className="flex items-center justify-between gap-2">
              <span>{L(`ถึงรอบตรวจ ${due.length} พื้นที่`, `${due.length} area(s) due for a check`)}</span>
              <Button variant="primary" onClick={() => runList(due)}>{L('ตรวจทั้งหมดตอนนี้', 'Run all now')}</Button>
            </div>
          </Notice>
        )}

        <div className="grid grid-cols-3 gap-1">
          <Button variant={panel === 'list' ? 'active' : 'ghost'} onClick={() => setPanel('list')}>{L(`รายการ (${aois.length})`, `Watchlist (${aois.length})`)}</Button>
          <Button variant={panel === 'border' ? 'active' : 'ghost'} onClick={() => setPanel('border')}>{L('+ ตามแนวชายแดน', '+ Along border')}</Button>
          <Button variant={panel === 'add' ? 'active' : 'ghost'} onClick={() => setPanel('add')}>{L('+ วาด / นำเข้า', '+ Draw / import')}</Button>
        </div>

        <Panel title={L('ช่วงเวลาที่ตรวจ', 'Check window')}>
          <div className="flex flex-wrap items-center gap-1">
            {[7, 14, 30, 60].map((d) => <Button key={d} variant={period === d ? 'active' : 'ghost'} onClick={() => setPeriod(d)}>{d} {L('วัน', 'days')}</Button>)}
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-muted">
            {L(
              `ภาพ “หลัง” = ภาพที่เมฆน้อยที่สุดใน ${period} วันล่าสุด · ภาพ “ก่อน” = ภาพอ้างอิงที่ดีที่สุดใน 60 วันก่อนหน้านั้น ถ้าไม่มีภาพใช้ได้ ระบบจะรายงานว่า “ข้อมูลไม่พอ” ไม่สร้างผลขึ้นเอง ช่วงฤดูฝนแนะนำ 30 วัน`,
              `“After” = clearest image in the last ${period} days · “Before” = best reference in the 60 days before that. With no usable image the result is “insufficient data”, never made up. 30 days is recommended in the rainy season.`,
            )}
          </p>
        </Panel>

        {busy && (
          <Panel>
            <div className="flex items-center gap-2 text-xs text-slate-200"><Spinner /> {busy.done + 1}/{busy.total} · {busy.cur}</div>
            <div className="mt-1 text-[11px] text-muted">{busy.msg}</div>
            <Button variant="danger" className="mt-2" onClick={() => abort.current?.abort()}>{L('หยุด', 'Stop')}</Button>
          </Panel>
        )}

        {panel === 'add' && <AddPanel viewer={viewer} onAdd={addFromWorkspace} />}
        {panel === 'border' && (
          <BorderPanel
            viewer={viewer}
            tiles={tiles}
            picked={picked}
            setPicked={setPicked}
            onTiles={(t, lines) => {
              setTiles(t);
              setBorderLines(lines);
              setPicked(new Set());
            }}
            onAdd={(list, region, purpose, freq, prefix) => {
              const now = Date.now();
              setAois((l) => [...l, ...list.map((t, i) => ({ ...aoiFromPolygon(`${prefix} ${t.id}`, t.geometry, region, purpose, freq), id: `aoi_${now.toString(36)}_${i}` }))]);
              setTiles([]);
              setPicked(new Set());
              setPanel('list');
            }}
          />
        )}

        {panel === 'list' && (
          <WatchList
            selId={selId}
            onSelect={(id) => {
              setSelId(id);
              const a = aois.find((x) => x.id === id);
              if (a && viewer) flyToPolygon(viewer, a.geometry);
            }}
            onRun={(l) => runList(l)}
            busy={!!busy}
          />
        )}

        {sel && panel === 'list' && <AoiDetail aoi={sel} onRun={() => runList([sel])} busy={!!busy} lang={lang} />}
      </aside>
      <div className="relative min-h-[360px] flex-1">
        <GlobeHost onReady={setViewer} />
        <div className="absolute bottom-8 left-3 z-10 rounded-md border border-line bg-ink-950/85 p-2 text-[11px] text-slate-200 backdrop-blur">
          {[['significant', L('เปลี่ยนแปลงมีนัยสำคัญ', 'Significant change')], ['minor', L('เล็กน้อย', 'Minor')], ['none', L('ไม่พบ', 'None')], ['insufficient', L('ข้อมูลไม่พอ', 'Insufficient data')], ['new', L('ยังไม่ตรวจ', 'Not checked')]].map(([k, l]) => (
            <div key={k} className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: LEVEL_COLOR[k] }} />{l}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- watchlist

function WatchList({ selId, onSelect, onRun, busy }: { selId: string | null; onSelect: (id: string) => void; onRun: (l: MonitorAoi[]) => void; busy: boolean }) {
  const L = useL();
  const { aois, runs, setAois } = useMonitor();
  const [filter, setFilter] = useState<Region | 'all'>('all');
  const shown = aois.filter((a) => filter === 'all' || a.region === filter);
  if (!aois.length)
    return <p className="text-xs text-muted">{L('ยังไม่มีพื้นที่ในรายการ — เพิ่มจาก “ตามแนวชายแดน” หรือ “วาด / นำเข้า”', 'No areas yet — add them “Along border” or “Draw / import”.')}</p>;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Select value={filter} onChange={(e) => setFilter(e.target.value as any)} className="!py-1 text-xs">
          <option value="all">{L('ทุกพื้นที่', 'All regions')}</option>
          {REGIONS.map((r) => <option key={r.id} value={r.id}>{L(r.labelTh, r.label)}</option>)}
        </Select>
        <Button disabled={busy || !shown.length} onClick={() => onRun(shown.filter((a) => a.active))}>{L('ตรวจทั้งหมด', 'Run all')}</Button>
      </div>
      <ul className="max-h-[36vh] space-y-1 overflow-y-auto scroll-thin">
        {shown.map((a) => {
          const r = lastRunOf(a.id, runs);
          const st = statusOf(r);
          const i = aois.indexOf(a) + 1;
          return (
            <li key={a.id}>
              <button onClick={() => onSelect(a.id)} className={cx('flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left', a.id === selId ? 'border-cyan-400/60 bg-cyan-400/10' : 'border-line hover:border-cyan-400/30')}>
                <span className="w-6 font-mono text-[11px] text-muted">{i}</span>
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: LEVEL_COLOR[st] }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-white">{a.name}</span>
                  <span className="block truncate text-[10px] text-muted">
                    {L(PURPOSES.find((p) => p.id === a.purpose)!.labelTh, PURPOSES.find((p) => p.id === a.purpose)!.label)} · {L(`ทุก ${a.freqDays} วัน`, `every ${a.freqDays} d`)}
                    {r ? ` · ${new Date(r.at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}` : ''}
                    {r?.status === 'ok' && r.stats ? ` · ${(r.stats.interestKm2 * 100).toFixed(1)} ha` : ''}
                  </span>
                </span>
                {isDue(a, runs) && <Badge tone="warn">{L('ถึงรอบ', 'due')}</Badge>}
                {!a.active && <Badge>{L('พัก', 'paused')}</Badge>}
              </button>
            </li>
          );
        })}
      </ul>
      <button className="text-[10px] text-muted hover:text-bad" onClick={() => setAois((l) => l.filter((a) => !shown.includes(a)))}>
        {L('ลบพื้นที่ที่แสดงอยู่ทั้งหมด', 'Remove all listed areas')}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- add by drawing / import

function AddPanel({ viewer, onAdd }: { viewer: Cesium.Viewer | null; onAdd: (r: Region, p: Purpose, f: number, name: string) => void }) {
  const L = useL();
  const { aoi } = useWorkspace();
  const [region, setRegion] = useState<Region>('TH-KH');
  const [purpose, setPurpose] = useState<Purpose>('clearing');
  const [freq, setFreq] = useState(7);
  const [name, setName] = useState('');
  return (
    <Panel title={L('เพิ่มพื้นที่จากการวาด / ค้นหา / นำเข้าไฟล์', 'Add an area: draw / search / import')}>
      <AoiPicker viewer={viewer} compact />
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <Field label={L('ชื่อ', 'Name')}><Input value={name} placeholder={aoi?.name ?? ''} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={L('รอบตรวจ', 'Cycle')}>
          <Select value={freq} onChange={(e) => setFreq(+e.target.value)}>{[7, 14, 30].map((d) => <option key={d} value={d}>{L(`ทุก ${d} วัน`, `every ${d} days`)}</option>)}</Select>
        </Field>
        <Field label={L('พื้นที่', 'Region')}>
          <Select value={region} onChange={(e) => setRegion(e.target.value as Region)}>{REGIONS.map((r) => <option key={r.id} value={r.id}>{L(r.labelTh, r.label)}</option>)}</Select>
        </Field>
        <Field label={L('สิ่งที่เฝ้าดู', 'Watch for')}>
          <Select value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>{PURPOSES.map((p) => <option key={p.id} value={p.id}>{L(p.labelTh, p.label)}</option>)}</Select>
        </Field>
      </div>
      <p className="mt-1 text-[10px] text-muted">{PURPOSES.find((p) => p.id === purpose)?.hint}</p>
      <Button variant="primary" className="mt-2 w-full" disabled={!aoi} onClick={() => onAdd(region, purpose, freq, name)}>{L('เพิ่มเข้ารายการเฝ้าระวัง', 'Add to watchlist')}</Button>
    </Panel>
  );
}

// ---------------------------------------------------------------- border tiles

function BorderPanel({
  viewer, tiles, picked, setPicked, onTiles, onAdd,
}: {
  viewer: Cesium.Viewer | null;
  tiles: Tile[];
  picked: Set<string>;
  setPicked: (s: Set<string>) => void;
  onTiles: (t: Tile[], lines: [number, number][][]) => void;
  onAdd: (t: Tile[], region: Region, purpose: Purpose, freq: number, prefix: string) => void;
}) {
  const L = useL();
  const [nb, setNb] = useState<Neighbour>('KHM');
  const [size, setSize] = useState(10);
  const [purpose, setPurpose] = useState<Purpose>('clearing');
  const [freq, setFreq] = useState(7);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [len, setLen] = useState(0);
  const meta = NEIGHBOURS.find((n) => n.id === nb)!;

  const gen = async () => {
    setBusy(true);
    setErr('');
    try {
      const lines = await borderLines(nb);
      if (!lines.length) throw new Error(L('ไม่พบแนวชายแดนร่วมในข้อมูล Natural Earth', 'No shared border found in Natural Earth data'));
      setLen(lineLength(lines));
      const t = tilesAlong(lines, size, nb);
      onTiles(t, lines);
      if (viewer) {
        const xs = lines.flat().map((p) => p[0]), ys = lines.flat().map((p) => p[1]);
        viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(Math.min(...xs) - 0.3, Math.min(...ys) - 0.3, Math.max(...xs) + 0.3, Math.max(...ys) + 0.3), duration: 1.2 });
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={L('สร้างพื้นที่ตามแนวชายแดน', 'Areas along a border')}>
      <div className="grid grid-cols-2 gap-1.5">
        <Field label={L('ชายแดนไทยกับ', 'Thailand with')}>
          <Select value={nb} onChange={(e) => setNb(e.target.value as Neighbour)}>{NEIGHBOURS.map((n) => <option key={n.id} value={n.id}>{L(n.th, n.en)}</option>)}</Select>
        </Field>
        <Field label={L('ขนาดช่อง', 'Tile size')}>
          <Select value={size} onChange={(e) => setSize(+e.target.value)}>{[5, 10, 20].map((s) => <option key={s} value={s}>{s} × {s} km</option>)}</Select>
        </Field>
        <Field label={L('สิ่งที่เฝ้าดู', 'Watch for')}>
          <Select value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>{PURPOSES.map((p) => <option key={p.id} value={p.id}>{L(p.labelTh, p.label)}</option>)}</Select>
        </Field>
        <Field label={L('รอบตรวจ', 'Cycle')}>
          <Select value={freq} onChange={(e) => setFreq(+e.target.value)}>{[7, 14, 30].map((d) => <option key={d} value={d}>{L(`ทุก ${d} วัน`, `every ${d} days`)}</option>)}</Select>
        </Field>
      </div>
      <Button className="mt-2 w-full" onClick={gen} disabled={busy}>{busy ? <Spinner /> : L('แสดงช่องตามแนวชายแดน', 'Show tiles along the border')}</Button>
      {err && <p className="mt-1 text-[11px] text-bad">{err}</p>}
      {tiles.length > 0 && (
        <>
          <p className="mt-2 text-[11px] text-slate-200">
            {L(`แนวชายแดนยาวราว ${Math.round(len)} กม. · ${tiles.length} ช่อง · คลิกช่องบนแผนที่เพื่อเลือก`, `Border ≈ ${Math.round(len)} km · ${tiles.length} tiles · click tiles on the map to select`)}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            <Button onClick={() => setPicked(new Set(tiles.map((t) => t.id)))}>{L('เลือกทั้งหมด', 'Select all')}</Button>
            <Button onClick={() => setPicked(new Set())}>{L('ล้าง', 'Clear')}</Button>
            <Button variant="primary" disabled={!picked.size} onClick={() => onAdd(tiles.filter((t) => picked.has(t.id)), meta.region, purpose, freq, L(`ชายแดน${meta.th}`, `${meta.en} border`))}>
              {L(`เพิ่ม ${picked.size} ช่อง`, `Add ${picked.size} tile(s)`)}
            </Button>
          </div>
          {picked.size > 12 && <p className="mt-1 text-[10px] text-warn">{L('ตรวจทีละหลายช่องใช้เวลานาน (ราว 20–60 วินาทีต่อช่อง) แนะนำเริ่มจากจุดที่สนใจก่อน', 'Many tiles take a while (≈20–60 s each); start with the stretches that matter most.')}</p>}
        </>
      )}
      <p className="mt-2 text-[10px] leading-relaxed text-muted">{L('แนวชายแดนจาก Natural Earth 1:50m เป็นเส้นโดยประมาณ (คลาดได้ระดับร้อยเมตรถึงกิโลเมตร) ไม่ใช่เส้นเขตแดนตามกฎหมายหรือ MOU ใช้เพื่อวางช่องเฝ้าระวังเท่านั้น ช่องครอบคลุมทั้งสองฝั่งแนว', 'Border from Natural Earth 1:50m is approximate (hundreds of metres to km off) — not the legal or MOU boundary. Used only to lay out watch tiles; tiles cover both sides of the line.')}</p>
    </Panel>
  );
}

// ---------------------------------------------------------------- AOI detail

function AoiDetail({ aoi, onRun, busy, lang }: { aoi: MonitorAoi; onRun: () => void; busy: boolean; lang: 'th' | 'en' }) {
  const L = useL();
  const { runs, setAois, removeRun } = useMonitor();
  const mine = runs.filter((r) => r.aoiId === aoi.id);
  const [runId, setRunId] = useState<string | null>(null);
  const run = mine.find((r) => r.id === runId) ?? mine[0];
  const [img, setImg] = useState<{ before: string | null; after: string | null; change: string | null }>({ before: null, after: null, change: null });
  const [showChange, setShowChange] = useState(true);
  useEffect(() => {
    if (!run || run.status !== 'ok') return setImg({ before: null, after: null, change: null });
    let dead = false;
    void Promise.all([getImage(`${run.id}:before`), getImage(`${run.id}:after`), getImage(`${run.id}:change`)]).then(([before, after, change]) => !dead && setImg({ before, after, change }));
    return () => {
      dead = true;
    };
  }, [run?.id]);
  const upd = (p: Partial<MonitorAoi>) => setAois((l) => l.map((a) => (a.id === aoi.id ? { ...a, ...p } : a)));
  const info = aoiInfo(aoi);
  const series = useMemo(() => [...mine].filter((r) => r.status === 'ok').reverse(), [mine]);

  return (
    <Panel title={L('รายละเอียดพื้นที่', 'Area detail')}>
      <div className="space-y-1.5">
        <Input value={aoi.name} onChange={(e) => upd({ name: e.target.value })} className="!py-1 text-sm" />
        <div className="font-mono text-[10px] text-muted">{info.lat.toFixed(4)}, {info.lon.toFixed(4)} · {info.km2.toFixed(1)} km²</div>
        <div className="grid grid-cols-3 gap-1">
          <Select value={aoi.purpose} onChange={(e) => upd({ purpose: e.target.value as Purpose })} className="!py-1 text-xs">{PURPOSES.map((p) => <option key={p.id} value={p.id}>{L(p.labelTh, p.label)}</option>)}</Select>
          <Select value={aoi.sensor} onChange={(e) => upd({ sensor: e.target.value as SensorMode })} className="!py-1 text-xs">
            <option value="auto">{L('อัตโนมัติ', 'Auto')}</option>
            <option value="optical">{L('ภาพปกติ', 'Optical')}</option>
            <option value="sar">{L('เรดาร์', 'Radar')}</option>
          </Select>
          <Select value={aoi.freqDays} onChange={(e) => upd({ freqDays: +e.target.value })} className="!py-1 text-xs">{[7, 14, 30].map((d) => <option key={d} value={d}>{L(`ทุก ${d} วัน`, `every ${d} d`)}</option>)}</Select>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button variant="primary" disabled={busy} onClick={onRun}>{L('ตรวจตอนนี้', 'Check now')}</Button>
          <Button onClick={() => upd({ active: !aoi.active })}>{aoi.active ? L('พักการตรวจ', 'Pause') : L('เปิดการตรวจ', 'Resume')}</Button>
          <Button variant="danger" onClick={() => setAois((l) => l.filter((a) => a.id !== aoi.id))}>{L('ลบพื้นที่', 'Remove')}</Button>
        </div>
        <p className="text-[10px] text-muted">{methodText(aoi.purpose, aoi.sensor === 'sar' ? 'sar' : 'optical') || L('เรดาร์ใช้กับหัวข้อนี้ไม่ได้ จะใช้ภาพปกติแทน', 'Radar is not available for this purpose; optical is used.')}</p>

        {mine.length > 1 && (
          <Select value={run?.id} onChange={(e) => setRunId(e.target.value)} className="!py-1 text-xs">
            {mine.map((r) => <option key={r.id} value={r.id}>{new Date(r.at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })} · {r.status === 'ok' ? `${(r.stats!.interestKm2 * 100).toFixed(1)} ha` : L('ข้อมูลไม่พอ', 'insufficient')}</option>)}
          </Select>
        )}

        {!run && <p className="text-[11px] text-muted">{L('ยังไม่เคยตรวจพื้นที่นี้', 'Not checked yet.')}</p>}
        {run && run.status !== 'ok' && (
          <Notice tone="warn">
            <b>{run.status === 'error' ? L('เกิดข้อผิดพลาด', 'Error') : L('ข้อมูลไม่เพียงพอ', 'Insufficient data')}</b> — {run.reason}
            <div className="mt-1 text-[10px]">{L('ลองเพิ่มช่วงเวลาที่ตรวจเป็น 30–60 วัน หรือเปลี่ยนเป็นเรดาร์', 'Try a 30–60 day window or switch to radar.')}</div>
          </Notice>
        )}
        {run && run.status === 'ok' && run.stats && (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-1">
              <Badge tone={run.level === 'significant' ? 'bad' : run.level === 'minor' ? 'warn' : 'ok'}>{lang === 'th' ? levelTh(run.level) : run.level}</Badge>
              <Badge tone="cyan">{L('ความเชื่อมั่น', 'confidence')} {lang === 'th' ? confTh(run.confidence) : run.confidence}</Badge>
              <Badge>{run.sensor === 'sar' ? 'Sentinel-1' : 'Sentinel-2'}</Badge>
            </div>
            <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-slate-200">{narrative(run, lang).map((x) => <li key={x}>{x}</li>)}</ul>
            {run.note && <p className="text-[10px] text-warn">{run.note}</p>}
            <p className="text-[10px] text-muted">{run.method}</p>
            {!!run.confidenceNotes?.length && <ul className="pl-4 text-[10px] text-muted">{run.confidenceNotes.map((x) => <li key={x}>• {x}</li>)}</ul>}
            <div className="grid grid-cols-2 gap-1.5">
              <figure>
                <div className="relative aspect-square overflow-hidden rounded border border-line bg-black">{img.before && <img src={img.before} className="h-full w-full object-contain" alt="" />}</div>
                <figcaption className="mt-0.5 text-[10px] text-muted">{L('ก่อน', 'Before')} · {run.A?.datetime.slice(0, 10)}{run.A?.aoiCloudPct != null ? ` · ☁ ${run.A.aoiCloudPct.toFixed(0)}%` : ''}</figcaption>
              </figure>
              <figure>
                <div className="relative aspect-square overflow-hidden rounded border border-line bg-black">
                  {img.after && <img src={img.after} className="absolute inset-0 h-full w-full object-contain" alt="" />}
                  {showChange && img.change && run.bounds && run.overlayBounds && <OverlayOnImage src={img.change} img={run.bounds} ov={run.overlayBounds} />}
                </div>
                <figcaption className="mt-0.5 flex items-center justify-between text-[10px] text-muted">
                  <span>{L('หลัง', 'After')} · {run.B?.datetime.slice(0, 10)}{run.B?.aoiCloudPct != null ? ` · ☁ ${run.B.aoiCloudPct.toFixed(0)}%` : ''}</span>
                  <label className="flex items-center gap-1"><input type="checkbox" checked={showChange} onChange={(e) => setShowChange(e.target.checked)} />{L('ผล', 'result')}</label>
                </figcaption>
              </figure>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-300">
              {run.legend?.map((l) => <span key={l.id} className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: l.color }} />{L(l.labelTh, l.label)} {((run.stats!.classKm2[l.id] ?? 0) * 100).toFixed(1)} ha</span>)}
            </div>
            {!!run.hotspots?.length && (
              <div className="max-h-40 overflow-y-auto rounded border border-line scroll-thin">
                <table className="w-full text-[10px]">
                  <thead className="text-muted"><tr><th className="px-1 text-left">#</th><th className="text-left">lat, lon</th><th className="pr-1 text-right">ha</th><th className="pr-1 text-right">{L('ไร่', 'rai')}</th></tr></thead>
                  <tbody className="font-mono text-slate-200">
                    {run.hotspots.slice(0, 20).map((h) => (
                      <tr key={h.n} className="border-t border-white/5"><td className="px-1">{h.n}</td><td>{h.lat.toFixed(5)}, {h.lon.toFixed(5)}</td><td className="pr-1 text-right">{h.areaHa.toFixed(2)}</td><td className="pr-1 text-right">{(h.areaHa * 6.25).toFixed(1)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="text-[10px] text-muted">{run.A?.id}<br />{run.B?.id}</div>
            <button className="text-[10px] text-muted hover:text-bad" onClick={() => removeRun(run.id)}>{L('ลบผลการตรวจครั้งนี้', 'Delete this result')}</button>
          </div>
        )}
        {series.length > 1 && <Trend series={series} />}
      </div>
    </Panel>
  );
}

function OverlayOnImage({ src, img, ov }: { src: string; img: { west: number; south: number; east: number; north: number }; ov: { west: number; south: number; east: number; north: number } }) {
  // both images are lat/lon-linear; the after image fills its box with object-contain, so
  // reproduce the same letterboxing for the overlay by drawing into an SVG with the image's aspect
  const w = img.east - img.west, h = img.north - img.south;
  return (
    <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
      <image href={src} x={ov.west - img.west} y={img.north - ov.north} width={ov.east - ov.west} height={ov.north - ov.south} preserveAspectRatio="none" />
    </svg>
  );
}

function Trend({ series }: { series: MonitorRun[] }) {
  const L = useL();
  const W = 380, H = 90, P = 28;
  const vs = series.map((r) => (r.stats?.interestKm2 ?? 0) * 100);
  const hi = Math.max(...vs, 1);
  const x = (i: number) => P + (i / Math.max(series.length - 1, 1)) * (W - P - 8);
  const y = (v: number) => H - 16 - (v / hi) * (H - 26);
  return (
    <div>
      <div className="label mb-1">{L('แนวโน้มพื้นที่ที่ตรวจพบ (เฮกตาร์)', 'Detected area trend (ha)')}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <line x1={P} x2={W - 8} y1={H - 16} y2={H - 16} stroke="rgba(148,178,214,0.25)" />
        <text x={2} y={y(hi) + 3} fontSize="9" fill="#8b98ab">{hi.toFixed(1)}</text>
        <path d={series.map((_, i) => `${i ? 'L' : 'M'}${x(i)},${y(vs[i])}`).join(' ')} fill="none" stroke="#22d3ee" strokeWidth={1.8} />
        {series.map((r, i) => (
          <g key={r.id}>
            <circle cx={x(i)} cy={y(vs[i])} r={3} fill={LEVEL_COLOR[r.level ?? 'none']}><title>{`${r.B?.datetime.slice(0, 10)}: ${vs[i].toFixed(2)} ha`}</title></circle>
            <text x={x(i)} y={H - 3} fontSize="8" fill="#8b98ab" textAnchor="middle">{r.B?.datetime.slice(5, 10)}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- page: report

export function MonitorReport() {
  const L = useL();
  const lang0 = useLang((s) => s.lang);
  const { aois, runs } = useMonitor();
  const [lang, setLang] = useState<'th' | 'en'>(lang0);
  const [title, setTitle] = useState(lang0 === 'th' ? 'รายงานการเปลี่ยนแปลงพื้นที่จากภาพดาวเทียม' : 'Satellite Area Change Assessment');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [sel, setSel] = useState<Set<string>>(() => new Set(aois.filter((a) => lastRunOf(a.id, runs)).map((a) => a.id)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const items = aois
    .filter((a) => sel.has(a.id))
    .map((aoi) => ({ aoi, run: lastRunOf(aoi.id, runs) }))
    .filter((x) => !onlyChanged || (x.run?.status === 'ok' && x.run.level !== 'none'));
  const dates = items.map((x) => x.run?.B?.datetime).filter(Boolean).sort() as string[];
  const requirement =
    lang === 'th'
      ? `ติดตามการเปลี่ยนแปลงเชิงพื้นที่ใน ${items.length} พื้นที่ (${[...new Set(items.map((x) => REGIONS.find((r) => r.id === x.aoi.region)?.labelTh))].join(', ')}) จากภาพดาวเทียมล่าสุด${dates.length ? ` ถึงวันที่ ${dates[dates.length - 1].slice(0, 10)}` : ''}`
      : `Monitor spatial change in ${items.length} areas (${[...new Set(items.map((x) => REGIONS.find((r) => r.id === x.aoi.region)?.label))].join(', ')}) from the latest satellite imagery${dates.length ? ` up to ${dates[dates.length - 1].slice(0, 10)}` : ''}.`;

  const open = async () => {
    setBusy(true);
    setErr('');
    try {
      const html = await buildReportHtml({ title, lang, requirement, items });
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const w = window.open(url, '_blank');
      if (!w) setErr(L('เบราว์เซอร์บล็อกหน้าต่างใหม่ — อนุญาตป๊อปอัปให้เว็บนี้แล้วลองอีกครั้ง', 'The browser blocked the new window — allow pop-ups for this site and try again.'));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveText = (name: string, text: string, type: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
  };

  return (
    <div className="h-full overflow-y-auto scroll-thin">
      <div className="mx-auto max-w-4xl space-y-3 p-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400">REPORT · OPP</div>
          <h2 className="text-lg font-semibold text-white">{L('สร้างรายงานจากผลการเฝ้าระวัง', 'Build a report from monitoring results')}</h2>
          <p className="text-[11px] text-muted">{L('หน้าแนวนอน 16:9 · ปก → ข้อค้นพบและแผนที่ภาพรวม → หน้าละ 1 พื้นที่ → วิธีการและแหล่งข้อมูล · ทุกตัวเลขมาจากผลการตรวจจริง', '16:9 landscape · cover → key findings & overview map → one page per area → method & sources · every number comes from actual runs')}</p>
        </div>
        <Panel>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <Field label={L('ชื่อรายงาน', 'Report title')}><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
            <Field label={L('ภาษา', 'Language')}>
              <div className="flex gap-1"><Button variant={lang === 'th' ? 'active' : 'ghost'} onClick={() => setLang('th')}>ไทย</Button><Button variant={lang === 'en' ? 'active' : 'ghost'} onClick={() => setLang('en')}>English</Button></div>
            </Field>
          </div>
          <p className="mt-2 rounded border border-line p-2 text-[11px] text-slate-300"><span className="text-muted">{L('ความต้องการข้อมูล', 'Query requirement')}:</span> {requirement}</p>
          <label className="mt-2 flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />{L('ใส่เฉพาะพื้นที่ที่พบการเปลี่ยนแปลง', 'Only areas with detected change')}</label>
        </Panel>
        <Panel title={L(`พื้นที่ในรายงาน (${items.length})`, `Areas in the report (${items.length})`)} right={<button className="text-[11px] text-cyan-300" onClick={() => setSel(new Set(aois.map((a) => a.id)))}>{L('เลือกทั้งหมด', 'Select all')}</button>}>
          {!aois.length && <p className="text-xs text-muted">{L('ยังไม่มีพื้นที่ — เพิ่มที่แท็บ “เฝ้าระวัง” ก่อน', 'No areas yet — add them in the “Watch” tab first.')}</p>}
          <ul className="max-h-[40vh] space-y-1 overflow-y-auto scroll-thin">
            {aois.map((a) => {
              const r = lastRunOf(a.id, runs);
              return (
                <li key={a.id}>
                  <label className="flex items-center gap-2 rounded border border-line px-2 py-1 text-xs text-slate-200">
                    <input type="checkbox" checked={sel.has(a.id)} onChange={() => setSel((s) => { const n = new Set(s); n.has(a.id) ? n.delete(a.id) : n.add(a.id); return n; })} />
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: LEVEL_COLOR[statusOf(r)] }} />
                    <span className="flex-1 truncate">{a.name}</span>
                    <span className="font-mono text-[10px] text-muted">{r ? `${r.at.slice(0, 10)}${r.status === 'ok' ? ` · ${(r.stats!.interestKm2 * 100).toFixed(1)} ha · ${(rai(r.stats!.interestKm2)).toFixed(0)} ${L('ไร่', 'rai')}` : ` · ${L('ข้อมูลไม่พอ', 'insufficient')}`}` : L('ยังไม่ตรวจ', 'not checked')}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </Panel>
        <div className="flex flex-wrap gap-1.5">
          <Button variant="primary" disabled={!items.length || busy} onClick={open}>{busy ? <Spinner /> : `📄 ${L('เปิดรายงาน (บันทึกเป็น PDF ได้)', 'Open report (save as PDF)')}`}</Button>
          <Button disabled={!items.length} onClick={() => saveText('monitoring-hotspots.csv', hotspotsCsv(items), 'text/csv;charset=utf-8')}>{L('ตาราง CSV', 'CSV table')}</Button>
          <Button disabled={!items.length} onClick={() => downloadJson('monitoring-results.geojson', resultsGeoJson(items))}>GeoJSON</Button>
        </div>
        {err && <Notice tone="bad">{err}</Notice>}
        <Notice>
          {L(
            'รายงานเปิดในแท็บใหม่ กด “บันทึกเป็น PDF / พิมพ์” แล้วเลือกปลายทาง “บันทึกเป็น PDF” และเปิด “กราฟิกพื้นหลัง” · แผนที่ฐานโหลดจาก Esri ต้องต่ออินเทอร์เน็ต · ผลการตรวจเก็บในเบราว์เซอร์นี้เท่านั้น',
            'The report opens in a new tab: press “Save as PDF / Print”, choose “Save as PDF” and enable “Background graphics”. The basemap loads from Esri (online). Results are stored in this browser only.',
          )}
        </Notice>
      </div>
    </div>
  );
}
