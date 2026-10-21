// Map extents for surveillance mode: whole-Thailand overview and a regional border focus.
// Extents are plain lat/lon rectangles handed to the camera — nothing is reprojected, stretched or
// distorted to reach a target share; the share of the view outside Thailand is measured, not assumed.

export type BBox4 = [number, number, number, number]; // west, south, east, north

/** Thailand's extent (Natural Earth 1:50m) — used only when the outlines cannot be loaded. */
export const THAILAND_BBOX_FALLBACK: BBox4 = [97.34, 5.61, 105.64, 20.46];

export function bboxOfCoords(coords: number[][]): BBox4 {
  let w = 180, s = 90, e = -180, n = -90;
  for (const [x, y] of coords) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}
export function bboxOfGeometry(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): BBox4 {
  const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
  return bboxOfCoords(rings.flat());
}

/** Whole-country view with a margin so the neighbouring border zones are on screen too. */
export function overviewRect(th: BBox4, marginDeg = 1.0): BBox4 {
  return [th[0] - marginDeg, th[1] - marginDeg, th[2] + marginDeg, th[3] + marginDeg];
}

/**
 * Frame for a border: the border line's extent (padded) moved toward the neighbour.
 * `share` 0.5 centres the border line; higher values put more of the neighbour's side on screen
 * while the line (and the Thai side next to it) stays inside the frame.
 */
export function borderFocusRect(line: BBox4, towards: [number, number], share: number, padFrac = 0.25, minSizeDeg = 0.6): BBox4 {
  const [w, s, e, n] = line;
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const lw = (e - w) / 2, lh = (n - s) / 2;
  const f = Math.min(0.95, Math.abs(share - 0.5) * 2); // 0 = centred … 0.95 = strongest emphasis
  const sign = share >= 0.5 ? 1 : -1; // toward the neighbour, or toward Thailand
  // the frame grows with the emphasis so the far side gains room; the line always stays inside
  const grow = 1 + 1.5 * f;
  const hw = Math.max(lw * (1 + 2 * padFrac), minSizeDeg / 2) * grow;
  const hh = Math.max(lh * (1 + 2 * padFrac), minSizeDeg / 2) * grow;
  const dx = towards[0] - cx, dy = towards[1] - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ox = sign * (dx / len) * (hw - lw) * f, oy = sign * (dy / len) * (hh - lh) * f;
  return [cx + ox - hw, cy + oy - hh, cx + ox + hw, cy + oy + hh];
}

function inRing(x: number, y: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function inGeometry(x: number, y: number, g: GeoJSON.Polygon | GeoJSON.MultiPolygon) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.some((p) => inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h)));
}

/**
 * Measured share of a frame that lies outside the given country (on land or sea), by sampling a
 * grid weighted by cos(latitude) so each sample stands for a similar ground area.
 */
export function outsideShare(frame: BBox4, country: GeoJSON.Polygon | GeoJSON.MultiPolygon, steps = 40): number {
  const [w, s, e, n] = frame;
  let tot = 0, out = 0;
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < steps; j++) {
      const x = w + ((i + 0.5) / steps) * (e - w), y = s + ((j + 0.5) / steps) * (n - s);
      const wt = Math.cos((y * Math.PI) / 180);
      tot += wt;
      if (!inGeometry(x, y, country)) out += wt;
    }
  return tot ? out / tot : 0;
}

/** Centroid of a polygon's outer ring(s) by vertex mean — only used to know which way the neighbour lies. */
export function roughCentre(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): [number, number] {
  const b = bboxOfGeometry(g);
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}
