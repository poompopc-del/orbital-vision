// Land-border lines between Thailand and a neighbour, taken from Natural Earth 1:50m country polygons
// (vertices the two polygons share), and square monitoring tiles laid along them.
// Natural Earth borders are generalised (errors of hundreds of metres to kilometres) and are NOT
// the legal boundary — the tiles are a convenient way to cover the border zone, nothing more.
import { loadCountries, type Country } from './countries';
import { getBoundary } from './boundary';

export type Neighbour = 'KHM' | 'MYS' | 'MMR' | 'LAO';
export const NEIGHBOURS: { id: Neighbour; region: 'TH-KH' | 'TH-MY' | 'TH-MM' | 'TH-LA'; th: string; en: string }[] = [
  { id: 'KHM', region: 'TH-KH', th: 'กัมพูชา', en: 'Cambodia' },
  { id: 'MYS', region: 'TH-MY', th: 'มาเลเซีย', en: 'Malaysia' },
  { id: 'MMR', region: 'TH-MM', th: 'เมียนมา', en: 'Myanmar' },
  { id: 'LAO', region: 'TH-LA', th: 'ลาว', en: 'Laos' },
];

const rings = (c: Country): GeoJSON.Position[][] => (c.geometry.type === 'Polygon' ? [c.geometry.coordinates[0]] : c.geometry.coordinates.map((p) => p[0]));
const key = (p: GeoJSON.Position) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;

/** Which boundary is in use: an imported file (preferred) or Natural Earth. */
export async function boundarySource(): Promise<{ custom: boolean; name?: string; importedAt?: string }> {
  const b = await getBoundary();
  return b ? { custom: true, name: b.name, importedAt: b.importedAt } : { custom: false };
}

/** Polylines (lon/lat) of the land border with the neighbour — from the imported boundary file when
 *  there is one, otherwise from Natural Earth. */
export async function borderLines(n: Neighbour): Promise<[number, number][][]> {
  const b = await getBoundary();
  if (b?.lines[n]?.length) return stitch(b.lines[n]);
  return naturalEarthLines(n);
}

/** Join line pieces whose ends meet (within ~50 m) into continuous lines, longest first. */
export function stitch(parts: [number, number][][], tolDeg = 0.0005): [number, number][][] {
  const pool = parts.filter((p) => p.length > 1).map((p) => [...p]);
  const near = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < tolDeg && Math.abs(a[1] - b[1]) < tolDeg;
  const out: [number, number][][] = [];
  while (pool.length) {
    let cur = pool.shift()!;
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const q = pool[i];
        const h = cur[0], t = cur[cur.length - 1];
        if (near(t, q[0])) cur = [...cur, ...q.slice(1)];
        else if (near(t, q[q.length - 1])) cur = [...cur, ...[...q].reverse().slice(1)];
        else if (near(h, q[q.length - 1])) cur = [...q, ...cur.slice(1)];
        else if (near(h, q[0])) cur = [...[...q].reverse(), ...cur.slice(1)];
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    out.push(cur);
  }
  return out.sort((a, b) => b.length - a.length);
}

async function naturalEarthLines(n: Neighbour): Promise<[number, number][][]> {
  const all = await loadCountries();
  const th = all.find((c) => c.id === 'THA');
  const nb = all.find((c) => c.id === n);
  if (!th || !nb) throw new Error('Country outlines not found');
  // neighbour vertices in a 0.01° hash; a Thai vertex counts as "on the border" when a neighbour
  // vertex lies within ~200 m (tolerates tiny coordinate differences between the two polygons)
  const cells = new Map<string, GeoJSON.Position[]>();
  const ck = (x: number, y: number) => `${Math.floor(x * 100)},${Math.floor(y * 100)}`;
  rings(nb).forEach((r) => r.forEach((p) => {
    const k = ck(p[0], p[1]);
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(p);
  }));
  const near = (p: GeoJSON.Position) => {
    const cx = Math.floor(p[0] * 100), cy = Math.floor(p[1] * 100);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const q of cells.get(`${cx + i},${cy + j}`) ?? []) if (Math.abs(q[0] - p[0]) < 0.002 && Math.abs(q[1] - p[1]) < 0.002) return true;
    return false;
  };
  const set = { has: (k: string) => onBorder.get(k) ?? false };
  const onBorder = new Map<string, boolean>();
  rings(th).forEach((r) => r.forEach((p) => onBorder.set(key(p), near(p))));
  const lines: [number, number][][] = [];
  for (const r of rings(th)) {
    let cur: [number, number][] = [];
    // walk the ring twice so a run that wraps the start point stays in one piece
    const L = r.length - 1;
    let start = 0;
    while (start < L && set.has(key(r[start]))) start++;
    for (let k = 0; k <= L; k++) {
      const p = r[(start + k) % L];
      if (set.has(key(p))) cur.push([p[0], p[1]]);
      else {
        if (cur.length > 1) lines.push(cur);
        cur = [];
      }
    }
    if (cur.length > 1) lines.push(cur);
  }
  return lines;
}

const KM_LAT = 110.574;
const kmLon = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);
const dist = (a: [number, number], b: [number, number]) => Math.hypot((b[0] - a[0]) * kmLon((a[1] + b[1]) / 2), (b[1] - a[1]) * KM_LAT);

export interface Tile {
  id: string;
  n: number;
  center: [number, number];
  geometry: GeoJSON.Polygon;
}

function inRing(x: number, y: number, ring: GeoJSON.Position[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inside = (x: number, y: number, g: GeoJSON.Polygon | GeoJSON.MultiPolygon) =>
  (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).some((p) => inRing(x, y, p[0]));

export interface TileOpts {
  /** −1 … 1: −1 = tiles fully on the Thai side, 0 = centred on the line, 1 = fully on the neighbour's side */
  shift?: number;
  /** neighbour outline, used to tell which side of the line is the neighbour's */
  neighbour?: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  /** fallback when the outline cannot tell the side */
  neighbourCentre?: [number, number] | null;
}

/** Point at arc distance `d` (km) along a densified line, plus the local direction averaged over ±win km. */
function along(pts: [number, number][], cum: number[], d: number, win: number) {
  const at = (x: number): [number, number] => {
    x = Math.max(0, Math.min(cum[cum.length - 1], x));
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= x) lo = m;
      else hi = m;
    }
    const t = cum[hi] > cum[lo] ? (x - cum[lo]) / (cum[hi] - cum[lo]) : 0;
    return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t];
  };
  const p = at(d), a = at(d - win), b = at(d + win);
  return { p, a, b };
}

/**
 * Square tiles of `sizeKm` that together cover every point of the lines: walk along the line and,
 * wherever a point is not yet inside a tile, place a new one ahead of it. `shift` moves tiles
 * perpendicular to the (smoothed) line direction into Thailand (−) or the neighbour (+); the line
 * stays a little inside each tile (at full shift ~7% of the width) so coverage holds at every shift.
 */
export function tilesAlong(lines: [number, number][][], sizeKm: number, prefix: string, opts: TileOpts = {}): Tile[] {
  const out: Tile[] = [];
  const shift = Math.max(-1, Math.min(1, opts.shift ?? 0)) * 0.85;
  const half = sizeKm / 2;
  // a densified point counts as covered only with a margin of one step, so the line between
  // checked points cannot slip out through a corner
  const step = sizeKm / 25;
  const inTile = (t: Tile, q: [number, number]) => {
    const r = t.geometry.coordinates[0];
    const mx = step / kmLon(q[1]), my = step / KM_LAT;
    return q[0] >= r[0][0] + mx && q[0] <= r[1][0] - mx && q[1] >= r[0][1] + my && q[1] <= r[2][1] - my;
  };
  for (const raw of lines) {
    if (raw.length < 2) continue;
    // densify so no stretch longer than one step goes unchecked
    const pts: [number, number][] = [raw[0]];
    for (let i = 1; i < raw.length; i++) {
      const a = raw[i - 1], b = raw[i];
      const n = Math.max(1, Math.ceil(dist(a, b) / step));
      for (let k = 1; k <= n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i];
      let covered = false;
      for (let k = out.length - 1; k >= 0; k--) if (inTile(out[k], q)) { covered = true; break; } // newest first: almost always the hit
      if (covered) continue;
      // centre ahead of the uncovered point so the tile covers as much of the line as possible
      let placed: Tile | null = null;
      for (const ahead of [0.85 * half, 0.5 * half, 0]) {
        const { p, a, b } = along(pts, cum, cum[i] + ahead, half);
        let c: [number, number] = p;
        if (shift) {
          const kx = kmLon(p[1]);
          const ex = (b[0] - a[0]) * kx, ey = (b[1] - a[1]) * KM_LAT;
          const L = Math.hypot(ex, ey) || 1;
          let nx = -ey / L, ny = ex / L;
          if (opts.neighbour) {
            let vote = 0;
            for (const probe of [1.5, 4, 8]) {
              vote += Number(inside(p[0] + (nx * probe) / kx, p[1] + (ny * probe) / KM_LAT, opts.neighbour)) - Number(inside(p[0] - (nx * probe) / kx, p[1] - (ny * probe) / KM_LAT, opts.neighbour));
            }
            if (vote === 0 && opts.neighbourCentre) vote = Math.sign((opts.neighbourCentre[0] - p[0]) * kx * nx + (opts.neighbourCentre[1] - p[1]) * KM_LAT * ny);
            if (vote < 0) { nx = -nx; ny = -ny; }
          }
          c = [p[0] + (nx * shift * half) / kx, p[1] + (ny * shift * half) / KM_LAT];
        }
        const t = square(c, sizeKm, prefix, out.length + 1);
        if (inTile(t, q)) { placed = t; break; }
      }
      // last resort: centre on the uncovered point itself (always covers it)
      out.push(placed ?? square(q, sizeKm, prefix, out.length + 1));
    }
  }
  return out;
}

export function square(c: [number, number], sizeKm: number, prefix: string, n: number): Tile {
  const dy = sizeKm / 2 / KM_LAT, dx = sizeKm / 2 / kmLon(c[1]);
  const [x, y] = c;
  return {
    id: `${prefix}-${String(n).padStart(3, '0')}`,
    n,
    center: c,
    geometry: { type: 'Polygon', coordinates: [[[x - dx, y - dy], [x + dx, y - dy], [x + dx, y + dy], [x - dx, y + dy], [x - dx, y - dy]]] },
  };
}

export const lineLength = (lines: [number, number][][]) => lines.reduce((s, l) => s + l.slice(1).reduce((t, p, i) => t + dist(l[i], p), 0), 0);
