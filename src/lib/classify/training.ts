// Training / reference samples from GeoJSON.
//
// Accepted: FeatureCollection of Point / MultiPoint / Polygon / MultiPolygon features with a class in
// properties.class (or .label / .lc / .landcover / .type). The class can be an id (1–9) or a name in
// English or Thai. Optional properties.split = "train" | "validation" fixes which side a feature is on.
// Every feature becomes its own spatial group (points are additionally grouped by ~1 km blocks) so that
// neighbouring pixels of one feature never end up in both training and validation.
import { LC } from './types';
import { blockOf } from './accuracy';
import type { Grid } from '../change';
import { pixelAt, pixelCenter, pointInPolygon } from './grid';

const NAMES: [RegExp, LC][] = [
  [/^(1|open ?water|water|น้ำ|แหล่งน้ำ|แหล่งน้ำเปิด)$/i, LC.Water],
  [/^(3|dense ?veg(etation)?|forest|ป่า|ป่าทึบ|พืชพรรณหนาแน่น)$/i, LC.DenseVegetation],
  [/^(2|veg(etation)?|grass(land)?|shrub|พืช|พืชพรรณ|ทุ่งหญ้า)$/i, LC.Vegetation],
  [/^(4|agri(culture)?(al)?( land)?|crop(land)?|เกษตร|พื้นที่เกษตร|นา|ไร่)$/i, LC.Agriculture],
  [/^(5|bare( ?soil)?|soil|ดิน|ดินเปล่า)$/i, LC.BareSoil],
  [/^(6|built(-| )?up( area)?|urban|building|สิ่งปลูกสร้าง|เมือง|ชุมชน)$/i, LC.BuiltUp],
  [/^(7|wetland|marsh|swamp|ชุ่มน้ำ|พื้นที่ชุ่มน้ำ|บึง)$/i, LC.Wetland],
  [/^(8|cloud|เมฆ)$/i, LC.Cloud],
  [/^(9|cloud ?shadow|shadow|เงาเมฆ)$/i, LC.CloudShadow],
];

export function parseClass(v: unknown): LC | null {
  if (v == null) return null;
  const s = String(v).trim();
  for (const [re, c] of NAMES) if (re.test(s)) return c;
  return null;
}

export interface RefFeature {
  cls: LC;
  geometry: GeoJSON.Point | GeoJSON.Polygon;
  group: string;
  split?: 'train' | 'validation';
}

export interface ParsedSamples {
  features: RefFeature[];
  skipped: { index: number; reason: string }[];
  perClass: Record<number, number>;
}

export function parseSamples(json: any): ParsedSamples {
  const feats: any[] = json?.type === 'FeatureCollection' ? json.features : json?.type === 'Feature' ? [json] : [];
  if (!feats.length) throw new Error('GeoJSON has no features');
  const out: RefFeature[] = [];
  const skipped: { index: number; reason: string }[] = [];
  const perClass: Record<number, number> = {};
  feats.forEach((f, i) => {
    const p = f?.properties ?? {};
    const raw = p.class ?? p.label ?? p.lc ?? p.landcover ?? p.type ?? p.Class ?? p.CLASS;
    const cls = parseClass(raw);
    if (cls == null) return skipped.push({ index: i, reason: raw == null ? 'no class property' : `unknown class "${raw}"` });
    const split = /^val/i.test(String(p.split ?? '')) ? 'validation' : /^train/i.test(String(p.split ?? '')) ? 'train' : undefined;
    const g = f?.geometry;
    const add = (geometry: GeoJSON.Point | GeoJSON.Polygon, k: number) => {
      out.push({ cls, geometry, group: geometry.type === 'Point' ? blockOf(geometry.coordinates[0], geometry.coordinates[1]) : `f${i}_${k}`, split });
      perClass[cls] = (perClass[cls] ?? 0) + 1;
    };
    if (g?.type === 'Point') add(g, 0);
    else if (g?.type === 'MultiPoint') g.coordinates.forEach((c: number[], k: number) => add({ type: 'Point', coordinates: c }, k));
    else if (g?.type === 'Polygon') add(g, 0);
    else if (g?.type === 'MultiPolygon') g.coordinates.forEach((c: number[][][], k: number) => add({ type: 'Polygon', coordinates: c }, k));
    else skipped.push({ index: i, reason: `unsupported geometry ${g?.type ?? 'none'}` });
  });
  return { features: out, skipped, perClass };
}

export interface PixelSample {
  p: number;
  cls: LC;
  group: string;
  split?: 'train' | 'validation';
}

/** Grid pixels covered by the reference features (polygons: pixel centres inside, capped per feature). */
export function samplePixels(g: Grid, feats: RefFeature[], maxPerPolygon = 150): PixelSample[] {
  const out: PixelSample[] = [];
  for (const f of feats) {
    if (f.geometry.type === 'Point') {
      const p = pixelAt(g, f.geometry.coordinates[0], f.geometry.coordinates[1]);
      if (p >= 0) out.push({ p, cls: f.cls, group: f.group, split: f.split });
      continue;
    }
    const ring = f.geometry.coordinates[0];
    const xs = ring.map((c) => c[0]), ys = ring.map((c) => c[1]);
    const a = pixelAt(g, Math.min(...xs), Math.max(...ys)), b = pixelAt(g, Math.max(...xs), Math.min(...ys));
    // clamp the polygon's bounding box to the grid
    const r0 = a >= 0 ? Math.floor(a / g.width) : 0, c0 = a >= 0 ? a % g.width : 0;
    const r1 = b >= 0 ? Math.floor(b / g.width) : g.height - 1, c1 = b >= 0 ? b % g.width : g.width - 1;
    const inside: number[] = [];
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const [lon, lat] = pixelCenter(g, r, c);
        if (pointInPolygon(lon, lat, f.geometry)) inside.push(r * g.width + c);
      }
    const step = Math.max(1, Math.ceil(inside.length / maxPerPolygon));
    for (let k = 0; k < inside.length; k += step) out.push({ p: inside[k], cls: f.cls, group: f.group, split: f.split });
  }
  return out;
}
