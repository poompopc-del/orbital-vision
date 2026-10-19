// Spectral indices, composites and statistics computed from the ORIGINAL band data by the
// Microsoft Planetary Computer data API (TiTiler). Rendered previews are never used for numbers.
//
// Band mapping is sensor-aware:
//   Sentinel-2 L2A (PC assets): B02 blue 490 nm · B03 green 560 · B04 red 665 · B05 red-edge 705 ·
//     B06 740 · B07 783 · B08 NIR 842 (10 m) · B8A NIR-narrow 865 (20 m) · B11 SWIR1 1610 · B12 SWIR2 2190 · SCL scene class
//     Reflectance = (DN − offset) / 10000, offset = 1000 for processing baseline ≥ 04.00 (Jan 2022 onwards), else 0.
//   Landsat 8/9 C2 L2 (PC assets): blue 482 · green 561 · red 655 · nir08 865 · swir16 1609 · swir22 2201,
//     reflectance via the assets' scale/offset (unscale=true).
//   Sentinel-1 RTC: vv / vh terrain-corrected backscatter γ⁰ (linear) → dB = 10·log10(γ⁰).
import type { ImageryItem } from './stac';

export const PC_DATA = 'https://planetarycomputer.microsoft.com/api/data/v1';

export type Role = 'blue' | 'green' | 'red' | 're1' | 're2' | 're3' | 'nir' | 'nirn' | 'swir1' | 'swir2';
export type SensorKind = 's2' | 'landsat' | 's1' | 'other';

export interface BandInfo {
  asset: string;
  label: string;
  nm?: number;
  res: string;
}

export const S2_BANDS: Record<Role, BandInfo> = {
  blue: { asset: 'B02', label: 'B2 Blue', nm: 490, res: '10 m' },
  green: { asset: 'B03', label: 'B3 Green', nm: 560, res: '10 m' },
  red: { asset: 'B04', label: 'B4 Red', nm: 665, res: '10 m' },
  re1: { asset: 'B05', label: 'B5 Red edge 1', nm: 705, res: '20 m' },
  re2: { asset: 'B06', label: 'B6 Red edge 2', nm: 740, res: '20 m' },
  re3: { asset: 'B07', label: 'B7 Red edge 3', nm: 783, res: '20 m' },
  nir: { asset: 'B08', label: 'B8 NIR', nm: 842, res: '10 m' },
  nirn: { asset: 'B8A', label: 'B8A NIR narrow', nm: 865, res: '20 m' },
  swir1: { asset: 'B11', label: 'B11 SWIR1', nm: 1610, res: '20 m' },
  swir2: { asset: 'B12', label: 'B12 SWIR2', nm: 2190, res: '20 m' },
};

export const LANDSAT_BANDS: Partial<Record<Role, BandInfo>> = {
  blue: { asset: 'blue', label: 'B2 Blue', nm: 482, res: '30 m' },
  green: { asset: 'green', label: 'B3 Green', nm: 561, res: '30 m' },
  red: { asset: 'red', label: 'B4 Red', nm: 655, res: '30 m' },
  nir: { asset: 'nir08', label: 'B5 NIR', nm: 865, res: '30 m' },
  swir1: { asset: 'swir16', label: 'B6 SWIR1', nm: 1609, res: '30 m' },
  swir2: { asset: 'swir22', label: 'B7 SWIR2', nm: 2201, res: '30 m' },
};

export function sensorOf(item: ImageryItem): SensorKind {
  if (item.collection === 'sentinel-2-l2a') return 's2';
  if (item.collection === 'landsat-c2-l2') return 'landsat';
  if (item.collection === 'sentinel-1-rtc') return 's1';
  return 'other';
}

export function bandsFor(item: ImageryItem): Partial<Record<Role, BandInfo>> {
  const k = sensorOf(item);
  return k === 's2' ? S2_BANDS : k === 'landsat' ? LANDSAT_BANDS : {};
}

const s2Offset = (item: ImageryItem) => {
  const b = parseFloat(item.baseline ?? '');
  // PC items normally carry s2:processing_baseline; if missing, use the acquisition date (baseline 04.00 from 25 Jan 2022)
  if (Number.isFinite(b)) return b >= 4 ? 1000 : 0;
  return item.datetime >= '2022-01-25' ? 1000 : 0;
};

/** Expression for surface reflectance of a role, or null when the sensor has no such band. */
export function refl(item: ImageryItem, role: Role): string | null {
  const k = sensorOf(item);
  if (k === 's2') {
    const off = s2Offset(item);
    const a = S2_BANDS[role].asset;
    return off ? `((${a}-${off})/10000)` : `(${a}/10000)`;
  }
  if (k === 'landsat') {
    const b = LANDSAT_BANDS[role];
    return b ? b.asset : null;
  }
  return null;
}

// ---------------------------------------------------------------- index catalogue

export type IndexGroup = 'Vegetation' | 'Water & flood' | 'Burned area' | 'Urban & surface' | 'SAR';

export interface IndexDef {
  id: string;
  name: string;
  group: IndexGroup;
  purpose: string;
  formula: string;
  roles: Role[];
  sensors: SensorKind[];
  build: (b: Record<string, string>) => string;
  range: [number, number];
  colormap: string;
  legend: string;
  caveat: string;
  reference?: string;
}

const nd = (a: string, b: string) => `((${a}-${b})/(${a}+${b}))`;

export const INDICES: IndexDef[] = [
  {
    id: 'ndvi', name: 'NDVI', group: 'Vegetation', purpose: 'Vegetation greenness / vigour',
    formula: 'NDVI = (NIR − Red) / (NIR + Red)', roles: ['nir', 'red'], sensors: ['s2', 'landsat'],
    build: (b) => nd(b.nir, b.red), range: [-0.2, 0.9], colormap: 'rdylgn',
    legend: 'Low (red/brown) = bare soil, water, built-up · medium (yellow) = sparse vegetation · high (green) = dense healthy vegetation',
    caveat: 'Saturates over dense canopy; sensitive to soil background, clouds and haze.', reference: 'Rouse et al. (1974)',
  },
  {
    id: 'evi', name: 'EVI', group: 'Vegetation', purpose: 'Vegetation index less prone to saturation and atmosphere',
    formula: 'EVI = 2.5 × (NIR − Red) / (NIR + 6 × Red − 7.5 × Blue + 1)', roles: ['nir', 'red', 'blue'], sensors: ['s2', 'landsat'],
    build: (b) => `(2.5*(${b.nir}-${b.red})/(${b.nir}+6*${b.red}-7.5*${b.blue}+1))`, range: [-0.2, 0.9], colormap: 'rdylgn',
    legend: 'Higher = more green vegetation', caveat: 'Requires surface reflectance (0–1); unstable over bright clouds/snow.', reference: 'Huete et al. (2002)',
  },
  {
    id: 'savi', name: 'SAVI', group: 'Vegetation', purpose: 'Vegetation index with soil-brightness correction (L = 0.5)',
    formula: 'SAVI = ((NIR − Red) / (NIR + Red + L)) × (1 + L), L = 0.5', roles: ['nir', 'red'], sensors: ['s2', 'landsat'],
    build: (b) => `(((${b.nir}-${b.red})/(${b.nir}+${b.red}+0.5))*1.5)`, range: [-0.2, 0.9], colormap: 'rdylgn',
    legend: 'Higher = more vegetation', caveat: 'L = 0.5 is a general-purpose value; low-cover areas may need a different L.', reference: 'Huete (1988)',
  },
  {
    id: 'ndre', name: 'NDRE', group: 'Vegetation', purpose: 'Canopy chlorophyll / nitrogen status (red edge)',
    formula: 'NDRE = (NIR(B8A) − RedEdge(B5)) / (NIR(B8A) + RedEdge(B5))', roles: ['nirn', 're1'], sensors: ['s2'],
    build: (b) => nd(b.nirn, b.re1), range: [-0.1, 0.6], colormap: 'rdylgn',
    legend: 'Higher = more chlorophyll', caveat: 'Sentinel-2 only (Landsat has no red-edge bands); 20 m bands.',
  },
  {
    id: 'ndwi', name: 'NDWI (McFeeters)', group: 'Water & flood', purpose: 'Open water',
    formula: 'NDWI = (Green − NIR) / (Green + NIR)', roles: ['green', 'nir'], sensors: ['s2', 'landsat'],
    build: (b) => nd(b.green, b.nir), range: [-0.6, 0.6], colormap: 'rdbu',
    legend: 'Blue = higher values (water-like) · red = lower values (vegetation / soil). The water threshold is user-set.',
    caveat: 'Positive values are NOT automatically water: built-up surfaces and shadows can also be positive.', reference: 'McFeeters (1996)',
  },
  {
    id: 'mndwi', name: 'MNDWI', group: 'Water & flood', purpose: 'Open water, better separation from built-up',
    formula: 'MNDWI = (Green − SWIR1) / (Green + SWIR1)', roles: ['green', 'swir1'], sensors: ['s2', 'landsat'],
    build: (b) => nd(b.green, b.swir1), range: [-0.6, 0.6], colormap: 'rdbu',
    legend: 'Blue = higher values (water-like). Threshold is user-set.', caveat: 'SWIR1 is 20 m on Sentinel-2 (resampled). Cloud shadow can mimic water.', reference: 'Xu (2006)',
  },
  {
    id: 'awei', name: 'AWEI (nsh)', group: 'Water & flood', purpose: 'Automated water extraction (no-shadow variant)',
    formula: 'AWEInsh = 4 × (Green − SWIR1) − (0.25 × NIR + 2.75 × SWIR2)', roles: ['green', 'swir1', 'nir', 'swir2'], sensors: ['s2', 'landsat'],
    build: (b) => `(4*(${b.green}-${b.swir1})-(0.25*${b.nir}+2.75*${b.swir2}))`, range: [-1.5, 0.5], colormap: 'rdbu',
    legend: 'Higher = more water-like; 0 is the published starting threshold', caveat: 'Designed for Landsat TM; thresholds vary by scene.', reference: 'Feyisa et al. (2014)',
  },
  {
    id: 'nbr', name: 'NBR', group: 'Burned area', purpose: 'Burn severity (use dNBR between two dates)',
    formula: 'NBR = (NIR − SWIR2) / (NIR + SWIR2)', roles: ['nir', 'swir2'], sensors: ['s2', 'landsat'],
    build: (b) => nd(b.nir, b.swir2), range: [-0.5, 0.9], colormap: 'rdylgn',
    legend: 'Low = burned / bare · high = healthy vegetation. For fire severity compare pre and post (dNBR = NBR_pre − NBR_post) in Change detection.',
    caveat: 'Single-date NBR does not prove burning.', reference: 'Key & Benson (2006), FIREMON',
  },
  {
    id: 'ndbi', name: 'NDBI', group: 'Urban & surface', purpose: 'Built-up surfaces',
    formula: 'NDBI = (SWIR1 − NIR) / (SWIR1 + NIR)', roles: ['swir1', 'nir'], sensors: ['s2', 'landsat'],
    build: (b) => nd(b.swir1, b.nir), range: [-0.5, 0.5], colormap: 'rdbu_r',
    legend: 'Red = higher (built-up / bare) · blue = lower (vegetation, water)', caveat: 'Bare soil and dry vegetation also score high.', reference: 'Zha et al. (2003)',
  },
  {
    id: 'bsi', name: 'BSI', group: 'Urban & surface', purpose: 'Bare soil',
    formula: 'BSI = ((SWIR1 + Red) − (NIR + Blue)) / ((SWIR1 + Red) + (NIR + Blue))', roles: ['swir1', 'red', 'nir', 'blue'], sensors: ['s2', 'landsat'],
    build: (b) => `(((${b.swir1}+${b.red})-(${b.nir}+${b.blue}))/((${b.swir1}+${b.red})+(${b.nir}+${b.blue})))`, range: [-0.5, 0.5], colormap: 'brbg_r',
    legend: 'Brown = higher (bare soil) · green = lower (vegetation)', caveat: 'Confused with built-up areas.',
  },
  {
    id: 'sar_vv_db', name: 'SAR VV backscatter (dB)', group: 'SAR', purpose: 'Radar backscatter for water / change (Sentinel-1 only)',
    formula: 'σ⁰dB = 10 × log10(γ⁰ VV)', roles: [], sensors: ['s1'],
    build: () => '(10*log10(vv))', range: [-25, 0], colormap: 'greys_r',
    legend: 'Dark = low backscatter (smooth water, some tarmac, radar shadow) · bright = rough / built-up / vegetation',
    caveat: 'Optical indices must not be applied to SAR. Wind-roughened water and wet snow complicate thresholds.',
  },
];

export function indexAvailability(item: ImageryItem, def: IndexDef): { ok: boolean; why?: string } {
  const k = sensorOf(item);
  if (!def.sensors.includes(k)) return { ok: false, why: `Not valid for ${item.collectionLabel}` };
  if (!item.tilejson && item.source !== 'planetary-computer') return { ok: false, why: 'Scene not from Planetary Computer — no band access' };
  const bands = bandsFor(item);
  const missing = def.roles.filter((r) => !bands[r]);
  if (missing.length) return { ok: false, why: `Missing bands: ${missing.join(', ')}` };
  return { ok: true };
}

export function indexExpression(item: ImageryItem, def: IndexDef): string {
  const b: Record<string, string> = {};
  for (const r of def.roles) b[r] = refl(item, r)!;
  return def.build(b);
}

// ---------------------------------------------------------------- composites

export interface CompositeDef {
  id: string;
  name: string;
  rgb: [Role, Role, Role];
  use: string;
}

export const COMPOSITES: CompositeDef[] = [
  { id: 'true', name: 'True colour', rgb: ['red', 'green', 'blue'], use: 'As the eye sees it' },
  { id: 'cir', name: 'False colour infrared (NIR / Red / Green)', rgb: ['nir', 'red', 'green'], use: 'Vegetation appears red' },
  { id: 'agri', name: 'Agriculture (SWIR1 / NIR / Blue)', rgb: ['swir1', 'nir', 'blue'], use: 'Crop vigour; healthy crops bright green' },
  { id: 'water', name: 'Water / wetland (NIR / SWIR1 / Red)', rgb: ['nir', 'swir1', 'red'], use: 'Land–water boundaries; water appears dark blue/black' },
  { id: 'flood', name: 'Flood analysis (SWIR2 / NIR / Red)', rgb: ['swir2', 'nir', 'red'], use: 'Water very dark; wet soil darker than dry soil' },
  { id: 'urban', name: 'Urban (SWIR2 / SWIR1 / Red)', rgb: ['swir2', 'swir1', 'red'], use: 'Built-up surfaces stand out from vegetation' },
  { id: 'swir2', name: 'SWIR burned area (SWIR2 / NIR / Red)', rgb: ['swir2', 'nir', 'red'], use: 'Fresh burn scars appear dark red/brown' },
  { id: 'swir1nirg', name: 'SWIR1 / NIR / Green', rgb: ['swir1', 'nir', 'green'], use: 'Moisture differences of soil and vegetation' },
];

export interface StretchOpts {
  min: number; // reflectance
  max: number; // reflectance
  gamma: number;
  contrast: number; // sigmoidal contrast, 0 = off
  saturation: number;
}

export const DEFAULT_STRETCH: StretchOpts = { min: 0, max: 0.3, gamma: 1.2, contrast: 0, saturation: 1 };

function base(item: ImageryItem) {
  return `collection=${encodeURIComponent(item.collection)}&item=${encodeURIComponent(item.id)}`;
}

function nodataParam(item: ImageryItem) {
  return sensorOf(item) === 's1' ? '' : '&nodata=0';
}

export function compositeAvailability(item: ImageryItem, rgb: Role[]): { ok: boolean; why?: string } {
  const k = sensorOf(item);
  if (k !== 's2' && k !== 'landsat') return { ok: false, why: 'Multispectral composites need Sentinel-2 or Landsat bands' };
  if (item.source !== 'planetary-computer') return { ok: false, why: 'Scene not from Planetary Computer — no band access' };
  const bands = bandsFor(item);
  const missing = rgb.filter((r) => !bands[r]);
  return missing.length ? { ok: false, why: `Missing bands: ${missing.join(', ')}` } : { ok: true };
}

/** Tile URL template for an RGB band combination built from the original bands. */
export function compositeTileUrl(item: ImageryItem, rgb: [Role, Role, Role], st: StretchOpts): string {
  const k = sensorOf(item);
  const bands = bandsFor(item);
  const assets = rgb.map((r) => `assets=${bands[r]!.asset}`).join('&');
  // translate the reflectance stretch into the asset's native units
  let lo = st.min, hi = st.max, extra = '';
  if (k === 's2') {
    const off = s2Offset(item);
    lo = st.min * 10000 + off;
    hi = st.max * 10000 + off;
  } else extra = '&unscale=true';
  const rescale = [0, 1, 2].map(() => `rescale=${lo.toFixed(4)},${hi.toFixed(4)}`).join('&');
  const cf = [`Gamma RGB ${st.gamma.toFixed(2)}`, st.contrast > 0 ? `Sigmoidal RGB ${st.contrast.toFixed(1)} 0.5` : '', st.saturation !== 1 ? `Saturation ${st.saturation.toFixed(2)}` : '']
    .filter(Boolean)
    .join(' ');
  return `${PC_DATA}/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x.png?${base(item)}&${assets}&${rescale}${nodataParam(item)}${extra}&color_formula=${encodeURIComponent(cf)}`;
}

const extraFor = (item: ImageryItem) => (sensorOf(item) === 'landsat' ? '&unscale=true' : '');

/** Tile URL template for a continuous index rendered with a colour ramp. */
export function indexTileUrl(item: ImageryItem, expression: string, range: [number, number], colormap: string): string {
  return `${PC_DATA}/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x.png?${base(item)}&expression=${encodeURIComponent(expression)}&asset_as_band=true&rescale=${range[0]},${range[1]}&colormap_name=${encodeURIComponent(colormap)}${nodataParam(item)}${extraFor(item)}`;
}

/** Binary mask (expression above / below threshold) rendered as one colour, transparent elsewhere. */
export function maskTileUrl(item: ImageryItem, expression: string, threshold: number, below: boolean, rgba: [number, number, number, number]): string {
  const cond = below ? `(${expression})<${threshold}` : `(${expression})>${threshold}`;
  const expr = `where(${cond},1,0)`;
  const cmap = { '0': [0, 0, 0, 0], '255': rgba };
  return `${PC_DATA}/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x.png?${base(item)}&expression=${encodeURIComponent(expr)}&asset_as_band=true&rescale=0,1&colormap=${encodeURIComponent(JSON.stringify(cmap))}${nodataParam(item)}${extraFor(item)}`;
}

/** Grey-scale (single band) tile of an expression, for pixel-level comparison in the browser. */
export function greyTileUrl(item: ImageryItem, expression: string, range: [number, number], z: number, x: number, y: number) {
  return `${PC_DATA}/item/tiles/WebMercatorQuad/${z}/${x}/${y}@1x.png?${base(item)}&expression=${encodeURIComponent(expression)}&asset_as_band=true&rescale=${range[0]},${range[1]}${nodataParam(item)}${extraFor(item)}`;
}

// ---------------------------------------------------------------- statistics

export interface BandStats {
  min: number;
  max: number;
  mean: number;
  std?: number;
  count?: number;
  validPercent?: number;
  validPixels?: number;
  p2?: number;
  p98?: number;
  histogram?: [number[], number[]];
}

function findStats(o: any): any | null {
  if (!o || typeof o !== 'object') return null;
  if (typeof o.mean === 'number' && typeof o.min === 'number') return o;
  for (const v of Object.values(o)) {
    const r = findStats(v);
    if (r) return r;
  }
  return null;
}

/** Zonal statistics of an expression inside the AOI, computed server-side from the original bands. */
export async function aoiStatistics(
  item: ImageryItem,
  expression: string,
  aoi: GeoJSON.Polygon,
  opts: { histogramRange?: [number, number]; bins?: number; signal?: AbortSignal } = {},
): Promise<BandStats> {
  const params = [
    base(item),
    `expression=${encodeURIComponent(expression)}`,
    'asset_as_band=true',
    'max_size=1024',
    'p=2',
    'p=98',
    `histogram_bins=${opts.bins ?? 24}`,
    opts.histogramRange ? `histogram_range=${opts.histogramRange[0]},${opts.histogramRange[1]}` : '',
  ]
    .filter(Boolean)
    .join('&') + nodataParam(item) + extraFor(item);
  const feature = { type: 'Feature', properties: {}, geometry: aoi };
  const url = `${PC_DATA}/item/statistics?${params}`;
  const post = (body: unknown) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: opts.signal });
  let r = await post(feature);
  if (r.status === 422) r = await post({ geojson: feature }); // older/newer API body shapes
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Statistics HTTP ${r.status}${txt ? ` — ${txt.slice(0, 160)}` : ''}`);
  }
  const s = findStats(await r.json());
  if (!s) throw new Error('No statistics in response (AOI may be outside the scene)');
  return {
    min: s.min,
    max: s.max,
    mean: s.mean,
    std: s.std,
    count: s.count,
    validPercent: s.valid_percent,
    validPixels: s.valid_pixels,
    p2: s.percentile_2 ?? s.percentile_2_0,
    p98: s.percentile_98 ?? s.percentile_98_0,
    histogram: Array.isArray(s.histogram) ? s.histogram : undefined,
  };
}

/** Sentinel-2 SCL classes 3 (cloud shadow), 8–9 (cloud), 10 (thin cirrus) → 1, else 0. */
export const S2_CLOUD_EXPR = 'where((SCL==3)|(SCL==8)|(SCL==9)|(SCL==10),1,0)';
export const S2_CLEAR_EXPR = 'where((SCL==3)|(SCL==8)|(SCL==9)|(SCL==10)|(SCL==0)|(SCL==1),0,1)';

export interface IndexSummary {
  stats: BandStats;
  clearMean: number | null; // mean over cloud-free pixels (Sentinel-2 SCL), when computable
  cloudFraction: number | null;
}

/** Index statistics; for Sentinel-2 also the cloud/shadow fraction and the clear-sky mean (E[idx·clear] / E[clear]). */
export async function indexSummary(item: ImageryItem, expression: string, aoi: GeoJSON.Polygon, range: [number, number], signal?: AbortSignal): Promise<IndexSummary> {
  const stats = await aoiStatistics(item, expression, aoi, { histogramRange: range, signal });
  if (sensorOf(item) !== 's2') return { stats, clearMean: null, cloudFraction: null };
  try {
    const [cl, prod] = await Promise.all([
      aoiStatistics(item, S2_CLEAR_EXPR, aoi, { signal }),
      aoiStatistics(item, `(${expression})*${S2_CLEAR_EXPR}`, aoi, { signal }),
    ]);
    const clearMean = cl.mean > 0 ? prod.mean / cl.mean : null;
    return { stats, clearMean, cloudFraction: 1 - cl.mean };
  } catch {
    return { stats, clearMean: null, cloudFraction: null };
  }
}

// ---------------------------------------------------------------- SAR water

export const SAR_WATER_DEFAULT_DB = -18;

export function sarDbExpression(pol: 'vv' | 'vh' = 'vv') {
  return `(10*log10(${pol}))`;
}

// ---------------------------------------------------------------- colour ramps (titiler colormap names)

export const COLORMAPS = ['rdylgn', 'rdbu', 'rdbu_r', 'brbg', 'brbg_r', 'viridis', 'magma', 'blues', 'ylgnbu', 'greys_r', 'spectral'];

const RAMP_STOPS: Record<string, string[]> = {
  rdylgn: ['#a50026', '#f46d43', '#fee08b', '#d9ef8b', '#66bd63', '#006837'],
  rdbu: ['#67001f', '#d6604d', '#f7f7f7', '#4393c3', '#053061'],
  rdbu_r: ['#053061', '#4393c3', '#f7f7f7', '#d6604d', '#67001f'],
  brbg: ['#543005', '#bf812d', '#f5f5f5', '#35978f', '#003c30'],
  brbg_r: ['#003c30', '#35978f', '#f5f5f5', '#bf812d', '#543005'],
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  magma: ['#000004', '#51127c', '#b73779', '#fc8961', '#fcfdbf'],
  blues: ['#f7fbff', '#9ecae1', '#4292c6', '#08519c', '#08306b'],
  ylgnbu: ['#ffffd9', '#7fcdbb', '#1d91c0', '#225ea8', '#081d58'],
  greys_r: ['#000000', '#555555', '#aaaaaa', '#ffffff'],
  spectral: ['#9e0142', '#f46d43', '#fee08b', '#abdda4', '#3288bd', '#5e4fa2'],
};

/** CSS gradient approximating a titiler colormap, for legends. */
export const rampCss = (name: string) => `linear-gradient(90deg, ${(RAMP_STOPS[name] ?? RAMP_STOPS.viridis).join(', ')})`;
