// Terrain visualisation and DEM hydrology.
// Elevation source: Cesium World Terrain (requires a Cesium ion token). Heights are metres above the
// WGS84 ellipsoid — they differ from mean sea level by the local geoid undulation (tens of metres).
// Hydrology runs in the browser on a regular grid sampled from the terrain over a limited AOI:
// priority-flood sink filling (Barnes et al. 2014, with ε gradient), D8 flow direction (O'Callaghan & Mark 1984),
// flow accumulation and watershed delineation from a pour point.
import { Cesium } from './cesium';

export type ShadeMode = 'none' | 'elevation' | 'slope' | 'aspect' | 'contour' | 'elevation+contour';

function rampCanvas(stops: string[]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 1;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 256, 0);
  stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 1);
  return c;
}

export const ELEV_STOPS = ['#0b6b3a', '#5aa846', '#d9d36a', '#c08a3e', '#8b5a2b', '#ffffff'];
export const SLOPE_STOPS = ['#1a9850', '#91cf60', '#fee08b', '#fc8d59', '#d73027'];
export const ASPECT_STOPS = ['#e41a1c', '#ff7f00', '#ffff33', '#4daf4a', '#377eb8', '#984ea3', '#e41a1c'];

export interface ShadeOpts {
  minHeight: number;
  maxHeight: number;
  contourSpacing: number;
  contourColor?: string;
}

export function applyShading(viewer: Cesium.Viewer, mode: ShadeMode, o: ShadeOpts) {
  const globe = viewer.scene.globe;
  if (mode === 'none') {
    globe.material = undefined as any;
    return;
  }
  if (mode === 'elevation') {
    const m = Cesium.Material.fromType('ElevationRamp');
    m.uniforms.image = rampCanvas(ELEV_STOPS);
    m.uniforms.minimumHeight = o.minHeight;
    m.uniforms.maximumHeight = o.maxHeight;
    globe.material = m;
  } else if (mode === 'slope') {
    const m = Cesium.Material.fromType('SlopeRamp');
    m.uniforms.image = rampCanvas(SLOPE_STOPS);
    globe.material = m;
  } else if (mode === 'aspect') {
    const m = Cesium.Material.fromType('AspectRamp');
    m.uniforms.image = rampCanvas(ASPECT_STOPS);
    globe.material = m;
  } else if (mode === 'contour') {
    const m = Cesium.Material.fromType('ElevationContour');
    m.uniforms.width = 1.5;
    m.uniforms.spacing = o.contourSpacing;
    m.uniforms.color = Cesium.Color.fromCssColorString(o.contourColor ?? '#ffd34d');
    globe.material = m;
  } else {
    const m = new Cesium.Material({
      fabric: {
        type: 'ElevationColorContour',
        materials: {
          contourMaterial: { type: 'ElevationContour' },
          elevationRampMaterial: { type: 'ElevationRamp' },
        },
        components: {
          diffuse: '(1.0 - contourMaterial.alpha) * elevationRampMaterial.diffuse + contourMaterial.alpha * contourMaterial.diffuse',
          alpha: 'max(contourMaterial.alpha, elevationRampMaterial.alpha)',
        },
      },
      translucent: false,
    });
    const sub = (m as any).materials;
    sub.contourMaterial.uniforms.width = 1.5;
    sub.contourMaterial.uniforms.spacing = o.contourSpacing;
    sub.contourMaterial.uniforms.color = Cesium.Color.fromCssColorString(o.contourColor ?? '#1b1b1b');
    sub.elevationRampMaterial.uniforms.image = rampCanvas(ELEV_STOPS);
    sub.elevationRampMaterial.uniforms.minimumHeight = o.minHeight;
    sub.elevationRampMaterial.uniforms.maximumHeight = o.maxHeight;
    globe.material = m;
  }
}

/** Hillshade-style lighting from a fixed light (azimuth/elevation in degrees) above `center`. */
export function setHillshade(viewer: Cesium.Viewer, on: boolean, center?: [number, number], az = 315, el = 45) {
  const scene = viewer.scene;
  scene.globe.enableLighting = on;
  if (!on || !center) {
    scene.light = new Cesium.SunLight();
    return;
  }
  const origin = Cesium.Cartesian3.fromDegrees(center[0], center[1]);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const a = Cesium.Math.toRadians(az), e = Cesium.Math.toRadians(el);
  const toLight = new Cesium.Cartesian3(Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e));
  const world = Cesium.Matrix4.multiplyByPointAsVector(enu, toLight, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(world, world);
  Cesium.Cartesian3.negate(world, world);
  scene.light = new Cesium.DirectionalLight({ direction: world, intensity: 2.2 });
  (scene.globe as any).dynamicAtmosphereLighting = false;
}

export function setVerticalExaggeration(viewer: Cesium.Viewer, v: number) {
  const scene: any = viewer.scene;
  if ('verticalExaggeration' in scene) scene.verticalExaggeration = v;
  else scene.globe.terrainExaggeration = v;
}

export async function elevationAt(viewer: Cesium.Viewer, lon: number, lat: number): Promise<number | null> {
  const [c] = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [Cesium.Cartographic.fromDegrees(lon, lat)]);
  return c && Number.isFinite(c.height) ? c.height : null;
}

// ---------------------------------------------------------------- hydrology

export interface DemGrid {
  nx: number;
  ny: number;
  west: number;
  south: number;
  east: number;
  north: number;
  dx: number; // deg
  dy: number; // deg
  cellKm2: number;
  cellM: number; // approx cell size (m)
  z: Float64Array; // raw elevation
}

export async function sampleDem(viewer: Cesium.Viewer, bbox: [number, number, number, number], n: number, onProgress?: (p: number) => void): Promise<DemGrid> {
  const [w, s, e, nn] = bbox;
  const latMid = (s + nn) / 2;
  const kmX = (e - w) * 111.32 * Math.cos((latMid * Math.PI) / 180);
  const kmY = (nn - s) * 110.57;
  const nx = kmX >= kmY ? n : Math.max(8, Math.round((n * kmX) / kmY));
  const ny = kmY > kmX ? n : Math.max(8, Math.round((n * kmY) / kmX));
  const dx = (e - w) / nx, dy = (nn - s) / ny;
  const pts: Cesium.Cartographic[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pts.push(Cesium.Cartographic.fromDegrees(w + (i + 0.5) * dx, nn - (j + 0.5) * dy));
  const z = new Float64Array(nx * ny);
  const batch = 2000;
  for (let k = 0; k < pts.length; k += batch) {
    const part = pts.slice(k, k + batch);
    await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, part);
    part.forEach((c, i) => (z[k + i] = Number.isFinite(c.height) ? c.height : NaN));
    onProgress?.(Math.min(1, (k + batch) / pts.length));
  }
  const cellKm2 = (kmX / nx) * (kmY / ny);
  return { nx, ny, west: w, south: s, east: e, north: nn, dx, dy, cellKm2, cellM: Math.sqrt(cellKm2) * 1000, z };
}

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

export interface Hydro {
  filled: Float64Array;
  dir: Int8Array; // 0..7 neighbour index, -1 = flows off grid / outlet
  acc: Float64Array; // upstream cells incl. self
  raised: number; // cells raised by sink filling
}

/** Priority-flood with ε (Barnes et al. 2014) → D8 → accumulation. */
export function hydrology(g: DemGrid): Hydro {
  const { nx, ny } = g;
  const N = nx * ny;
  const filled = Float64Array.from(g.z);
  // replace NaN by neighbourhood minimum so the grid stays connected
  for (let p = 0; p < N; p++) if (Number.isNaN(filled[p])) filled[p] = Infinity;
  const done = new Uint8Array(N);
  // binary heap of [elev, idx]
  const hz: number[] = [], hi: number[] = [];
  const push = (z: number, i: number) => {
    hz.push(z); hi.push(i);
    let c = hz.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (hz[p] <= hz[c]) break;
      [hz[p], hz[c]] = [hz[c], hz[p]]; [hi[p], hi[c]] = [hi[c], hi[p]];
      c = p;
    }
  };
  const pop = (): [number, number] => {
    const top: [number, number] = [hz[0], hi[0]];
    const lz = hz.pop()!, li = hi.pop()!;
    if (hz.length) {
      hz[0] = lz; hi[0] = li;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1, r = l + 1;
        let m = c;
        if (l < hz.length && hz[l] < hz[m]) m = l;
        if (r < hz.length && hz[r] < hz[m]) m = r;
        if (m === c) break;
        [hz[m], hz[c]] = [hz[c], hz[m]]; [hi[m], hi[c]] = [hi[c], hi[m]];
        c = m;
      }
    }
    return top;
  };
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++)
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) {
        const p = j * nx + i;
        if (!Number.isFinite(filled[p])) filled[p] = 0;
        push(filled[p], p);
        done[p] = 1;
      }
  let raised = 0;
  const eps = 1e-3;
  while (hz.length) {
    const [z, p] = pop();
    const i = p % nx, j = (p / nx) | 0;
    for (let k = 0; k < 8; k++) {
      const ii = i + DX[k], jj = j + DY[k];
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const q = jj * nx + ii;
      if (done[q]) continue;
      done[q] = 1;
      if (!Number.isFinite(filled[q]) || filled[q] <= z) {
        if (Number.isFinite(g.z[q]) && filled[q] < z + eps) raised++;
        filled[q] = z + eps;
      }
      push(filled[q], q);
    }
  }
  // D8 steepest descent
  const dir = new Int8Array(N).fill(-1);
  const ddx = g.cellM;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const p = j * nx + i;
      let best = 0, bk = -1;
      for (let k = 0; k < 8; k++) {
        const ii = i + DX[k], jj = j + DY[k];
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const dist = k % 2 ? ddx * Math.SQRT2 : ddx;
        const s = (filled[p] - filled[jj * nx + ii]) / dist;
        if (s > best) {
          best = s;
          bk = k;
        }
      }
      // edge cells with no lower neighbour drain off the grid
      dir[p] = bk;
    }
  // accumulation: visit high → low
  const order = Array.from({ length: N }, (_, k) => k).sort((a, b) => filled[b] - filled[a]);
  const acc = new Float64Array(N).fill(1);
  for (const p of order) {
    const k = dir[p];
    if (k < 0) continue;
    const i = p % nx, j = (p / nx) | 0;
    acc[(j + DY[k]) * nx + i + DX[k]] += acc[p];
  }
  return { filled, dir, acc, raised };
}

export function cellOf(g: DemGrid, lon: number, lat: number): number | null {
  const i = Math.floor((lon - g.west) / g.dx);
  const j = Math.floor((g.north - lat) / g.dy);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return null;
  return j * g.nx + i;
}

/** Snap a pour point to the highest-accumulation cell within `r` cells. */
export function snapPour(g: DemGrid, h: Hydro, p: number, r = 3): number {
  const i0 = p % g.nx, j0 = (p / g.nx) | 0;
  let best = p;
  for (let j = j0 - r; j <= j0 + r; j++)
    for (let i = i0 - r; i <= i0 + r; i++) {
      if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
      const q = j * g.nx + i;
      if (h.acc[q] > h.acc[best]) best = q;
    }
  return best;
}

/** All cells draining to `outlet`. */
export function watershed(g: DemGrid, h: Hydro, outlet: number): Uint8Array {
  const m = new Uint8Array(g.nx * g.ny);
  const stack = [outlet];
  m[outlet] = 1;
  while (stack.length) {
    const p = stack.pop()!;
    const i = p % g.nx, j = (p / g.nx) | 0;
    for (let k = 0; k < 8; k++) {
      const ii = i - DX[k], jj = j - DY[k];
      if (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.ny) continue;
      const q = jj * g.nx + ii;
      if (!m[q] && h.dir[q] === k) {
        m[q] = 1;
        stack.push(q);
      }
    }
  }
  return m;
}

/** Image (data URL) of flow accumulation streams above `minCells`, and optional watershed mask. */
export function hydroImage(g: DemGrid, h: Hydro, minCells: number, ws?: Uint8Array | null): string {
  const c = document.createElement('canvas');
  c.width = g.nx;
  c.height = g.ny;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(g.nx, g.ny);
  const maxA = Math.log(Math.max(...h.acc));
  for (let p = 0; p < g.nx * g.ny; p++) {
    const q = p * 4;
    if (ws && ws[p]) {
      img.data[q] = 255; img.data[q + 1] = 170; img.data[q + 2] = 40; img.data[q + 3] = 85;
    }
    if (h.acc[p] >= minCells) {
      const t = Math.log(h.acc[p]) / maxA;
      img.data[q] = 20; img.data[q + 1] = Math.round(120 + 100 * t); img.data[q + 2] = 255; img.data[q + 3] = Math.round(150 + 105 * t);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/** GeoJSON export: stream segments + watershed cells (as a MultiPolygon of grid cells). */
export function hydroGeoJson(g: DemGrid, h: Hydro, minCells: number, ws: Uint8Array | null, meta: Record<string, unknown>) {
  const center = (p: number) => {
    const i = p % g.nx, j = (p / g.nx) | 0;
    return [g.west + (i + 0.5) * g.dx, g.north - (j + 0.5) * g.dy];
  };
  const lines: number[][][] = [];
  for (let p = 0; p < g.nx * g.ny; p++) {
    const k = h.dir[p];
    if (h.acc[p] < minCells || k < 0) continue;
    const i = p % g.nx, j = (p / g.nx) | 0;
    lines.push([center(p), center((j + DY[k]) * g.nx + i + DX[k])]);
  }
  const features: any[] = [
    { type: 'Feature', properties: { layer: 'dem_derived_streams', minUpstreamCells: minCells, ...meta }, geometry: { type: 'MultiLineString', coordinates: lines } },
  ];
  if (ws) {
    const polys: number[][][][] = [];
    let n = 0;
    for (let p = 0; p < g.nx * g.ny; p++) {
      if (!ws[p]) continue;
      n++;
      const i = p % g.nx, j = (p / g.nx) | 0;
      const w = g.west + i * g.dx, e = w + g.dx, nn = g.north - j * g.dy, s = nn - g.dy;
      polys.push([[[w, s], [e, s], [e, nn], [w, nn], [w, s]]]);
    }
    features.push({ type: 'Feature', properties: { layer: 'watershed', cells: n, areaKm2: +(n * g.cellKm2).toFixed(3), ...meta }, geometry: { type: 'MultiPolygon', coordinates: polys } });
  }
  return { type: 'FeatureCollection', features };
}
