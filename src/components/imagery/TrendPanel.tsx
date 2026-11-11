// Multi-scene trend: pick a period (1 / 3 / 6 / 12 months), the clear scenes in it are stacked,
// and the map shows WHEN each change happened (colour by date), WHICH WAY it grew (arrows) and a
// time-lapse of the change building up scene by scene.
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../../i18n';
import { Cesium } from '../../lib/cesium';
import { familyOf } from '../../lib/qc';
import { displayTemplate } from '../../lib/export';
import { dateColour } from '../../lib/timeseries';
import { runTrend, type TrendRun } from '../../lib/trend';
import type { ImageryItem } from '../../lib/stac';
import { useWorkspace } from '../../store';
import { GisCtx } from '../gis/GisContext';
import { imageProvider, pcProvider } from '../gis/sceneLayer';
import type { PickerCtx } from '../monitor/ComparePanel';
import { Button, Spinner, cx } from '../ui';
import { LabelChip, LabelEditor, useLabels, type LabelTarget } from '../monitor/Labels';

const useL = () => {
  const lang = useLang((s) => s.lang);
  return (th: string, en: string) => (lang === 'th' ? th : en);
};
const PERIODS = [
  { d: 30, th: '1 เดือน', en: '1 month' },
  { d: 90, th: '3 เดือน', en: '3 months' },
  { d: 182, th: '6 เดือน', en: '6 months' },
  { d: 365, th: '1 ปี', en: '1 year' },
];
/** scenes with more cloud + shadow than this inside the AOI add little and are skipped */
const MAX_CLOUD = 70;
const css = (k: number, S: number) => `rgb(${dateColour(k, S).join(',')})`;

/** Up to `max` items spread evenly over the list, always keeping the first and the last. */
export function spread<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(list[Math.round((i * (list.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}

export default function TrendPanel({ pick }: { pick: PickerCtx }) {
  const L = useL();
  const g = useContext(GisCtx);
  const { aoi } = useWorkspace();
  const [days, setDays] = useState(90);
  const [max, setMax] = useState(8);
  const [forest, setForest] = useState(true);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [run, setRun] = useState<TrendRun | null>(null);
  const [used, setUsed] = useState<ImageryItem[]>([]);
  const [frame, setFrame] = useState(-1);
  const [sceneOn, setSceneOn] = useState(false);
  const [playing, setPlaying] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const labels = useLabels();
  const [editing, setEditing] = useState<LabelTarget | null>(null);

  const optical: ImageryItem[] = useMemo(() => (pick.list ?? []).filter((x) => familyOf(x) === 'optical').sort((a, b) => a.datetime.localeCompare(b.datetime)), [pick.list]);
  const newest = optical[optical.length - 1];
  const inPeriod: ImageryItem[] = useMemo(() => {
    if (!newest) return [];
    const t1 = Date.parse(newest.datetime), t0 = t1 - days * 864e5;
    return optical.filter((x) => Date.parse(x.datetime) >= t0);
  }, [optical, newest, days]);
  const clearEnough = (it: ImageryItem) => {
    const c = pick.cloudOf(it);
    return !c || c.cloudPct + c.shadowPct <= MAX_CLOUD;
  };
  const measured = inPeriod.filter((x) => pick.cloudOf(x));
  const usable = inPeriod.filter((x) => pick.cloudOf(x) && clearEnough(x));

  const start = async () => {
    if (!aoi) return;
    setErr('');
    setRun(null);
    const ac = new AbortController();
    abort.current = ac;
    try {
      setBusy(L('วัดเมฆในกรอบของภาพในช่วงนี้…', 'Measuring cloud in the area for the period…'));
      const todo = inPeriod.filter((x) => !pick.cloudOf(x));
      const m = todo.length ? await pick.measure(todo, ac.signal) : {};
      const ok: ImageryItem[] = inPeriod.filter((x: ImageryItem) => {
        const mv = m[x.id];
        const c = pick.cloudOf(x) ?? (mv && mv !== 'err' ? mv : null);
        return c ? c.cloudPct + c.shadowPct <= MAX_CLOUD : false;
      });
      const chosen = spread(ok, max);
      if (chosen.length < 3) throw new Error(L(`ช่วงนี้มีภาพที่เมฆไม่เกิน ${MAX_CLOUD}% เพียง ${chosen.length} ภาพ (ต้อง ≥ 3) · เลือกช่วงที่ยาวขึ้น หรือย่อกรอบพื้นที่`, `Only ${chosen.length} scene(s) with ≤ ${MAX_CLOUD}% cloud in this period (need ≥ 3) · choose a longer period or a smaller area`));
      setUsed(chosen);
      const r = await runTrend(aoi.geometry, chosen, setBusy, ac.signal, { forestOnly: forest });
      setRun(r);
      setFrame(r.scenes.length - 1);
    } catch (e: any) {
      if (e?.name !== 'AbortError') setErr(e?.message ?? String(e));
    } finally {
      setBusy('');
      abort.current = null;
    }
  };

  // ---- map: change by date (the frame shown), growth arrows + numbers, optionally the scene itself
  useEffect(() => {
    if (!g || !run || frame < 0) return;
    let dead = false;
    const b = run.bounds;
    void imageProvider(run.frameUrls[frame] ?? run.imageUrl, b.west, b.south, b.east, b.north).then((prov) => {
      if (dead) return;
      g.putImagery('trend-result', L('การเปลี่ยนแปลงตามวันที่ (หลายภาพ)', 'Change by date (multi-scene)'), prov, {
        alpha: 0.9,
        legend: { items: run.scenes.map((s, k) => ({ color: css(k, run.scenes.length), label: s.date })) },
        meta: `${run.scenes[0].date} → ${run.scenes[run.scenes.length - 1].date} · ${run.scenes.length} ${L('ภาพ', 'scenes')}`,
      });
    });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g, run, frame]);
  useEffect(() => {
    if (!g || !run) return;
    const ds = new Cesium.CustomDataSource('trend-arrows');
    const S = run.scenes.length;
    for (const p of run.pieces.slice(0, 60)) {
      const col = Cesium.Color.fromCssColorString(css(p.last, S));
      if (p.growth && p.growth.distM >= 30) {
        ds.entities.add({
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray([...p.growth.fromLL, ...p.growth.toLL]),
            width: 14, clampToGround: false,
            material: new Cesium.PolylineArrowMaterialProperty(Cesium.Color.WHITE.withAlpha(0.95)),
          },
        });
      }
      ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
        point: { pixelSize: 6, color: col, outlineColor: Cesium.Color.WHITE, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: `${p.n}`, font: '600 12px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -13), disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
    }
    g.putDataSource('trend-arrows', L('ทิศทางการขยายตัว', 'Growth direction'), ds, { meta: L('ลูกศร = จากจุดที่เปลี่ยนก่อน ไปจุดที่เปลี่ยนล่าสุด', 'arrow = from the earliest change to the latest') });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g, run]);
  useEffect(() => {
    if (!g) return;
    const it = sceneOn && frame >= 0 ? used.find((u) => u.id === run?.scenes[frame]?.id) : null;
    if (!it) { g.removeLayer('trend-scene'); return; }
    g.putImagery('trend-scene', `${L('ภาพจริง', 'Scene')} ${it.datetime.slice(0, 10)}`, pcProvider(displayTemplate(it), it), { alpha: 1 });
    // keep the change layer above the scene
    const top = g.layers.find((l) => l.id === 'trend-result')?.layer;
    if (top && g.viewer && !g.viewer.isDestroyed() && g.viewer.imageryLayers.contains(top)) {
      g.viewer.imageryLayers.raiseToTop(top);
      g.viewer.scene.requestRender();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g, sceneOn, frame, run]);
  useEffect(() => () => { ['trend-scene'].forEach((id) => g?.removeLayer(id)); }, [g]);
  // time-lapse
  useEffect(() => {
    if (!playing || !run) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % run.scenes.length), 1200);
    return () => clearInterval(t);
  }, [playing, run]);

  const S = run?.scenes.length ?? 0;
  const maxKm2 = run ? Math.max(1e-9, ...run.perSceneKm2) : 1;
  const rai = (km2: number) => (km2 * 625).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const growing = run?.pieces.filter((p) => p.growth && p.growth.distM >= 30) ?? [];

  return (
    <div className="space-y-2 text-[11px]">
      <p className="text-[10px] text-muted">{L('ซ้อนภาพ Sentinel-2/Landsat หลายวันในช่วงที่เลือก แต่ละจุดใช้เฉพาะภาพที่โปร่งตรงนั้น นับเฉพาะพืชพรรณที่หายแล้วไม่กลับในภาพถัดไป แล้วระบายสีตามวันที่เริ่มเปลี่ยน', 'Stacks the optical scenes of the period; each pixel uses only scenes that are clear there; only vegetation lost and not back in the next scene counts, coloured by the date it started')}</p>
      <div>
        <div className="label mb-1">{L('ช่วงเวลา (ย้อนจากภาพล่าสุด)', 'Period (back from the newest scene)')}</div>
        <div className="flex flex-wrap gap-1">
          {PERIODS.map((p) => (
            <button key={p.d} onClick={() => setDays(p.d)} className={cx('rounded border px-2 py-0.5', days === p.d ? 'border-cyan-400 bg-cyan-400/15 text-white' : 'border-line hover:border-cyan-400/50')}>{L(p.th, p.en)}</button>
          ))}
        </div>
        <div className="mt-1 text-[10px] text-muted">
          {newest
            ? L(`มีภาพแสง ${inPeriod.length} ภาพในช่วงนี้ · วัดเมฆแล้ว ${measured.length} · ใช้ได้ ${usable.length}${inPeriod.length > measured.length ? ' (ที่เหลือจะวัดตอนกดวิเคราะห์)' : ''}`, `${inPeriod.length} optical scenes in the period · ${measured.length} measured · ${usable.length} usable${inPeriod.length > measured.length ? ' (the rest are measured on run)' : ''}`)
            : L('ค้นหาภาพในขั้นที่ 2 ก่อน (ตั้งช่วงค้นหาให้ยาวพอ เช่น 1 ปี)', 'Search images in step 2 first (a long enough range, e.g. 1 year)')}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1">{L('จำนวนภาพสูงสุด', 'Max scenes')}
          <input type="range" min={3} max={12} value={max} onChange={(e) => setMax(+e.target.value)} className="h-1 w-20" />
          <span className="font-mono">{max}</span>
        </label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={forest} onChange={(e) => setForest(e.target.checked)} />{L('เฉพาะพื้นที่ป่า/ไม้พุ่ม', 'Forest / shrub only')}</label>
      </div>
      {busy ? (
        <div className="flex items-center gap-2 text-cyan-300"><Spinner /><span className="flex-1">{busy}</span><button className="text-muted hover:text-white" onClick={() => abort.current?.abort()}>{L('หยุด', 'Stop')}</button></div>
      ) : (
        <Button variant="primary" className="w-full" disabled={inPeriod.length < 3} onClick={() => void start()}>
          📈 {L('วิเคราะห์แนวโน้มหลายภาพ', 'Analyse the multi-scene trend')}
        </Button>
      )}
      {err && <p className="text-bad">{err}</p>}

      {run && (
        <div className="space-y-2 rounded border border-line p-2">
          <div className={cx('text-sm font-semibold', run.pieces.length ? 'text-bad' : 'text-ok')}>
            {run.pieces.length
              ? L(`พบพื้นที่เปลี่ยนแปลง ${run.pieces.length} แห่ง · ${rai(run.totalKm2)} ไร่`, `${run.pieces.length} changed areas · ${(run.totalKm2 * 100).toFixed(1)} ha`)
              : L('ไม่พบพืชพรรณหายแบบถาวรในช่วงนี้', 'No lasting vegetation loss in this period')}
          </div>
          <div className="text-[10px] text-muted">
            {L(`${S} ภาพ ${run.scenes[0].date} → ${run.scenes[run.scenes.length - 1].date} · ตรวจได้ ${rai(run.analysedKm2)} ไร่${run.forestOnly ? ' (เฉพาะป่า)' : ''} · เกณฑ์ NDVI ลด ≥ ${run.drop.toFixed(2)} (สัญญาณรบกวน ${run.noise.toFixed(3)})`, `${S} scenes ${run.scenes[0].date} → ${run.scenes[run.scenes.length - 1].date} · analysed ${(run.analysedKm2 * 100).toFixed(0)} ha${run.forestOnly ? ' (forest only)' : ''} · NDVI drop ≥ ${run.drop.toFixed(2)} (noise ${run.noise.toFixed(3)})`)}
          </div>
          {growing.length > 0 && (
            <div className="rounded bg-white/5 px-1.5 py-1">
              {growing.slice(0, 3).map((p) => (
                <div key={p.n}>➜ {L(`แห่งที่ ${p.n} ขยายไปทาง${p.growth!.dirTh} ราว ${Math.round(p.growth!.mPerMonth)} ม./เดือน (${run.scenes[p.first].date} → ${run.scenes[p.last].date})`, `#${p.n} grows ${p.growth!.dirEn}, ≈ ${Math.round(p.growth!.mPerMonth)} m/month (${run.scenes[p.first].date} → ${run.scenes[p.last].date})`)}</div>
              ))}
            </div>
          )}

          {/* new change per scene + cumulative */}
          <svg viewBox={`0 0 300 ${92}`} className="w-full" role="img" aria-label={L('พื้นที่เปลี่ยนแปลงใหม่ต่อภาพ', 'New change per scene')}>
            {run.perSceneKm2.map((v, k) => {
              const w = 280 / S, h = (v / maxKm2) * 52;
              const cum = run.perSceneKm2.slice(0, k + 1).reduce((a, b) => a + b, 0);
              return (
                <g key={k} onClick={() => { setPlaying(false); setFrame(k); }} className="cursor-pointer">
                  <rect x={10 + k * w + 2} y={62 - h} width={w - 4} height={Math.max(h, v > 0 ? 1 : 0)} fill={css(k, S)} opacity={k <= frame ? 1 : 0.35} />
                  <text x={10 + k * w + w / 2} y={74} textAnchor="middle" fontSize="7" fill="currentColor" className="text-muted">{run.scenes[k].date.slice(5)}</text>
                  <text x={10 + k * w + w / 2} y={85} textAnchor="middle" fontSize="6.5" fill="currentColor" className="text-slate-400">{rai(cum)}</text>
                  {k === frame && <rect x={10 + k * w} y={2} width={w} height={86} fill="none" stroke="#22d3ee" strokeWidth="1" />}
                </g>
              );
            })}
            <text x="10" y="10" fontSize="7.5" fill="currentColor" className="text-muted">{L('ไร่ที่เปลี่ยนใหม่ต่อภาพ · แถวล่าง = สะสม (ไร่)', 'new change per scene · bottom row = cumulative (rai)')}</text>
          </svg>

          {/* time-lapse */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button className="rounded border border-line px-2 py-0.5 hover:border-cyan-400/60" onClick={() => setPlaying(!playing)}>{playing ? '⏸' : '▶'} {L('ไทม์แลปส์', 'Time-lapse')}</button>
            <input type="range" min={0} max={S - 1} value={frame} onChange={(e) => { setPlaying(false); setFrame(+e.target.value); }} className="h-1 flex-1" />
            <span className="font-mono text-[10px]">{run.scenes[frame]?.date}</span>
            <label className="flex w-full items-center gap-1 text-[10px]"><input type="checkbox" checked={sceneOn} onChange={(e) => setSceneOn(e.target.checked)} />{L('แสดงภาพจริงของวันนั้นใต้ผล', 'Show that day’s scene under the result')}</label>
          </div>

          {run.pieces.length > 0 && (
            <table className="w-full text-[10px]">
              <thead className="text-muted"><tr><th className="text-left">#</th><th className="text-left">lat, lon</th><th>{L('ไร่', 'rai')}</th><th>{L('เริ่ม → ล่าสุด', 'first → last')}</th><th>{L('ทิศ', 'dir')}</th><th>{L('ป้าย', 'label')}</th></tr></thead>
              <tbody>
                {run.pieces.slice(0, 15).map((p) => (
                  <tr key={p.n} className="border-t border-white/5">
                    <td>{p.n}</td>
                    <td className="font-mono">{p.lat.toFixed(5)}, {p.lon.toFixed(5)}</td>
                    <td className="text-center">{rai(p.km2)}</td>
                    <td className="text-center"><span style={{ color: css(p.first, S) }}>■</span> {run.scenes[p.first].date.slice(5)} → <span style={{ color: css(p.last, S) }}>■</span> {run.scenes[p.last].date.slice(5)}{p.unconfirmed ? '*' : ''}</td>
                    <td className="text-center">{p.growth && p.growth.distM >= 30 ? `${L(p.growth.dirTh, p.growth.dirEn)} ${Math.round(p.growth.mPerMonth)} ${L('ม./ด.', 'm/mo')}` : '—'}</td>
                    <td className="text-center">{(() => {
                      const t: LabelTarget = {
                        ref: `trend:${run.scenes[0].id}:${p.n}`, lon: p.lon, lat: p.lat, areaKm2: p.km2, lengthKm: p.lengthKm, source: 'trend', aoiName: aoi?.name,
                        aScene: run.scenes[p.first].id, bScene: run.scenes[p.last].id, aDatetime: run.scenes[p.first].date, bDatetime: run.scenes[p.last].date,
                        features: { scenes: run.scenes.length, unconfirmed: p.unconfirmed, bearingDeg: p.growth?.bearingDeg ?? null, mPerMonth: p.growth?.mPerMonth ?? null, ndviDrop: run.drop },
                      };
                      return <LabelChip t={t} labels={labels} active={editing?.ref === t.ref} onOpen={() => setEditing(editing?.ref === t.ref ? null : t)} />;
                    })()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {editing && <LabelEditor key={editing.ref} t={editing} labels={labels} onDone={() => setEditing(null)} />}
          <p className="text-[9px] text-muted">{L('สีจาง / * = เห็นเฉพาะภาพล่าสุด ยังยืนยันไม่ได้จนกว่าจะมีภาพถัดไป · ผลเป็นการชี้เป้า ควรเปิดดูภาพจริงยืนยัน', 'Light colour / * = seen on the newest scene only, unconfirmed until the next one · results point where to look; confirm on the imagery')}</p>
        </div>
      )}
    </div>
  );
}
