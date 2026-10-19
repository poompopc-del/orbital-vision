import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n';
import GlobeHost from '../components/GlobeHost';
import AoiPicker from '../components/AoiPicker';
import SatPicker from '../components/SatPicker';
import PassClassNote from '../components/PassClassNote';
import { Badge, Button, Notice, Panel, Spinner } from '../components/ui';
import { Cesium, showAoi } from '../lib/cesium';
import { useSatPoints, setLiveClock } from '../components/satLayer';
import { groundTrack, haversineKm, propagateSubPoint } from '../lib/orbit';
import { aoiRadiusKm, centroid } from '../lib/geo';
import { findPassesBatched, type PassEstimate } from '../lib/passes';
import { SENSOR_COLOR, SENSOR_LABEL, type SensorCategory } from '../data/providers';
import { useOrbit, useWorkspace } from '../store';
import { fmtLocal, fmtNum, fmtUtc } from '../lib/format';

const IMAGING: SensorCategory[] = ['optical', 'multispectral', 'sar', 'hyperspectral', 'thermal'];
const SPEEDS = [1, 10, 60];
const TRAIL_MIN = 10;
const AHEAD_MIN = 10;

export default function ImagingView() {
  const { sats } = useOrbit();
  const { aoi, mySats } = useWorkspace();
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const [speed, setSpeed] = useState(1);
  const [simTime, setSimTime] = useState(new Date());
  const [sel, setSel] = useState<string | null>(null);
  const [upcoming, setUpcoming] = useState<PassEstimate[] | null>(null);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);

  const imaging = useMemo(
    () => {
      const set = new Set(mySats);
      return sats.filter((s) => set.has(s.noradId) && s.mission && IMAGING.includes(s.mission.sensor));
    },
    [sats, mySats],
  );
  const withSwath = useMemo(() => imaging.filter((s) => s.mission?.swathKm && s.periodMin < 300), [imaging]);

  useSatPoints(viewer, imaging, sel, { onPick: setSel, onTick: setSimTime });

  useEffect(() => {
    if (viewer) setLiveClock(viewer, speed);
  }, [viewer]);
  useEffect(() => {
    if (viewer) viewer.clock.multiplier = speed;
  }, [viewer, speed]);
  useEffect(() => {
    if (viewer) showAoi(viewer, aoi?.geometry ?? null);
  }, [viewer, aoi]);

  // swath corridors: past TRAIL_MIN (faint) + next AHEAD_MIN (brighter), refreshed every minute of sim time
  const swathKey = `${withSwath.length}-${sel}-${Math.floor(simTime.getTime() / 60000)}`;
  useEffect(() => {
    if (!viewer) return;
    viewer.entities.values.filter((e) => String(e.id).startsWith('sw-')).forEach((e) => viewer.entities.remove(e));
    const t0 = Cesium.JulianDate.toDate(viewer.clock.currentTime);
    withSwath.slice(0, 120).forEach((s) => {
      const color = Cesium.Color.fromCssColorString(SENSOR_COLOR[s.mission!.sensor]);
      const w = s.mission!.swathKm! * 1000;
      const isSel = s.noradId === sel;
      const past = groundTrack(s, new Date(t0.getTime() - TRAIL_MIN * 60000), TRAIL_MIN, 30);
      const next = groundTrack(s, t0, AHEAD_MIN, 30);
      const add = (id: string, pts: typeof past, alpha: number) => {
        if (pts.length < 2) return;
        viewer.entities.add({
          id,
          corridor: { positions: pts.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat)), width: w, material: color.withAlpha(alpha), height: 0 },
        });
      };
      add(`sw-p-${s.noradId}`, past, isSel ? 0.25 : 0.08);
      add(`sw-n-${s.noradId}`, next, isSel ? 0.45 : 0.2);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, swathKey]);

  // satellites whose nominal swath covers the AOI centre right now
  const overNow = useMemo(() => {
    if (!aoi) return [];
    const [lon, lat] = centroid(aoi.geometry);
    const r = aoiRadiusKm(aoi.geometry);
    return withSwath
      .map((s) => {
        const p = propagateSubPoint(s, simTime);
        return p ? { s, d: haversineKm(p.lat, p.lon, lat, lon) } : null;
      })
      .filter((x): x is { s: (typeof withSwath)[number]; d: number } => !!x && x.d <= x.s.mission!.swathKm! / 2 + r);
  }, [aoi, withSwath, simTime]);

  const runUpcoming = async () => {
    if (!aoi) return;
    setUpcoming(null);
    setBusy({ done: 0, total: withSwath.length });
    const r = await findPassesBatched(withSwath, aoi.geometry, new Date(), 24, (d, tt) => setBusy({ done: d, total: tt }));
    setUpcoming(r.filter((p) => p.sat.mission?.sensor === 'sar' || p.sunElevationDeg > 0));
    setBusy(null);
  };

  const selected = imaging.find((s) => s.noradId === sel);

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-line bg-ink-900 p-3 scroll-thin lg:w-[340px] lg:border-r">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400">📷 {t('Imaging view')}</div>
          <h1 className="text-base font-semibold text-white">{t('Where imaging satellites can see')}</h1>
        </div>
        <Notice>
          {t('Strips show the nominal documented swath under each satellite (last 10 min faint, next 10 min bright). They show where a sensor could image, not where it actually is imaging.')}
        </Notice>

        <PassClassNote active="opportunity" />

        <SatPicker sensors={IMAGING} title={t('Imaging satellites')} />

        <Panel title={t('Speed')}>
          <div className="flex items-center gap-1.5">
            {SPEEDS.map((x) => (
              <Button key={x} variant={speed === x ? 'active' : 'ghost'} onClick={() => setSpeed(x)}>{x}×</Button>
            ))}
          </div>
          <p className="mt-2 font-mono text-[10px] text-muted">
            {imaging.length} {t('satellites')} · {withSwath.length} {t('with documented swath')}
          </p>
        </Panel>

        <Panel title={t('Area of interest')}>
          <AoiPicker viewer={viewer} compact />
        </Panel>

        {aoi && (
          <Panel title={t('Swath over AOI now')} right={<span className="font-mono text-[10px] text-muted">{fmtUtc(simTime)}</span>}>
            {overNow.length === 0 ? (
              <p className="text-xs text-muted">{t('No imaging satellite swath covers the AOI at this moment.')}</p>
            ) : (
              <ul className="space-y-1">
                {overNow.map(({ s, d }) => (
                  <li key={s.noradId}>
                    <button onClick={() => setSel(s.noradId)} className="flex w-full items-center gap-2 text-left text-xs">
                      <span className="h-2 w-2 rounded-full" style={{ background: SENSOR_COLOR[s.mission!.sensor] }} />
                      <span className="flex-1 truncate text-white">{s.name}</span>
                      <span className="font-mono text-[10px] text-muted">{fmtNum(d, 0)} km</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {aoi && (
          <Panel title={t('Next swath coverage of AOI (24 h)')}>
            <Button variant="primary" className="w-full" onClick={runUpcoming} disabled={!!busy || !withSwath.length}>
              {busy ? <><Spinner /> {t('Propagating')} {busy.done}/{busy.total}</> : t('Estimate passes')}
            </Button>
            {upcoming && upcoming.length === 0 && <p className="mt-2 text-xs text-muted">{t('No estimates yet.')}</p>}
            {upcoming && upcoming.length > 0 && (
              <ul className="mt-2 max-h-72 overflow-y-auto scroll-thin">
                {upcoming.map((p) => (
                  <li key={`${p.sat.noradId}-${p.tca.getTime()}`} className="border-b border-white/5 py-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 truncate text-white">
                        <span className="h-2 w-2 rounded-full" style={{ background: SENSOR_COLOR[p.sat.mission!.sensor] }} />
                        {p.sat.name}
                      </span>
                      <span className="font-mono text-[11px] text-cyan-300">{fmtLocal(p.tca)}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {p.estCoveragePct != null && <Badge tone="cyan">{t('Est. coverage')} {fmtNum(p.estCoveragePct, 0)}%</Badge>}
                      <Badge>{t('Sun')} {fmtNum(p.sunElevationDeg, 0)}°</Badge>
                      <Badge tone={p.confidence.tone}>{p.confidence.label}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[10px] leading-snug text-muted">{t('Optical night passes are hidden. Estimates only — not confirmed by any provider.')}</p>
          </Panel>
        )}
      </aside>

      <div className="relative min-h-[360px] flex-1">
        <GlobeHost onReady={setViewer} />
        {imaging.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-1/3 z-10 flex justify-center">
            <div className="rounded-md border border-line bg-ink-950/85 px-4 py-3 text-center">
              <div className="text-sm text-white">{t('No imaging satellites selected')}</div>
              <div className="mt-0.5 text-xs text-muted">{t('Tick a category such as Sentinel-2 or SAR on the left.')}</div>
            </div>
          </div>
        )}
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col gap-1 rounded-md border border-line bg-ink-950/80 px-2.5 py-2">
          <div className="flex gap-1.5">
            <Badge tone="cyan">{t('Nominal swath · SGP4')}</Badge>
            <Badge>{speed}×</Badge>
          </div>
          <div className="font-mono text-[11px] text-white">{fmtUtc(simTime)}</div>
        </div>
        {selected && (
          <div className="absolute right-3 top-3 z-10 w-[260px] rounded-md border border-line bg-navy-900/95 p-3 text-xs">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-semibold text-white">{selected.name}</span>
              <button onClick={() => setSel(null)} className="text-muted hover:text-white">✕</button>
            </div>
            <div className="text-muted">{selected.provider?.name}</div>
            <div className="mt-1.5 space-y-0.5 text-slate-300">
              <div>{t('Sensor')}: {t(SENSOR_LABEL[selected.mission!.sensor])}</div>
              <div>{t('Nominal resolution')}: {selected.mission!.resolution}</div>
              <div>{t('Swath')}: {selected.mission!.swathKm ? `${selected.mission!.swathKm} km` : t('Not documented here')}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
