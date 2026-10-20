import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n';
import GlobeHost from '../components/GlobeHost';
import AoiPicker from '../components/AoiPicker';
import SatPicker from '../components/SatPicker';
import PassClassNote from '../components/PassClassNote';
import { Badge, Button, Field, Input, Notice, Panel, Spinner, cx } from '../components/ui';
import { Cesium, CYAN } from '../lib/cesium';
import { setLiveClock, useSatPoints } from '../components/satLayer';
import { centroid } from '../lib/geo';
import { compass, findVisiblePassesBatched, type Observer, type VisiblePass } from '../lib/lookangles';
import { groundTrack } from '../lib/orbit';
import { SENSOR_COLOR } from '../data/providers';
import { useOrbit, useWorkspace } from '../store';
import { fmtLatLon, fmtLocal, fmtNum } from '../lib/format';
import { logAudit } from '../lib/repo';

// datetime-local inputs are in Thailand time (UTC+7)
const toInput = (d: Date) => new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 16);
const fromInput = (v: string) => new Date(`${v}:00+07:00`);
const MAX_DAYS = 14;
const startOfBkkDay = (offsetDays: number) => {
  const d = new Date(Date.now() + 7 * 3600e3);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - 7 * 3600e3 + offsetDays * 86400e3);
};
const PRESETS: { id: string; label: string; range: () => [Date, Date] }[] = [
  { id: 'now24', label: 'Next 24 h', range: () => [new Date(), new Date(Date.now() + 24 * 3600e3)] },
  { id: 'now72', label: 'Next 3 days', range: () => [new Date(), new Date(Date.now() + 72 * 3600e3)] },
  { id: 'today', label: 'Today', range: () => [startOfBkkDay(0), startOfBkkDay(1)] },
  { id: 'tomorrow', label: 'Tomorrow', range: () => [startOfBkkDay(1), startOfBkkDay(2)] },
  { id: 'week', label: 'Next 7 days', range: () => [new Date(), new Date(Date.now() + 7 * 86400e3)] },
  { id: 'yesterday', label: 'Yesterday', range: () => [startOfBkkDay(-1), startOfBkkDay(0)] },
];
const MIN_ELS = [0, 10, 20, 30];

function countdown(ms: number) {
  if (ms <= 0) return t('now');
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
const dur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Polar sky plot: centre = zenith, rim = horizon, north up. */
function SkyPlot({ pass }: { pass: VisiblePass }) {
  const R = 80;
  const pt = (az: number, el: number) => {
    const r = R * (1 - Math.max(0, el) / 90);
    return [100 + r * Math.sin((az * Math.PI) / 180), 100 - r * Math.cos((az * Math.PI) / 180)];
  };
  const path = pass.samples.map((s, i) => `${i ? 'L' : 'M'}${pt(s.az, s.el).map((v) => v.toFixed(1)).join(',')}`).join(' ');
  const [ax, ay] = pt(pass.samples[0].az, pass.samples[0].el);
  const top = pass.samples.reduce((a, b) => (b.el > a.el ? b : a));
  const [tx, ty] = pt(top.az, top.el);
  return (
    <svg viewBox="0 0 200 200" className="mx-auto w-full max-w-[220px]">
      {[0, 30, 60].map((e) => (
        <circle key={e} cx={100} cy={100} r={R * (1 - e / 90)} fill="none" stroke="rgba(148,178,214,0.18)" />
      ))}
      <line x1={20} y1={100} x2={180} y2={100} stroke="rgba(148,178,214,0.12)" />
      <line x1={100} y1={20} x2={100} y2={180} stroke="rgba(148,178,214,0.12)" />
      {[['N', 100, 12], ['E', 190, 103], ['S', 100, 196], ['W', 8, 103]].map(([l, x, y]) => (
        <text key={l as string} x={x as number} y={y as number} textAnchor="middle" fontSize="9" fill="#8b98ab" fontFamily="JetBrains Mono, monospace">{l}</text>
      ))}
      <text x={104} y={100 - R * (2 / 3) - 2} fontSize="7" fill="#5c6878">30°</text>
      <text x={104} y={100 - R * (1 / 3) - 2} fontSize="7" fill="#5c6878">60°</text>
      <path d={path} fill="none" stroke="#22d3ee" strokeWidth={2} />
      <circle cx={ax} cy={ay} r={3.5} fill="#4fd18b" />
      <circle cx={tx} cy={ty} r={3.5} fill="#fff" />
    </svg>
  );
}

export default function PassTracker() {
  const { sats, status } = useOrbit();
  const { aoi, mySats } = useWorkspace();
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const [fromV, setFromV] = useState(() => toInput(new Date()));
  const [toV, setToV] = useState(() => toInput(new Date(Date.now() + 48 * 3600e3)));
  const [preset, setPreset] = useState<string | null>(null);
  const [ran, setRan] = useState<{ from: Date; to: Date; at: number } | null>(null);
  const winFrom = fromInput(fromV);
  const winTo = fromInput(toV);
  const winHours = (winTo.getTime() - winFrom.getTime()) / 3600e3;
  const winErr = !Number.isFinite(winHours) ? t('Invalid date') : winHours <= 0 ? t('End must be after start') : winHours > MAX_DAYS * 24 ? `${t('Maximum window is')} ${MAX_DAYS} ${t('days')}` : '';
  const [minEl, setMinEl] = useState(10);
  const [geo, setGeo] = useState<Observer | null>(null);
  const [geoErr, setGeoErr] = useState('');
  const [passes, setPasses] = useState<VisiblePass[] | null>(null);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [hideDay, setHideDay] = useState(false);

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

  const observer: Observer | null = useMemo(() => {
    if (geo) return geo;
    if (!aoi) return null;
    const [lon, lat] = centroid(aoi.geometry);
    return { name: aoi.name, lat, lon, heightKm: 0 };
  }, [geo, aoi]);

  const chosen = useMemo(() => {
    const set = new Set(mySats);
    return sats.filter((s) => set.has(s.noradId));
  }, [sats, mySats]);


  useEffect(() => {
    if (viewer) setLiveClock(viewer, 1);
  }, [viewer]);

  // observer marker
  useEffect(() => {
    if (!viewer) return;
    const old = viewer.entities.getById('obs');
    if (old) viewer.entities.remove(old);
    if (!observer) return;
    viewer.entities.add({
      id: 'obs',
      position: Cesium.Cartesian3.fromDegrees(observer.lon, observer.lat),
      point: { pixelSize: 9, color: CYAN, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
      label: {
        text: observer.name,
        font: '11px "JetBrains Mono", monospace',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#0b1524').withAlpha(0.85),
        pixelOffset: new Cesium.Cartesian2(0, -16),
      },
    });
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(observer.lon, observer.lat, 9e6), duration: 1.2 });
  }, [viewer, observer?.lat, observer?.lon, observer?.name]);

  // a window that starts "now" drops passes as they finish; a chosen past/future window shows everything
  const liveWindow = !!ran && ran.from.getTime() >= ran.at - 5 * 60e3 && ran.from.getTime() <= ran.at + 5 * 60e3;
  const shown = useMemo(
    () => (passes ?? []).filter((p) => (!liveWindow || p.los.getTime() > now) && (!hideDay || p.sunAtObserver < -6)),
    [passes, now, hideDay, liveWindow],
  );
  const keyOf = (p: VisiblePass) => `${p.sat.noradId}-${p.aos.getTime()}`;
  const selPass = sel ? (passes ?? []).find((p) => keyOf(p) === sel) ?? null : null;
  useSatPoints(viewer, chosen, selPass?.sat.noradId ?? null);

  // selected pass ground track
  useEffect(() => {
    if (!viewer) return;
    const old = viewer.entities.getById('pass-track');
    if (old) viewer.entities.remove(old);
    const p = selPass;
    if (!p) return;
    const mins = Math.max(1, (p.los.getTime() - p.aos.getTime()) / 60000);
    const tr = groundTrack(p.sat, p.aos, mins, 10);
    viewer.entities.add({
      id: 'pass-track',
      polyline: {
        positions: tr.map((x) => Cesium.Cartesian3.fromDegrees(x.lon, x.lat)),
        width: 3,
        material: Cesium.Color.fromCssColorString(SENSOR_COLOR[p.sat.mission?.sensor ?? 'unknown']),
        arcType: Cesium.ArcType.GEODESIC,
      },
    });
  }, [viewer, sel]);

  const run = async () => {
    if (!observer || !chosen.length) return;
    setSel(null);
    setPasses(null);
    setBusy({ done: 0, total: chosen.length });
    if (winErr) return;
    setRan({ from: winFrom, to: winTo, at: Date.now() });
    const r = await findVisiblePassesBatched(chosen, observer, winFrom, winHours, minEl, (d, tt) => setBusy({ done: d, total: tt }));
    setPasses(r);
    setBusy(null);
    void logAudit('passes.visible', { sats: chosen.length, from: winFrom.toISOString(), to: winTo.toISOString(), minEl, passes: r.length });
  };

  const useMyLocation = () => {
    setGeoErr('');
    if (!navigator.geolocation) return setGeoErr(t('Location is not available in this browser'));
    navigator.geolocation.getCurrentPosition(
      (p) => setGeo({ name: t('My location'), lat: p.coords.latitude, lon: p.coords.longitude, heightKm: (p.coords.altitude ?? 0) / 1000 }),
      (e) => setGeoErr(e.message),
      { enableHighAccuracy: false, timeout: 10000 },
    );
  };

  const next = shown[0];
  const gp = chosen.filter((s) => s.periodMin > 300);

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-line bg-ink-900 p-3 scroll-thin lg:w-[460px] lg:border-r">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400">🛰 {t('Pass view')}</div>
          <h1 className="text-base font-semibold text-white">{t('When satellites pass over my area')}</h1>
        </div>

        <PassClassNote active="pass" />

        <Panel title={t('Observer location')}>
          <AoiPicker viewer={viewer} compact />
          <div className="mt-2 flex items-center gap-1.5">
            <Button onClick={useMyLocation}>📍 {t('Use my location')}</Button>
            {geo && <Button variant="danger" onClick={() => setGeo(null)}>{t('Use AOI instead')}</Button>}
          </div>
          {geoErr && <p className="mt-1 text-[11px] text-bad">{geoErr}</p>}
          {observer && <p className="mt-1.5 font-mono text-[10px] text-muted">{observer.name} · {fmtLatLon(observer.lat, observer.lon)}</p>}
        </Panel>

        <SatPicker title={t('Satellites to track')} />
        {gp.length > 0 && <p className="-mt-1 text-[10px] text-warn">{gp.map((s) => s.name).join(', ')}: {t('geostationary / high orbit — no discrete passes')}</p>}

        <Panel title={t('Settings')}>
          <div className="space-y-2">
            <div>
              <div className="label mb-1">{t('Time window (Thailand time)')}</div>
              <div className="flex flex-wrap gap-1">
                {PRESETS.map((p) => (
                  <Button
                    key={p.id}
                    variant={preset === p.id ? 'active' : 'ghost'}
                    onClick={() => {
                      const [a, b] = p.range();
                      setFromV(toInput(a));
                      setToV(toInput(b));
                      setPreset(p.id);
                    }}
                  >
                    {t(p.label)}
                  </Button>
                ))}
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                <Field label={t('From')}>
                  <Input type="datetime-local" value={fromV} onChange={(e) => { setFromV(e.target.value); setPreset(null); }} />
                </Field>
                <Field label={t('To')}>
                  <Input type="datetime-local" value={toV} onChange={(e) => { setToV(e.target.value); setPreset(null); }} />
                </Field>
              </div>
              {winErr ? (
                <p className="mt-1 text-[11px] text-bad">{winErr}</p>
              ) : (
                <p className="mt-1 text-[10px] text-muted">
                  {fmtNum(winHours, winHours < 48 ? 1 : 0)} {t('hours')}
                  {winFrom.getTime() < Date.now() - 3 * 86400e3 || winTo.getTime() > Date.now() + 7 * 86400e3 ? ` · ${t('Far from today: orbital elements are less accurate, times may be off by several minutes.')}` : ''}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="label w-28">{t('Min elevation')}</span>
              {MIN_ELS.map((e) => <Button key={e} variant={minEl === e ? 'active' : 'ghost'} onClick={() => setMinEl(e)}>{e}°</Button>)}
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input type="checkbox" checked={hideDay} onChange={(e) => setHideDay(e.target.checked)} /> {t('Night passes only (sun below −6° at observer)')}
            </label>
            <Button variant="primary" className="w-full" onClick={run} disabled={!observer || !chosen.length || !!busy || status !== 'ready' || !!winErr}>
              {busy ? <><Spinner /> {t('Propagating')} {busy.done}/{busy.total}</> : t('Calculate passes')}
            </Button>
            {!observer && <p className="text-[11px] text-muted">{t('Select a location first.')}</p>}
          </div>
        </Panel>

        {passes && (
          <Panel title={`${t('Passes')} (${shown.length})`} bodyClass="p-0">
            {ran && (
              <div className="border-b border-line px-3 py-1.5 font-mono text-[10px] text-muted">
                {fmtLocal(ran.from)} → {fmtLocal(ran.to)} ({t('Thailand time')})
              </div>
            )}
            {next && next.los.getTime() > now && (
              <div className="border-b border-line bg-cyan-400/5 px-3 py-2.5">
                <div className="label text-cyan-300">{t('Next pass')}</div>
                <div className="flex items-end justify-between gap-2">
                  <span className="text-sm font-semibold text-white">{next.sat.name}</span>
                  <span className="font-mono text-xl text-cyan-300">{next.aos.getTime() <= now ? t('overhead now') : countdown(next.aos.getTime() - now)}</span>
                </div>
                <div className="font-mono text-[11px] text-muted">
                  {fmtLocal(next.aos)} · {t('max')} {fmtNum(next.maxEl, 0)}° · {dur(next.durationS)}
                </div>
              </div>
            )}
            {shown.length === 0 && <p className="p-3 text-xs text-muted">{t('No passes above the minimum elevation in this window.')}</p>}
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full min-w-[420px] text-left text-xs">
                <thead className="label">
                  <tr className="border-b border-line">
                    <th className="px-3 py-1.5">{t('Satellite')}</th><th>{t('Rise (local)')}</th><th>{t('Max el.')}</th><th>{t('Duration')}</th><th>{t('Direction')}</th><th className="pr-3">{t('In')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => {
                    const live = p.aos.getTime() <= now && p.los.getTime() > now;
                    return (
                      <tr
                        key={keyOf(p)}
                        onClick={() => setSel(keyOf(p))}
                        className={cx('cursor-pointer border-b border-white/5 hover:bg-navy-800/60', sel === keyOf(p) && 'bg-cyan-400/10', live && 'text-ok')}
                      >
                        <td className="px-3 py-1.5 text-white">{p.sat.name}</td>
                        <td className="font-mono">{fmtLocal(p.aos)}</td>
                        <td className={cx('font-mono', p.maxEl >= 45 ? 'text-ok' : p.maxEl < 20 ? 'text-muted' : '')}>{fmtNum(p.maxEl, 0)}°</td>
                        <td className="font-mono">{dur(p.durationS)}</td>
                        <td className="font-mono text-muted">{compass(p.aosAz)}→{compass(p.losAz)}</td>
                        <td className={cx('pr-3 font-mono', p.los.getTime() < now ? 'text-muted' : 'text-cyan-300')}>{live ? t('now') : p.los.getTime() < now ? t('passed') : countdown(p.aos.getTime() - now)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
        <Notice>
          {t('A pass is when the satellite is above your horizon (above the minimum elevation). Times are SGP4 estimates from public elements and can drift by minutes when elements are old. Seeing a satellite with the naked eye also needs it sunlit while your sky is dark.')}
        </Notice>
      </aside>

      <div className="relative min-h-[360px] flex-1">
        <GlobeHost onReady={setViewer} />
        {selPass && (
          <div className="absolute right-3 top-3 z-10 w-[260px] rounded-md border border-line bg-navy-900/95 p-3 text-xs shadow-2xl">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-semibold text-white">{selPass.sat.name}</span>
              <button onClick={() => setSel(null)} className="text-muted hover:text-white">✕</button>
            </div>
            <SkyPlot pass={selPass} />
            <div className="mt-1 space-y-0.5 font-mono text-[11px] text-slate-300">
              <div>{t('Rise')}: {fmtLocal(selPass.aos)} · {fmtNum(selPass.aosAz, 0)}° {compass(selPass.aosAz)}</div>
              <div>{t('Highest')}: {fmtLocal(selPass.tca)} · {fmtNum(selPass.maxEl, 0)}°</div>
              <div>{t('Set')}: {fmtLocal(selPass.los)} · {fmtNum(selPass.losAz, 0)}° {compass(selPass.losAz)}</div>
              <div>{t('Sun at observer')}: {fmtNum(selPass.sunAtObserver, 0)}°</div>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              <Badge tone={selPass.confidence.tone}>{selPass.confidence.label}</Badge>
            </div>
            <p className="mt-1.5 text-[10px] text-muted">{t('Green dot = rise, white dot = highest point. Centre of the plot is straight overhead.')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
