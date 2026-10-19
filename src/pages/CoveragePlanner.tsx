import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n';
import GlobeHost from '../components/GlobeHost';
import AoiPicker from '../components/AoiPicker';
import { Badge, Button, Field, Notice, Panel, Spinner, cx } from '../components/ui';
import { Cesium, showAoi } from '../lib/cesium';
import { useOrbit, useWorkspace } from '../store';
import { MISSIONS } from '../data/missions';
import { SENSOR_COLOR } from '../data/providers';
import { findPassesBatched, type PassEstimate } from '../lib/passes';
import { groundTrack } from '../lib/orbit';
import { fmtLocal, fmtNum, fmtUtc } from '../lib/format';
import { logAudit } from '../lib/repo';

export default function CoveragePlanner() {
  const { sats, status } = useOrbit();
  const { aoi } = useWorkspace();
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const [missionIds, setMissionIds] = useState<string[]>(['sentinel-2', 'landsat', 'sentinel-1']);
  const [hours, setHours] = useState(72);
  const [passes, setPasses] = useState<PassEstimate[]>([]);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [onlyDay, setOnlyDay] = useState(false);

  const candidates = useMemo(() => sats.filter((s) => s.mission && missionIds.includes(s.mission.id) && s.periodMin < 300), [sats, missionIds]);
  const shown = useMemo(
    () => passes.filter((p) => !onlyDay || p.sat.mission?.sensor === 'sar' || p.sunElevationDeg > 0),
    [passes, onlyDay],
  );

  useEffect(() => {
    if (viewer) showAoi(viewer, aoi?.geometry ?? null);
  }, [viewer, aoi]);

  useEffect(() => {
    if (!viewer) return;
    ['pp-track', 'pp-swath', 'pp-sat'].forEach((id) => {
      const e = viewer.entities.getById(id);
      if (e) viewer.entities.remove(e);
    });
    if (sel == null || !shown[sel]) return;
    const p = shown[sel];
    const color = Cesium.Color.fromCssColorString(SENSOR_COLOR[p.sat.mission!.sensor]);
    const seg = groundTrack(p.sat, new Date(p.tca.getTime() - 6 * 60e3), 12, 10);
    viewer.entities.add({
      id: 'pp-track',
      polyline: { positions: seg.map((q) => Cesium.Cartesian3.fromDegrees(q.lon, q.lat)), width: 2, material: color, arcType: Cesium.ArcType.GEODESIC },
    });
    if (p.sat.mission?.swathKm)
      viewer.entities.add({
        id: 'pp-swath',
        corridor: { positions: seg.map((q) => Cesium.Cartesian3.fromDegrees(q.lon, q.lat)), width: p.sat.mission.swathKm * 1000, material: color.withAlpha(0.18), height: 0 },
      });
    const mid = seg[Math.floor(seg.length / 2)];
    if (mid) viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(mid.lon, mid.lat, 2.6e6), duration: 1.2 });
  }, [viewer, sel, shown]);

  const run = async () => {
    if (!aoi) return;
    setSel(null);
    setPasses([]);
    setBusy({ done: 0, total: candidates.length });
    const r = await findPassesBatched(candidates, aoi.geometry, new Date(), hours, (done, total) => setBusy({ done, total }));
    setPasses(r);
    setBusy(null);
    void logAudit('coverage.estimate', { missions: missionIds, hours, passes: r.length });
  };

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-line bg-ink-900 p-3 scroll-thin lg:w-[520px] lg:border-r">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400">{t('F · Coverage Planner')}</div>
          <h1 className="text-base font-semibold text-white">{t('Estimated observation opportunities')}</h1>
        </div>
        <Notice tone="warn">{t('A satellite passing over an area does not mean it will or can image it. These are geometric estimates from public orbital elements and nominal swath widths — not provider schedules. No pass shown here is confirmed by any provider.')} </Notice>
        <Panel title={t('Area of interest')}><AoiPicker viewer={viewer} compact /></Panel>
        <Panel title={t('Satellites & window')}>
          <div className="space-y-2.5">
            <div className="flex flex-wrap gap-1">
              {MISSIONS.filter((m) => m.id !== 'goes').map((m) => {
                const on = missionIds.includes(m.id);
                return (
                  <button
                    key={m.id}
                    onClick={() => setMissionIds(on ? missionIds.filter((x) => x !== m.id) : [...missionIds, m.id])}
                    className={cx('flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]', on ? 'border-cyan-400/50 text-white' : 'border-line text-muted')}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: SENSOR_COLOR[m.sensor] }} />
                    {m.name}
                  </button>
                );
              })}
            </div>
            <Field label={`${t('Look-ahead window')} · ${hours} h`}>
              <input type="range" min={12} max={168} step={12} value={hours} onChange={(e) => setHours(+e.target.value)} className="w-full" />
            </Field>
            <div className="flex items-center justify-between text-xs text-muted">
              <span>{candidates.length} {t('satellites selected')}{candidates.length > 60 ? ' — large constellations take longer' : ''}</span>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={onlyDay} onChange={(e) => setOnlyDay(e.target.checked)} /> {t('Hide optical night passes')}</label>
            </div>
            <Button variant="primary" className="w-full" disabled={!aoi || !candidates.length || !!busy || status !== 'ready'} onClick={run}>
              {busy ? <><Spinner /> {t('Propagating')} {busy.done}/{busy.total}</> : t('Estimate passes')}
            </Button>
            {!aoi && <p className="text-[11px] text-muted">{t('Select an AOI first.')}</p>}
          </div>
        </Panel>

        {passes.length > 0 && (
          <Panel title={`${t('Potential acquisition windows')} (${shown.length})`} bodyClass="p-0">
            <ul className="max-h-[560px] overflow-y-auto scroll-thin">
              {shown.map((p, i) => (
                <li key={`${p.sat.noradId}-${p.tca.getTime()}`}>
                  <button onClick={() => setSel(i)} className={cx('block w-full border-b border-white/5 px-3 py-2 text-left hover:bg-navy-800', sel === i && 'bg-cyan-400/10')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-xs text-white">
                        <span className="h-2 w-2 rounded-full" style={{ background: SENSOR_COLOR[p.sat.mission!.sensor] }} />
                        {p.sat.name}
                      </span>
                      <span className="font-mono text-[11px] text-cyan-300">{fmtLocal(p.tca)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge>{fmtUtc(p.tca)}</Badge>
                      <Badge>{fmtNum(p.minDistKm, 0)} {t('km from AOI centre')}</Badge>
                      {p.estCoveragePct != null ? <Badge tone="cyan">{t('Est. coverage')} {fmtNum(p.estCoveragePct, 0)}%</Badge> : <Badge tone="warn">{t('Coverage unknown')}</Badge>}
                      <Badge>{t(p.direction)}</Badge>
                      <Badge tone={p.sunElevationDeg > 0 ? 'idle' : 'info'}>{t('Sun')} {fmtNum(p.sunElevationDeg, 0)}°</Badge>
                      <Badge tone={p.confidence.tone}>{p.confidence.label}</Badge>
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-x-2 text-[10px] text-muted">
                      <span>Source: SGP4 + {p.basis === 'nominal-swath' ? `nominal ${p.sat.mission?.swathKm} km swath` : t('track proximity')}</span>
                      <span>
                        Tasking: {p.sat.mission?.tasking === 'commercial' ? t('via provider') : p.sat.mission?.tasking === 'agency' ? t('via agency') : t('not taskable')} · Provider confirmation: none
                      </span>
                    </div>
                    {p.notes.length > 0 && <div className="mt-1 text-[10px] text-warn">{p.notes.map((n) => t(n)).join(' · ')}</div>}
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        )}
        {!busy && passes.length === 0 && aoi && <p className="px-1 text-xs text-muted">{t('No estimates yet.')}</p>}
      </aside>
      <div className="relative min-h-[320px] flex-1">
        <GlobeHost onReady={setViewer} />
        <div className="pointer-events-none absolute left-3 top-3"><Badge tone="cyan">{t('Ground track ±6 min of closest approach')}</Badge></div>
      </div>
    </div>
  );
}
