import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n';
import { Link } from 'react-router-dom';
import GlobeHost from '../components/GlobeHost';
import AoiPicker from '../components/AoiPicker';
import SatPicker from '../components/SatPicker';
import SatDetails from '../components/SatDetails';
import { Badge, Button, Input, Notice, Panel, cx } from '../components/ui';
import { Cesium, getLabelsLayer, getBaseName, hasIon, setTerrain, showAoi } from '../lib/cesium';
import { elementAgeDays, groundTrack, propagateSubPoint, type SatRecord } from '../lib/orbit';
import { SENSOR_COLOR, SENSOR_LABEL, type SensorCategory } from '../data/providers';
import { useOrbit, useWorkspace } from '../store';
import { fmtLatLon, fmtUtc } from '../lib/format';
import { refreshOrbits } from '../lib/orbitLoader';

type Mode = 'live' | 'historical' | 'coverage';
const SENSORS = Object.keys(SENSOR_LABEL) as SensorCategory[];

export default function MissionControl() {
  const { sats, status, error, source, fetchedAt } = useOrbit();
  const { aoi, selectedSat, setSelectedSat, mySats, setMySats } = useWorkspace();
  const [focus, setFocus] = useState(false);
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const [mode, setMode] = useState<Mode>('live');
  const [scene2d, setScene2d] = useState(false);
  const [terrain, setTerrainOn] = useState(false);
  const [labels, setLabels] = useState(true);
  const [simTime, setSimTime] = useState(new Date());
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(null);
  const [histDate, setHistDate] = useState(() => new Date(Date.now() - 86400000).toISOString().slice(0, 16));
  const [showPanel, setShowPanel] = useState(true);
  const [follow, setFollow] = useState(false);
  const followRef = useRef<{ on: boolean; id: string | null }>({ on: false, id: null });
  const pointsRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
  const pointMap = useRef(new Map<string, Cesium.PointPrimitive>());

  const visible = useMemo(() => {
    const set = new Set(mySats);
    return sats.filter((s) => set.has(s.noradId));
  }, [sats, mySats]);

  const selected = useMemo(() => sats.find((s) => s.noradId === selectedSat) ?? null, [sats, selectedSat]);

  // ---------- satellite point primitives ----------
  useEffect(() => {
    if (!viewer) return;
    const coll = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    pointsRef.current = coll;
    return () => {
      if (!viewer.isDestroyed()) viewer.scene.primitives.remove(coll);
      pointsRef.current = null;
      pointMap.current.clear();
    };
  }, [viewer]);

  useEffect(() => {
    const coll = pointsRef.current;
    if (!viewer || !coll) return;
    coll.removeAll();
    pointMap.current.clear();
    const t = Cesium.JulianDate.toDate(viewer.clock.currentTime);
    for (const s of visible) {
      const p = propagateSubPoint(s, t);
      if (!p) continue;
      const color = Cesium.Color.fromCssColorString(SENSOR_COLOR[s.mission!.sensor]);
      const pt = coll.add({
        id: s.noradId,
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.heightKm * 1000),
        pixelSize: s.noradId === selectedSat ? 10 : 6,
        color,
        outlineColor: s.noradId === selectedSat ? Cesium.Color.WHITE : Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: s.noradId === selectedSat ? 2 : 1,
        scaleByDistance: new Cesium.NearFarScalar(1.5e6, 1.4, 4e7, 0.7),
      });
      pointMap.current.set(s.noradId, pt);
    }
  }, [viewer, visible, selectedSat]);

  // ---------- propagation loop on the Cesium clock ----------
  useEffect(() => {
    if (!viewer) return;
    let last = 0;
    const byId = new Map<string, SatRecord>(sats.map((s) => [s.noradId, s] as [string, SatRecord]));
    const remove = viewer.clock.onTick.addEventListener((clock) => {
      const now = performance.now();
      if (now - last < 250) return;
      last = now;
      const t = Cesium.JulianDate.toDate(clock.currentTime);
      pointMap.current.forEach((pt, id) => {
        const s = byId.get(id);
        if (!s) return;
        const p = propagateSubPoint(s, t);
        if (p) pt.position = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.heightKm * 1000);
      });
      const f = followRef.current;
      if (f.on && f.id) {
        const s = byId.get(f.id);
        const p = s && propagateSubPoint(s, t);
        if (p) {
          const target = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.heightKm * 1000);
          const cam = viewer.camera;
          const range = Math.max(4e5, Math.min(2e7, Cesium.Cartesian3.distance(cam.positionWC, target)));
          cam.lookAt(target, new Cesium.HeadingPitchRange(cam.heading, Math.min(-0.2, cam.pitch), range));
        }
      }
      setSimTime(t);
    });
    return () => remove();
  }, [viewer, sats]);

  // ---------- picking + cursor readout ----------
  useEffect(() => {
    if (!viewer) return;
    const h = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    h.setInputAction((e: any) => {
      const picked = viewer.scene.pick(e.position);
      if (picked && picked.primitive instanceof Cesium.PointPrimitive && typeof picked.id === 'string') setSelectedSat(picked.id);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    let raf = 0;
    h.setInputAction((e: any) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const c = viewer.camera.pickEllipsoid(e.endPosition, viewer.scene.globe.ellipsoid);
        if (!c) return setCursor(null);
        const k = Cesium.Cartographic.fromCartesian(c);
        setCursor({ lat: Cesium.Math.toDegrees(k.latitude), lon: Cesium.Math.toDegrees(k.longitude) });
      });
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    return () => h.destroy();
  }, [viewer, setSelectedSat]);

  // ---------- selected satellite: orbit, ground track, footprint ----------
  const trackKey = selected ? `${selected.noradId}-${Math.floor(simTime.getTime() / 300000)}` : '';
  useEffect(() => {
    if (!viewer) return;
    const ids = ['ov-orbit', 'ov-track', 'ov-swath', 'ov-label'];
    ids.forEach((id) => {
      const e = viewer.entities.getById(id);
      if (e) viewer.entities.remove(e);
    });
    if (!selected) return;
    const t0 = Cesium.JulianDate.toDate(viewer.clock.currentTime);
    const per = Math.min(selected.periodMin, 1440);
    const orbit = groundTrack(selected, new Date(t0.getTime() - (per / 2) * 60000), per, per > 300 ? 300 : 30);
    const color = Cesium.Color.fromCssColorString(SENSOR_COLOR[selected.mission!.sensor]);
    viewer.entities.add({
      id: 'ov-orbit',
      polyline: {
        positions: orbit.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.heightKm * 1000)),
        width: 1.5,
        material: color.withAlpha(0.8),
        arcType: Cesium.ArcType.NONE,
      },
    });
    if (selected.periodMin < 300) {
      const track = groundTrack(selected, t0, selected.periodMin * 1.5, 30);
      viewer.entities.add({
        id: 'ov-track',
        polyline: {
          positions: track.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0)),
          width: 1.5,
          material: new Cesium.PolylineDashMaterialProperty({ color: color.withAlpha(0.7), dashLength: 12 }),
          arcType: Cesium.ArcType.GEODESIC,
        },
      });
      const sw = selected.mission?.swathKm;
      if (sw) {
        const seg = groundTrack(selected, t0, 8, 20);
        viewer.entities.add({
          id: 'ov-swath',
          corridor: {
            positions: seg.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat)),
            width: sw * 1000,
            material: color.withAlpha(0.18),
            height: 0,
          },
        });
      }
    }
    const now = propagateSubPoint(selected, t0);
    if (now)
      viewer.entities.add({
        id: 'ov-label',
        position: Cesium.Cartesian3.fromDegrees(now.lon, now.lat, now.heightKm * 1000),
        label: {
          text: selected.name,
          font: '11px "JetBrains Mono", monospace',
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#0b1524').withAlpha(0.85),
          pixelOffset: new Cesium.Cartesian2(0, -18),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, trackKey, selected]);

  // label follows the satellite
  useEffect(() => {
    if (!viewer || !selected) return;
    const e = viewer.entities.getById('ov-label');
    const p = propagateSubPoint(selected, simTime);
    if (e && p) e.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.heightKm * 1000));
  }, [viewer, selected, simTime]);

  // ---------- mission coverage mode: footprints for all visible sats ----------
  const covKey = mode === 'coverage' ? `${visible.length}-${Math.floor(simTime.getTime() / 120000)}` : 'off';
  useEffect(() => {
    if (!viewer) return;
    const old = viewer.entities.values.filter((e) => String(e.id).startsWith('ov-cov-'));
    old.forEach((e) => viewer.entities.remove(e));
    if (mode !== 'coverage') return;
    const t0 = Cesium.JulianDate.toDate(viewer.clock.currentTime);
    visible
      .filter((s) => s.mission?.swathKm && s.periodMin < 300)
      .slice(0, 80)
      .forEach((s) => {
        const seg = groundTrack(s, t0, 10, 30);
        if (seg.length < 2) return;
        viewer.entities.add({
          id: `ov-cov-${s.noradId}`,
          corridor: {
            positions: seg.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat)),
            width: s.mission!.swathKm! * 1000,
            material: Cesium.Color.fromCssColorString(SENSOR_COLOR[s.mission!.sensor]).withAlpha(0.13),
            height: 0,
          },
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, covKey]);

  // ---------- AOI ----------
  useEffect(() => {
    if (viewer) showAoi(viewer, aoi?.geometry ?? null);
  }, [viewer, aoi]);

  // ---------- modes ----------
  useEffect(() => {
    if (!viewer) return;
    const clock = viewer.clock;
    if (mode === 'live' || mode === 'coverage') {
      const now = new Date();
      clock.startTime = Cesium.JulianDate.fromDate(new Date(now.getTime() - 6 * 3600e3));
      clock.stopTime = Cesium.JulianDate.fromDate(new Date(now.getTime() + 24 * 3600e3));
      clock.currentTime = Cesium.JulianDate.fromDate(now);
      clock.multiplier = mode === 'coverage' ? 30 : 1;
      clock.clockRange = Cesium.ClockRange.UNBOUNDED;
      clock.shouldAnimate = true;
    }
    viewer.timeline?.zoomTo(clock.startTime, clock.stopTime);
  }, [viewer, mode]);

  const applyHistorical = () => {
    if (!viewer) return;
    const d = new Date(histDate + 'Z');
    const clock = viewer.clock;
    clock.startTime = Cesium.JulianDate.fromDate(new Date(d.getTime() - 12 * 3600e3));
    clock.stopTime = Cesium.JulianDate.fromDate(new Date(d.getTime() + 12 * 3600e3));
    clock.currentTime = Cesium.JulianDate.fromDate(d);
    clock.multiplier = 60;
    clock.shouldAnimate = true;
    viewer.timeline?.zoomTo(clock.startTime, clock.stopTime);
  };

  useEffect(() => {
    if (!viewer) return;
    if (scene2d) viewer.scene.morphTo2D(1.2);
    else viewer.scene.morphTo3D(1.2);
  }, [viewer, scene2d]);
  useEffect(() => {
    if (viewer) void setTerrain(viewer, terrain);
  }, [viewer, terrain]);
  useEffect(() => {
    if (!viewer) return;
    let tries = 0;
    const t = setInterval(() => {
      const l = getLabelsLayer(viewer);
      if (++tries > 40) clearInterval(t);
      if (l) {
        l.show = labels;
        clearInterval(t);
      }
    }, 300);
    return () => clearInterval(t);
  }, [viewer, labels]);

  // fly to a satellite as soon as it is selected (globe click or list)
  const flyToSat = (id: string | null) => {
    if (!viewer || !id) return;
    const s = sats.find((x) => x.noradId === id);
    if (!s) return;
    const now = Cesium.JulianDate.toDate(viewer.clock.currentTime);
    const lead = propagateSubPoint(s, new Date(now.getTime() + 1500)); // where it will be when the flight ends
    if (!lead) return;
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lead.lon, lead.lat, lead.heightKm * 1000 + Math.max(1.2e6, lead.heightKm * 400)),
      duration: 1.5,
    });
  };
  useEffect(() => {
    if (!follow) flyToSat(selectedSat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, selectedSat]);

  useEffect(() => {
    followRef.current = { on: follow && !!selectedSat, id: selectedSat };
    if (viewer && (!follow || !selectedSat)) viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }, [viewer, follow, selectedSat]);

  // focus mode: hide panels, overlays and Cesium clock widgets; Esc exits
  useEffect(() => {
    if (!viewer) return;
    const els = [viewer.timeline?.container, viewer.animation?.container] as (HTMLElement | undefined)[];
    els.forEach((el) => el && (el.style.display = focus ? 'none' : ''));
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFocus(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewer, focus]);

  const isLive = Math.abs(simTime.getTime() - Date.now()) < 10000;
  const maxAge = selected ? elementAgeDays(selected, simTime) : null;

  return (
    <div className="relative flex h-full">
      {/* -------- left control panel -------- */}
      <aside
        className={cx(
          'z-20 flex w-[290px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-line bg-ink-900 p-3 scroll-thin',
          'absolute inset-y-0 left-0 transition-transform md:static md:translate-x-0',
          !showPanel && '-translate-x-full md:hidden',
          focus && 'hidden md:hidden',
        )}
      >
        <Panel title={t('Location / AOI')}>
          <AoiPicker viewer={viewer} />
        </Panel>

        <Panel title={t('Visualisation')}>
          <div className="grid grid-cols-3 gap-1.5">
            {(['live', 'historical', 'coverage'] as Mode[]).map((m) => (
              <Button key={m} variant={mode === m ? 'active' : 'ghost'} onClick={() => setMode(m)} className="capitalize">
                {t(m)}
              </Button>
            ))}
          </div>
          {mode === 'historical' && (
            <div className="mt-2 space-y-1.5">
              <Input type="datetime-local" value={histDate} onChange={(e) => setHistDate(e.target.value)} />
              <Button variant="primary" className="w-full" onClick={applyHistorical}>{t('Replay from this time (UTC)')}</Button>
              <p className="text-[10px] leading-snug text-warn">{t('Replays use the current public element sets propagated backwards. Archived historical elements require a Space-Track account (not integrated), so accuracy drops the further you go from each epoch.')} </p>
            </div>
          )}
          {mode === 'coverage' && (
            <p className="mt-2 text-[10px] leading-snug text-muted">{t('Shows the next ~10 min of nominal swath for satellites with documented swath widths, at 30× speed. Estimates only — not imaging plans.')} </p>
          )}
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            <Button variant={!scene2d ? 'active' : 'ghost'} onClick={() => setScene2d(false)}>3D</Button>
            <Button variant={scene2d ? 'active' : 'ghost'} onClick={() => setScene2d(true)}>2D</Button>
            <Button
              variant={terrain ? 'active' : 'ghost'}
              disabled={!hasIon}
              title={hasIon ? 'Cesium World Terrain' : 'Needs VITE_CESIUM_ION_TOKEN'}
              onClick={() => setTerrainOn(!terrain)}
            >{t('Terrain')} </Button>
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> {t('Boundaries & place names')} </label>
        </Panel>

        <SatPicker />

        {status === 'error' && (
          <div className="space-y-2">
            <Notice tone="bad">{t('Orbital data unavailable:')} {error}. {t('No positions are shown rather than simulated ones.')}</Notice>
            <Button onClick={() => refreshOrbits(true)}>{t('Retry')}</Button>
          </div>
        )}

        <Button variant="primary" className="w-full" onClick={() => setFocus(true)}>⛶ {t('Focus mode')}</Button>
      </aside>

      {/* -------- globe -------- */}
      <div className="relative min-w-0 flex-1">
        <GlobeHost onReady={setViewer} options={{ timeline: true, animation: true }} />

        {focus ? (
          <div className="absolute right-3 top-3 z-30 flex items-center gap-2">
            {selected && <span className="rounded bg-ink-950/70 px-2 py-1 font-mono text-[11px] text-white">{selected.name}</span>}
            <Button onClick={() => setFocus(false)} className="bg-ink-950/70">✕ {t('Exit focus mode')} (Esc)</Button>
          </div>
        ) : (
          <button
            onClick={() => setFocus(true)}
            title={t('Focus mode')}
            className="absolute bottom-[100px] right-3 z-20 rounded border border-line bg-navy-900/90 px-2.5 py-1.5 text-xs text-slate-200 hover:border-cyan-400/50 hover:text-white"
          >
            ⛶ {t('Focus mode')}
          </button>
        )}

        <button
          onClick={() => setShowPanel(!showPanel)}
          className={cx('absolute left-3 top-3 z-30 rounded border border-line bg-navy-900/90 px-2 py-1 font-mono text-[10px] text-slate-300 md:hidden', focus && 'hidden')}
        >
          {showPanel ? 'HIDE' : 'PANEL'}
        </button>

        <div className={cx('pointer-events-none absolute left-3 top-3 z-10 hidden flex-col gap-1.5 rounded-md border border-line bg-ink-950/80 px-2.5 py-2 backdrop-blur', !focus && 'md:flex')}>
          <div className="flex items-center gap-1.5">
            {mode === 'historical' ? <Badge tone="warn">{t('Historical replay')}</Badge> : isLive ? <Badge tone="ok">{t('● Live clock')}</Badge> : <Badge tone="info">{t('Simulation time')}</Badge>}
            <Badge tone="cyan">{t('Propagated orbit · SGP4')}</Badge>
          </div>
          <div className="font-mono text-[11px] text-white">{fmtUtc(simTime)}</div>
          {fetchedAt && <div className="font-mono text-[10px] text-muted">{source} · {t('fetched')} {fmtUtc(fetchedAt)}</div>}
          {viewer && <div className="font-mono text-[10px] text-muted">{t('Base:')} {getBaseName(viewer) || '…'}</div>}
          {maxAge != null && Math.abs(maxAge) > 7 && <Badge tone="warn">Selected element set {Math.abs(maxAge).toFixed(0)} d from epoch</Badge>}
        </div>

        {status === 'ready' && visible.length === 0 && !focus && (
          <div className="pointer-events-none absolute inset-x-0 top-1/3 z-10 flex justify-center">
            <div className="rounded-md border border-line bg-ink-950/85 px-4 py-3 text-center">
              <div className="text-sm text-white">{t('No satellites selected')}</div>
              <div className="mt-0.5 text-xs text-muted">{t('Search or pick a category in “My satellites” on the left.')}</div>
            </div>
          </div>
        )}

        {cursor && (
          <div className="pointer-events-none absolute bottom-[70px] right-3 z-10 rounded bg-navy-900/80 px-2 py-1 font-mono text-[10px] text-slate-300">
            {fmtLatLon(cursor.lat, cursor.lon)}
          </div>
        )}

        {selected && !focus && (
          <div className="absolute right-3 top-3 z-20 max-h-[calc(100%-150px)] w-[300px] max-w-[calc(100%-24px)] overflow-y-auto rounded-md border border-line bg-navy-900/95 p-3 shadow-2xl backdrop-blur scroll-thin">
            <div className="mb-2 flex items-center justify-between">
              <span className="label">{t('Selected satellite')}</span>
              <button onClick={() => { setSelectedSat(null); setFollow(false); }} className="text-muted hover:text-white">✕</button>
            </div>
            <SatDetails sat={selected} at={simTime} showTle={false} />
            <div className="mt-3 flex gap-1.5">
              <Button
                className="flex-1"
                onClick={() => flyToSat(selected.noradId)}
              >{t('Fly to')} </Button>
              <Button variant={follow ? 'active' : 'ghost'} className="flex-1" onClick={() => setFollow(!follow)}>
                {follow ? t('Stop following') : t('Follow')}
              </Button>
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <Button
                variant="danger"
                className="flex-1"
                onClick={() => {
                  setMySats(mySats.filter((x) => x !== selected.noradId));
                  setSelectedSat(null);
                  setFollow(false);
                }}
              >
                {t('Remove from selection')}
              </Button>
              <Link to={`/catalog?sat=${selected.noradId}`} className="flex-1">
                <Button className="w-full">{t('Catalog record')}</Button>
              </Link>
            </div>
          </div>
        )}

        <div className={cx('pointer-events-none absolute bottom-[70px] left-1/2 z-10 hidden -translate-x-1/2', !focus && 'md:block')}>
          <div className="flex gap-3 rounded bg-navy-900/80 px-3 py-1">
            {SENSORS.map((s) => (
              <span key={s} className="flex items-center gap-1 text-[10px] text-slate-300">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: SENSOR_COLOR[s] }} />
                {t(SENSOR_LABEL[s])}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
