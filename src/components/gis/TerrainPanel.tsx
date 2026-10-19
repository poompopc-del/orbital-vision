import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { Button, Field, Input, KV, Notice, Select, Spinner } from '../ui';
import { Cesium, hasIon, setTerrain } from '../../lib/cesium';
import {
  applyShading, ASPECT_STOPS, cellOf, elevationAt, ELEV_STOPS, hydroGeoJson, hydroImage, hydrology, sampleDem, setHillshade,
  setVerticalExaggeration, SLOPE_STOPS, snapPour, watershed, type DemGrid, type Hydro, type ShadeMode,
} from '../../lib/dem';
import { waterwaysInBbox } from '../../lib/overpass';
import { areaKm2, centroid, downloadJson } from '../../lib/geo';
import { bounds } from '../../lib/aoiEdit';
import { fmtNum } from '../../lib/format';
import { useWorkspace } from '../../store';
import { useGis } from './GisContext';
import { imageProvider } from './sceneLayer';

const grad = (stops: string[]) => `linear-gradient(90deg, ${stops.join(', ')})`;

export default function TerrainPanel() {
  const g = useGis();
  const { aoi } = useWorkspace();
  const [terrainOn, setTerrainOn] = useState(hasIon);
  const [shade, setShade] = useState<ShadeMode>('none');
  const [minH, setMinH] = useState(0);
  const [maxH, setMaxH] = useState(2000);
  const [spacing, setSpacing] = useState(100);
  const [vex, setVex] = useState(1);
  const [hill, setHill] = useState(false);
  const [elev, setElev] = useState<{ lon: number; lat: number; h: number | null } | null>(null);
  const [n, setN] = useState(100);
  const [minKm2, setMinKm2] = useState(1);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [grid, setGrid] = useState<DemGrid | null>(null);
  const [hy, setHy] = useState<Hydro | null>(null);
  const [ws, setWs] = useState<{ mask: Uint8Array; km2: number; cells: number } | null>(null);
  const [osmCount, setOsmCount] = useState<number | null>(null);
  const hyRef = useRef<{ grid: DemGrid; hy: Hydro } | null>(null);

  useEffect(() => {
    if (!g.resetKey) return;
    setShade('none');
    setVex(1);
    setHill(false);
    setElev(null);
    setGrid(null);
    setHy(null);
    setWs(null);
    setOsmCount(null);
    setErr('');
    hyRef.current = null;
  }, [g.resetKey]);
  useEffect(() => {
    if (g.viewer) void setTerrain(g.viewer, terrainOn);
  }, [g.viewer, terrainOn]);
  useEffect(() => {
    if (g.viewer) applyShading(g.viewer, shade, { minHeight: minH, maxHeight: maxH, contourSpacing: spacing });
    if (shade === 'none') g.removeLayer('terrain-legend');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.viewer, shade, minH, maxH, spacing]);
  useEffect(() => {
    if (g.viewer) setVerticalExaggeration(g.viewer, vex);
  }, [g.viewer, vex]);
  useEffect(() => {
    if (g.viewer) setHillshade(g.viewer, hill, aoi ? centroid(aoi.geometry) : undefined);
  }, [g.viewer, hill, aoi]);

  useEffect(
    () =>
      g.onMapClick('elevation', async (lon, lat) => {
        if (!g.viewer) return;
        setElev({ lon, lat, h: null });
        try {
          setElev({ lon, lat, h: await elevationAt(g.viewer, lon, lat) });
        } catch {
          setElev({ lon, lat, h: null });
        }
      }),
    [g.onMapClick, g.viewer],
  );

  useEffect(
    () =>
      g.onMapClick('pour', (lon, lat) => {
        const cur = hyRef.current;
        if (!cur) return;
        const c = cellOf(cur.grid, lon, lat);
        if (c == null) return setErr(t('Pour point is outside the analysed grid'));
        const outlet = snapPour(cur.grid, cur.hy, c);
        const mask = watershed(cur.grid, cur.hy, outlet);
        let cells = 0;
        mask.forEach((m) => (cells += m));
        setWs({ mask, cells, km2: cells * cur.grid.cellKm2 });
        void drawHydro(cur.grid, cur.hy, mask);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [g.onMapClick, minKm2],
  );

  const drawHydro = async (gr: DemGrid, h: Hydro, mask: Uint8Array | null) => {
    const minCells = Math.max(2, Math.round(minKm2 / gr.cellKm2));
    const url = hydroImage(gr, h, minCells, mask);
    g.putImagery('hydro', t('DEM-derived flow paths'), await imageProvider(url, gr.west, gr.south, gr.east, gr.north), {
      meta: `Cesium World Terrain · ${gr.nx}×${gr.ny} grid · cell ≈ ${Math.round(gr.cellM)} m`,
      legend: {
        items: [
          { color: 'rgb(20,200,255)', label: `${t('Flow accumulation ≥')} ${minKm2} km² (${minCells} ${t('cells')})` },
          ...(mask ? [{ color: 'rgba(255,170,40,0.6)', label: t('Watershed of pour point') }] : []),
        ],
        note: t('Estimated from elevation only — not mapped rivers and not a flood path.'),
      },
    });
  };

  const runHydro = async () => {
    if (!g.viewer || !aoi) return;
    if (!terrainOn) return setErr(t('Turn on 3D terrain first (needs the Cesium ion token).'));
    const km2 = areaKm2(aoi.geometry);
    if (km2 > 2500) return setErr(t('AOI too large for browser hydrology (max 2,500 km²). Draw a smaller rectangle.'));
    setErr('');
    setWs(null);
    try {
      const b = bounds(aoi.geometry);
      setBusy(t('Sampling terrain…'));
      const gr = await sampleDem(g.viewer, [b.west, b.south, b.east, b.north], n, (p) => setBusy(`${t('Sampling terrain…')} ${Math.round(p * 100)}%`));
      const nan = gr.z.reduce((a, v) => a + (Number.isNaN(v) ? 1 : 0), 0);
      setBusy(t('Filling sinks, D8 flow direction, accumulation…'));
      await new Promise((r) => setTimeout(r, 20));
      const h = hydrology(gr);
      setGrid(gr);
      setHy(h);
      hyRef.current = { grid: gr, hy: h };
      await drawHydro(gr, h, null);
      const zs = Array.from(gr.z).filter((v) => !Number.isNaN(v));
      setMinH(Math.floor(Math.min(...zs)));
      setMaxH(Math.ceil(Math.max(...zs)));
      if (nan) setErr(`${nan} ${t('cells had no terrain value and were filled')}`);
      g.putReport({
        id: 'hydro',
        title: 'DEM hydrology',
        lines: [
          `DEM: Cesium World Terrain (heights above WGS84 ellipsoid), grid ${gr.nx}×${gr.ny}, cell ≈ ${Math.round(gr.cellM)} m`,
          `Method: priority-flood sink fill (ε), D8 flow direction, flow accumulation`,
          `Cells raised by sink filling: ${h.raised}`,
          `Stream threshold: ${minKm2} km² upstream area`,
          'DEM-derived paths are estimates, not mapped rivers or flood paths.',
        ],
      });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const showWaterways = async () => {
    if (!aoi) return;
    const b = bounds(aoi.geometry);
    setBusy(t('Loading mapped waterways (OpenStreetMap)…'));
    try {
      const lines = await waterwaysInBbox(b.west, b.south, b.east, b.north);
      const ds = new Cesium.CustomDataSource('osm-waterways');
      lines.forEach((l) =>
        ds.entities.add({
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(l.coords.flat()),
            width: l.kind === 'river' ? 3 : 1.5,
            material: Cesium.Color.fromCssColorString(l.kind === 'canal' || l.kind === 'drain' ? '#b07cff' : '#3a7bff'),
            clampToGround: true,
          },
        }),
      );
      setOsmCount(lines.length);
      g.putDataSource('osm-waterways', t('Mapped waterways (OpenStreetMap)'), ds, {
        meta: `${lines.length} ways · © OpenStreetMap contributors`,
        legend: { items: [{ color: '#3a7bff', label: t('River / stream (mapped)') }, { color: '#b07cff', label: t('Canal / drain (mapped)') }] },
      });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  useEffect(() => {
    if (shade === 'none') return;
    const legend =
      shade === 'slope'
        ? { ramp: grad(SLOPE_STOPS), range: [0, 90] as [number, number], unit: '° (flat → steep)' }
        : shade === 'aspect'
          ? { ramp: grad(ASPECT_STOPS), range: [0, 360] as [number, number], unit: '° from N (N→E→S→W)' }
          : shade === 'contour'
            ? { items: [{ color: '#ffd34d', label: `${t('Contour every')} ${spacing} m` }] }
            : { ramp: grad(ELEV_STOPS), range: [minH, maxH] as [number, number], unit: 'm', note: shade === 'elevation+contour' ? `${t('Contour every')} ${spacing} m` : undefined };
    g.putDataSource('terrain-legend', `${t('Terrain')}: ${t(shade)}`, new Cesium.CustomDataSource('terrain-legend'), {
      meta: `Cesium World Terrain · ${t('vertical exaggeration')} ×${vex}`,
      legend: { ...legend, note: `${(legend as any).note ? (legend as any).note + ' · ' : ''}${t('Heights: metres above the WGS84 ellipsoid (differs from MSL by the geoid, tens of metres in Thailand).')}` },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shade, minH, maxH, spacing, vex]);

  return (
    <div className="space-y-2.5">
      {!hasIon && <Notice tone="warn">{t('3D terrain needs VITE_CESIUM_ION_TOKEN (Cesium World Terrain).')}</Notice>}
      <label className="flex items-center gap-2 text-xs text-slate-200">
        <input type="checkbox" checked={terrainOn} disabled={!hasIon} onChange={(e) => setTerrainOn(e.target.checked)} /> {t('3D terrain (Cesium World Terrain)')}
      </label>
      <Field label={`${t('Vertical exaggeration')} · ×${vex}`}>
        <input type="range" min={1} max={5} step={0.5} value={vex} onChange={(e) => setVex(+e.target.value)} className="w-full" />
      </Field>
      <Field label={t('Terrain shading')}>
        <Select value={shade} onChange={(e) => setShade(e.target.value as ShadeMode)} disabled={!terrainOn}>
          {(['none', 'elevation', 'slope', 'aspect', 'contour', 'elevation+contour'] as ShadeMode[]).map((m) => <option key={m} value={m}>{t(m)}</option>)}
        </Select>
      </Field>
      {(shade === 'elevation' || shade === 'elevation+contour') && (
        <div className="grid grid-cols-2 gap-1.5">
          <Field label={t('Min height (m)')}><Input type="number" value={minH} onChange={(e) => setMinH(+e.target.value)} /></Field>
          <Field label={t('Max height (m)')}><Input type="number" value={maxH} onChange={(e) => setMaxH(+e.target.value)} /></Field>
        </div>
      )}
      {(shade === 'contour' || shade === 'elevation+contour') && (
        <Field label={t('Contour interval (m)')}><Input type="number" min={5} value={spacing} onChange={(e) => setSpacing(Math.max(5, +e.target.value))} /></Field>
      )}
      <label className="flex items-center gap-2 text-xs text-slate-200">
        <input type="checkbox" checked={hill} disabled={!terrainOn} onChange={(e) => setHill(e.target.checked)} /> {t('Hillshade (light from NW, 45°)')}
      </label>

      <div className="rounded border border-line p-2">
        <div className="label mb-1">{t('Elevation at a point')}</div>
        <p className="text-[11px] text-muted">{t('Choose the “Elevation” tool on the toolbar and click the map.')}</p>
        {elev && (
          <div className="mt-1 font-mono text-xs text-white">
            {elev.lat.toFixed(5)}, {elev.lon.toFixed(5)} → {elev.h == null ? '…' : `${fmtNum(elev.h, 1)} m`}
          </div>
        )}
      </div>

      <div className="rounded border border-line p-2">
        <div className="label mb-1">{t('Flow direction, accumulation & watershed')}</div>
        <div className="grid grid-cols-2 gap-1.5">
          <Field label={t('Grid cells per side')}>
            <Select value={n} onChange={(e) => setN(+e.target.value)}>{[60, 100, 140].map((x) => <option key={x} value={x}>{x}</option>)}</Select>
          </Field>
          <Field label={t('Stream threshold (km²)')}><Input type="number" step="0.5" min={0.1} value={minKm2} onChange={(e) => setMinKm2(Math.max(0.1, +e.target.value))} /></Field>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Button variant="primary" onClick={runHydro} disabled={!aoi || !!busy}>{t('Run hydrology on AOI')}</Button>
          {grid && hy && <Button onClick={() => drawHydro(grid, hy, ws?.mask ?? null)}>{t('Redraw')}</Button>}
          <Button onClick={showWaterways} disabled={!aoi || !!busy}>{t('Mapped waterways (OSM)')}</Button>
        </div>
        {grid && <p className="mt-1 text-[11px] text-cyan-300">{t('Choose the “Pour point” tool and click on a flow path to delineate its watershed.')}</p>}
        {busy && <div className="mt-1 flex items-center gap-2 text-xs text-muted"><Spinner /> {busy}</div>}
        {err && <div className="mt-1"><Notice tone="warn">{err}</Notice></div>}
        {grid && hy && (
          <dl className="mt-1.5">
            <KV k={t('Grid')} v={`${grid.nx} × ${grid.ny} · ${t('cell')} ≈ ${Math.round(grid.cellM)} m`} mono />
            <KV k={t('Cells raised by sink filling')} v={hy.raised.toLocaleString()} mono />
            {ws && <KV k={t('Watershed area')} v={`${fmtNum(ws.km2, 2)} km² (${ws.cells} ${t('cells')})`} mono />}
            {osmCount != null && <KV k={t('Mapped waterways in AOI')} v={osmCount} mono />}
          </dl>
        )}
        {grid && hy && (
          <Button className="mt-1.5" onClick={() => downloadJson('dem-hydrology.geojson', hydroGeoJson(grid, hy, Math.max(2, Math.round(minKm2 / grid.cellKm2)), ws?.mask ?? null, { dem: 'Cesium World Terrain', cellM: Math.round(grid.cellM) }))}>
            {t('Export GeoJSON')}
          </Button>
        )}
        <p className="mt-1.5 text-[10px] leading-snug text-muted">
          {t('Runs in the browser on a terrain grid sampled over the AOI (sink fill: priority-flood, Barnes et al. 2014; D8: O’Callaghan & Mark 1984). Resolution is limited by the grid; DEM-derived paths are not mapped rivers or flood paths. Large areas need a GIS processing backend. DEM GeoTIFF upload is not supported yet.')}
        </p>
      </div>
    </div>
  );
}
