// Stricter clear-sky mask for multi-scene stacks. The scene's own mask (Sentinel-2 SCL) misses the
// soft edges of clouds and much of their shadow (often classed "dark area"), and on a stack every
// missed edge looks like vegetation that vanished for one date. So: grow cloud and shadow by a
// margin, and treat "dark" pixels as shadow when a cloud is near.

/** state codes per pixel: 0 no data · 2 dark (S2 SCL 2) · 3 shadow · 4 clear · 8 cloud */
export const DARK = 2, SHADOW = 3, CLEAR = 4, CLOUD = 8;

/** Square dilation of a 0/1 mask by r pixels (separable running window; O(W·H)). Pure. */
export function dilate(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
  if (r <= 0) return m.slice();
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let n = 0;
    const o = y * W;
    for (let x = 0; x < Math.min(W, r); x++) n += m[o + x];
    for (let x = 0; x < W; x++) {
      if (x + r < W) n += m[o + x + r];
      if (x - r - 1 >= 0) n -= m[o + x - r - 1];
      tmp[o + x] = n > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < W; x++) {
    let n = 0;
    for (let y = 0; y < Math.min(H, r); y++) n += tmp[y * W + x];
    for (let y = 0; y < H; y++) {
      if (y + r < H) n += tmp[(y + r) * W + x];
      if (y - r - 1 >= 0) n -= tmp[(y - r - 1) * W + x];
      out[y * W + x] = n > 0 ? 1 : 0;
    }
  }
  return out;
}

/**
 * Which pixels are safely clear (1) given the state codes. `edgeM` grows cloud and shadow;
 * dark pixels within `nearM` of a cloud count as shadow. Pure.
 */
export function clearMask(codes: ArrayLike<number>, W: number, H: number, pxM: number, opt: { edgeM?: number; nearM?: number } = {}): Uint8Array {
  const N = W * H;
  const edge = Math.round((opt.edgeM ?? 40) / pxM), near = Math.round((opt.nearM ?? 1000) / pxM);
  const code = (p: number) => Math.round(codes[p]);
  const cloud = new Uint8Array(N);
  for (let p = 0; p < N; p++) cloud[p] = code(p) === CLOUD ? 1 : 0;
  const nearCloud = dilate(cloud, W, H, near);
  const bad = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    const c = code(p);
    bad[p] = c === CLOUD || c === SHADOW || (c === DARK && nearCloud[p]) ? 1 : 0;
  }
  const grown = dilate(bad, W, H, edge);
  const out = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    const c = code(p);
    out[p] = !grown[p] && (c === CLEAR || c === DARK) ? 1 : 0;
  }
  return out;
}
