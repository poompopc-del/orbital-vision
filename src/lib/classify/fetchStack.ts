// Read a feature stack for one scene over the analysis grid from the ORIGINAL bands (Planetary Computer
// band math, never RGB previews). Reflectance uses each sensor's scale/offset (see spectral.ts refl()).
// Water / vegetation indices are computed server-side (better 8-bit precision for dark water); the other
// indices are derived per pixel from the reflectance bands.
import { fetchRaster, type Grid } from '../change';
import { INDICES, indexExpression, refl, sarDbExpression, sensorOf, type Role } from '../spectral';
import type { ImageryItem } from '../stac';
import { dilateCloud, decodeSar, LANDSAT_RADSAT_EXPR, qaExpression } from './qa';
import { completeStack, type Stack } from './stack';
import { QA, type FeatureName, type Sensor } from './types';

export const REFL_RANGE: [number, number] = [0, 0.5];
const IDX_RANGE: [number, number] = [-1, 1];
const SAR_RANGE: [number, number] = [-35, 5];

export function stackSensor(it: ImageryItem): Sensor | null {
  const k = sensorOf(it);
  return k === 's2' || k === 'landsat' || k === 's1' ? k : null;
}

/** Number of rasters a stack read needs (for progress / cost display). */
export function stackRasterCount(it: ImageryItem) {
  const k = stackSensor(it);
  return k === 's1' ? 2 : k === 's2' ? 11 : 11;
}

export async function fetchStack(it: ImageryItem, grid: Grid, signal?: AbortSignal, progress?: (msg: string, done: number, total: number) => void): Promise<Stack> {
  const sensor = stackSensor(it);
  if (!sensor) throw new Error(`${it.collectionLabel}: classification needs Sentinel-2, Landsat 8/9 or Sentinel-1 RTC`);
  if (it.source !== 'planetary-computer') throw new Error('Scene is not from Planetary Computer — original bands are not readable');
  const n = grid.width * grid.height;
  const data: Partial<Record<FeatureName, Float32Array>> = {};
  const jobs: { name: string; run: () => Promise<void> }[] = [];
  const read = (name: string, expr: string, range: [number, number], set: (v: Float32Array) => void, opts?: { noNodata?: boolean }) =>
    jobs.push({ name, run: async () => set((await fetchRaster(it, expr, range, grid, signal, undefined, opts)).values) });
  let qa: Uint8Array = new Uint8Array(n);

  if (sensor === 's1') {
    read('VV', sarDbExpression('vv'), SAR_RANGE, (v) => (data.vv = v));
    read('VH', sarDbExpression('vh'), SAR_RANGE, (v) => (data.vh = v));
  } else {
    const bands: [FeatureName, Role][] = [['blue', 'blue'], ['green', 'green'], ['red', 'red'], ['nir', 'nir'], ['swir1', 'swir1'], ['swir2', 'swir2']];
    for (const [f, r] of bands) read(f.toUpperCase(), refl(it, r)!, REFL_RANGE, (v) => (data[f] = v));
    const ids = sensor === 's2' ? ['ndvi', 'ndwi', 'mndwi', 'ndre'] : ['ndvi', 'ndwi', 'mndwi'];
    for (const id of ids) read(id.toUpperCase(), indexExpression(it, INDICES.find((d) => d.id === id)!), IDX_RANGE, (v) => (data[id as FeatureName] = v));
    read('QA', qaExpression(sensor)!, [0, 255], (v) => {
      for (let p = 0; p < n; p++) qa[p] = Number.isNaN(v[p]) ? QA.NoData : Math.round(v[p]);
    });
  }
  let done = 0;
  const total = jobs.length + (sensor === 'landsat' ? 1 : 0);
  // two rasters at a time keeps the tile server and the browser responsive
  const queue = [...jobs];
  const worker = async () => {
    while (queue.length) {
      const j = queue.shift()!;
      progress?.(j.name, done, total);
      await j.run();
      progress?.(j.name, ++done, total);
    }
  };
  await Promise.all([worker(), worker()]);

  if (sensor === 'landsat') {
    progress?.('QA_RADSAT', done, total);
    try {
      const rs = await fetchRaster(it, LANDSAT_RADSAT_EXPR, [0, 255], grid, signal, undefined, { noNodata: true });
      for (let p = 0; p < n; p++) if (rs.values[p] > 1.5 && qa[p] !== QA.NoData) qa[p] = QA.Saturated;
    } catch {
      /* QA_RADSAT missing on some items: saturation stays unchecked (noted in the report) */
    }
  }

  if (sensor === 's1') {
    for (let p = 0; p < n; p++) qa[p] = decodeSar(data.vv![p], data.vh![p]);
  } else {
    // a pixel with no reflectance in any band is no data even when QA says otherwise
    for (let p = 0; p < n; p++) if (Number.isNaN(data.nir![p]) && Number.isNaN(data.green![p])) qa[p] = QA.NoData;
    qa = dilateCloud(qa, grid.width, grid.height, 1);
  }
  return completeStack({ sensor, width: grid.width, height: grid.height, data, qa, sceneId: it.id, acquired: it.datetime });
}

/** ESA WorldCover 2021 class codes on the grid (context for cropland / built-up), or null if unavailable. */
export async function fetchWorldCover(aoi: GeoJSON.Polygon, grid: Grid, signal?: AbortSignal): Promise<Float32Array | null> {
  const r = await fetch('https://planetarycomputer.microsoft.com/api/stac/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collections: ['esa-worldcover'], intersects: aoi, limit: 4, sortby: [{ field: 'properties.datetime', direction: 'desc' }] }),
    signal,
  }).catch(() => null);
  if (!r?.ok) return null;
  const feats: any[] = (await r.json()).features ?? [];
  const f = feats.find((x) => String(x.properties?.datetime ?? x.properties?.start_datetime ?? '').startsWith('2021')) ?? feats[0];
  if (!f) return null;
  const pseudo = { id: f.id, collection: 'esa-worldcover' } as unknown as ImageryItem;
  const m = await fetchRaster(pseudo, 'map', [0, 255], grid, signal).catch(() => null);
  return m?.values ?? null;
}
