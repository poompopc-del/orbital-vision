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
 * Frame for a border. `share` 0.5 centres the border line; sliding toward 0 moves the frame into
 * Thailand (toward `thai`), toward 1 into the neighbour (toward `neighbour`). The frame keeps its
 * size, so it reads as a pan; the shift is capped so the border line stays on screen near the edge.
 */
export function borderFocusRect(line: BBox4, neighbour: [number, number], thai: [number, number], share: number, padFrac = 0.25, minSizeDeg = 0.6): BBox4 {
  const [w, s, e, n] = line;
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const hw = Math.max(((e - w) / 2) * (1 + 2 * padFrac), minSizeDeg / 2);
  const hh = Math.max(((n - s) / 2) * (1 + 2 * padFrac), minSizeDeg / 2);
  const f = Math.min(1, Math.abs(share - 0.5) * 2); // 0 = centred … 1 = furthest
  const target = share >= 0.5 ? neighbour : thai;
  const dx = target[0] - cx, dy = target[1] - cy;
  const len = Math.hypot(dx, dy) || 1;
  // largest pan that still keeps part of the line inside: 90% of the frame half-size along each axis
  const ox = (dx / len) * f * hw * 0.9, oy = (dy / len) * f * hh * 0.9;
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
