// Outline view of a change result: keeps only the border pixels of each change patch, so the
// imagery under a patch stays visible while comparing before/after. Works on the RGBA image the
// change analysis already produces (change classes are drawn with alpha ≥ 200; cloud / shadow /
// no-data hatching is lighter and is left out).

/** Border pixels of the opaque (alpha ≥ minAlpha) regions, in their own colour, fully opaque. Pure. */
export function outlineRgba(src: Uint8ClampedArray, W: number, H: number, minAlpha = 200): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && src[(y * W + x) * 4 + 3] >= minAlpha;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!on(x, y)) continue;
      // a border pixel has a 4-neighbour outside the region (or the image edge)
      if (on(x - 1, y) && on(x + 1, y) && on(x, y - 1) && on(x, y + 1)) continue;
      const i = (y * W + x) * 4;
      out[i] = src[i];
      out[i + 1] = src[i + 1];
      out[i + 2] = src[i + 2];
      out[i + 3] = 255;
    }
  return out;
}

/** Same as outlineRgba, for an image URL (browser only): returns a PNG data URL. */
export async function outlineDataUrl(url: string, minAlpha = 200): Promise<string> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((ok, bad) => {
    img.onload = () => ok();
    img.onerror = () => bad(new Error('image load failed'));
    img.src = url;
  });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  d.data.set(outlineRgba(d.data, c.width, c.height, minAlpha));
  ctx.putImageData(d, 0, 0);
  return c.toDataURL('image/png');
}
