// Image exports that include the real satellite picture:
//  • renderScene: true-colour (or SAR) image of a scene clipped to the AOI, from Planetary Computer tiles
//  • encodeGeoTiff: georeferenced RGBA GeoTIFF (EPSG:4326) written in the browser
//  • overlay / summary sheet helpers for change and flood results
//  • signed links to the original full-scene files (COG)
import { gridFor } from './change';
import { compositeTileUrl, DEFAULT_STRETCH, indexTileUrl, sarDbExpression, sensorOf } from './spectral';
import type { ImageryItem } from './stac';

export interface GeoCanvas {
  canvas: HTMLCanvasElement;
  west: number;
  south: number;
  east: number;
  north: number;
}

const tileY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const tileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;

export function bboxOf(g: GeoJSON.Polygon) {
  const xs = g.coordinates[0].map((c) => c[0]);
  const ys = g.coordinates[0].map((c) => c[1]);
  return { west: Math.min(...xs), east: Math.max(...xs), south: Math.min(...ys), north: Math.max(...ys) };
}

export function bboxPolygonOf(item: ImageryItem): GeoJSON.Polygon {
  const [w, s, e, n] = item.bbox;
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

/** Tile template used for downloads: true colour for optical, VV dB greyscale for Sentinel-1. */
export function displayTemplate(item: ImageryItem): string {
  return sensorOf(item) === 's1'
    ? indexTileUrl(item, sarDbExpression('vv'), [-25, 0], 'greys_r')
    : compositeTileUrl(item, ['red', 'green', 'blue'], DEFAULT_STRETCH);
}

async function tileBitmap(url: string, signal?: AbortSignal): Promise<ImageBitmap | null> {
  const r = await fetch(url, { signal });
  if (!r.ok) return null; // outside the scene footprint
  return createImageBitmap(await r.blob());
}

/** Real image of `item` over the polygon (pixels outside the polygon are transparent). */
export async function renderScene(
  item: ImageryItem,
  poly: GeoJSON.Polygon,
  opts: { maxPx?: number; template?: string; signal?: AbortSignal; onProgress?: (d: number, n: number) => void } = {},
): Promise<GeoCanvas> {
  const grid = gridFor(poly, opts.maxPx ?? 2048, 100);
  const tpl = opts.template ?? displayTemplate(item);
  const merc = document.createElement('canvas');
  merc.width = grid.width;
  merc.height = grid.height;
  const mctx = merc.getContext('2d')!;
  let done = 0, got = 0;
  const total = grid.nx * grid.ny;
  await Promise.all(
    Array.from({ length: total }, (_, k) => {
      const i = k % grid.nx, j = Math.floor(k / grid.nx);
      const url = tpl.replace('{z}', String(grid.z)).replace('{x}', String(grid.x0 + i)).replace('{y}', String(grid.y0 + j));
      return tileBitmap(url, opts.signal).then((b) => {
        if (b) {
          mctx.drawImage(b, i * 256, j * 256);
          got++;
        }
        opts.onProgress?.(++done, total);
      });
    }),
  );
  if (!got) throw new Error('The scene does not cover this area');
  const b = bboxOf(poly);
  const x0 = (tileX(b.west, grid.z) - grid.x0) * 256;
  const x1 = (tileX(b.east, grid.z) - grid.x0) * 256;
  const W = Math.max(1, Math.round(x1 - x0));
  const H = Math.max(1, Math.round((tileY(b.south, grid.z) - tileY(b.north, grid.z)) * 256));
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d')!;
  // web-mercator rows → rows linear in latitude (EPSG:4326 pixel grid)
  for (let r = 0; r < H; r++) {
    const lat = b.north - ((r + 0.5) / H) * (b.north - b.south);
    const sy = (tileY(lat, grid.z) - grid.y0) * 256;
    ctx.drawImage(merc, x0, sy, x1 - x0, 1, 0, r, W, 1);
  }
  clipToPolygon(ctx, poly, b, W, H);
  return { canvas: out, ...b };
}

function clipToPolygon(ctx: CanvasRenderingContext2D, poly: GeoJSON.Polygon, b: { west: number; east: number; south: number; north: number }, W: number, H: number) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.beginPath();
  poly.coordinates[0].forEach(([lon, lat], i) => {
    const x = ((lon - b.west) / (b.east - b.west)) * W;
    const y = ((b.north - lat) / (b.north - b.south)) * H;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Draw a lat/lon-linear overlay image (e.g. a change mask) onto a GeoCanvas copy. */
export async function withOverlay(base: GeoCanvas, overlayUrl: string, ob: { west: number; south: number; east: number; north: number }, poly?: GeoJSON.Polygon): Promise<GeoCanvas> {
  const c = document.createElement('canvas');
  c.width = base.canvas.width;
  c.height = base.canvas.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(base.canvas, 0, 0);
  const img = await loadImg(overlayUrl);
  const W = c.width, H = c.height;
  const dx = ((ob.west - base.west) / (base.east - base.west)) * W;
  const dw = ((ob.east - ob.west) / (base.east - base.west)) * W;
  const dy = ((base.north - ob.north) / (base.north - base.south)) * H;
  const dh = ((ob.north - ob.south) / (base.north - base.south)) * H;
  ctx.drawImage(img, dx, dy, dw, dh);
  if (poly) clipToPolygon(ctx, poly, base, W, H);
  return { ...base, canvas: c };
}

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('image load failed'));
    i.src = url;
  });
}

// ---------------------------------------------------------------- GeoTIFF writer (RGBA, EPSG:4326)

export function encodeGeoTiff(g: GeoCanvas): Blob {
  const w = g.canvas.width, h = g.canvas.height;
  const px = g.canvas.getContext('2d')!.getImageData(0, 0, w, h).data;
  type E = { tag: number; type: 3 | 4 | 12; values: number[] };
  const imgBytes = w * h * 4;
  const entries: E[] = [
    { tag: 256, type: 4, values: [w] },
    { tag: 257, type: 4, values: [h] },
    { tag: 258, type: 3, values: [8, 8, 8, 8] },
    { tag: 259, type: 3, values: [1] },
    { tag: 262, type: 3, values: [2] },
    { tag: 273, type: 4, values: [0] }, // patched below
    { tag: 277, type: 3, values: [4] },
    { tag: 278, type: 4, values: [h] },
    { tag: 279, type: 4, values: [imgBytes] },
    { tag: 284, type: 3, values: [1] },
    { tag: 338, type: 3, values: [2] }, // unassociated alpha
    { tag: 339, type: 3, values: [1, 1, 1, 1] },
    { tag: 33550, type: 12, values: [(g.east - g.west) / w, (g.north - g.south) / h, 0] },
    { tag: 33922, type: 12, values: [0, 0, 0, g.west, g.north, 0] },
    // GeoKeys: ModelType geographic, RasterType PixelIsArea, GeographicType WGS84 (4326), angular unit degree
    { tag: 34735, type: 3, values: [1, 1, 0, 4, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326, 2054, 0, 1, 9102] },
  ];
  const size = (t: number) => (t === 3 ? 2 : t === 4 ? 4 : 8);
  const ifdSize = 2 + entries.length * 12 + 4;
  let extra = 0;
  const extraOff = new Map<number, number>();
  for (const e of entries) {
    const n = e.values.length * size(e.type);
    if (n > 4) {
      extraOff.set(e.tag, 8 + ifdSize + extra);
      extra += n + (n % 2);
    }
  }
  const imgOff = 8 + ifdSize + extra;
  entries.find((e) => e.tag === 273)!.values = [imgOff];
  const buf = new ArrayBuffer(imgOff + imgBytes);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4949, true); // "II" little-endian
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  const write = (off: number, t: number, vals: number[]) =>
    vals.forEach((v, i) => {
      if (t === 3) dv.setUint16(off + i * 2, v, true);
      else if (t === 4) dv.setUint32(off + i * 4, v, true);
      else dv.setFloat64(off + i * 8, v, true);
    });
  entries.forEach((e, i) => {
    const p = 10 + i * 12;
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, e.values.length, true);
    const off = extraOff.get(e.tag);
    if (off !== undefined) {
      dv.setUint32(p + 8, off, true);
      write(off, e.type, e.values);
    } else write(p + 8, e.type, e.values);
  });
  dv.setUint32(10 + entries.length * 12, 0, true);
  new Uint8Array(buf, imgOff).set(px);
  return new Blob([buf], { type: 'image/tiff' });
}

export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export async function savePng(g: GeoCanvas, name: string) {
  const blob: Blob = await new Promise((r) => g.canvas.toBlob((b) => r(b!), 'image/png'));
  saveBlob(blob, name);
}

export const safeName = (s: string) => s.replace(/[^\w฀-๿-]+/g, '_').replace(/_+/g, '_').slice(0, 60);

// ---------------------------------------------------------------- summary sheet

export interface SheetPanel {
  img: GeoCanvas;
  caption: string;
}

/** Side-by-side sheet: panels with captions, legend and footer. Returns a PNG blob. */
export async function summarySheet(title: string, panels: SheetPanel[], legend: { color: string; label: string }[], footer: string[]): Promise<Blob> {
  const PW = 620, GAP = 16, PAD = 24;
  const scaled = panels.map((p) => {
    const k = Math.min(PW / p.img.canvas.width, 620 / p.img.canvas.height);
    return { ...p, w: Math.round(p.img.canvas.width * k), h: Math.round(p.img.canvas.height * k) };
  });
  const ph = Math.max(...scaled.map((s) => s.h));
  const W = PAD * 2 + scaled.reduce((a, s) => a + s.w, 0) + GAP * (scaled.length - 1);
  const legendRows = Math.ceil(legend.length / 3);
  const H = PAD + 34 + ph + 34 + legendRows * 22 + 12 + footer.length * 18 + PAD;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#111';
  ctx.font = '600 20px Inter, "Noto Sans Thai", sans-serif';
  ctx.fillText(title, PAD, PAD + 20);
  let x = PAD;
  const y = PAD + 34;
  for (const s of scaled) {
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(x, y, s.w, s.h);
    ctx.drawImage(s.img.canvas, x, y, s.w, s.h);
    ctx.strokeStyle = '#9ca3af';
    ctx.strokeRect(x + 0.5, y + 0.5, s.w - 1, s.h - 1);
    ctx.fillStyle = '#111';
    ctx.font = '14px Inter, "Noto Sans Thai", sans-serif';
    ctx.fillText(s.caption, x, y + ph + 22);
    x += s.w + GAP;
  }
  let ly = y + ph + 34 + 6;
  ctx.font = '13px Inter, "Noto Sans Thai", sans-serif';
  legend.forEach((l, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const lx = PAD + col * Math.floor((W - PAD * 2) / 3);
    const yy = ly + row * 22;
    ctx.fillStyle = l.color === 'rgba(0,0,0,0)' ? '#ffffff' : l.color;
    ctx.fillRect(lx, yy - 11, 14, 14);
    ctx.strokeStyle = '#6b7280';
    ctx.strokeRect(lx + 0.5, yy - 10.5, 13, 13);
    ctx.fillStyle = '#111';
    ctx.fillText(l.label, lx + 20, yy + 1);
  });
  ly += legendRows * 22 + 12;
  ctx.fillStyle = '#4b5563';
  ctx.font = '12px Inter, "Noto Sans Thai", sans-serif';
  footer.forEach((f, i) => ctx.fillText(f, PAD, ly + i * 18));
  return new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
}

// ---------------------------------------------------------------- original files

export const ORIGINAL_ASSETS: Record<string, { key: string; label: string }[]> = {
  's2': [
    { key: 'visual', label: 'True colour (TCI, 10 m)' },
    { key: 'B04', label: 'B4 Red 10 m' },
    { key: 'B03', label: 'B3 Green 10 m' },
    { key: 'B02', label: 'B2 Blue 10 m' },
    { key: 'B08', label: 'B8 NIR 10 m' },
    { key: 'B11', label: 'B11 SWIR1 20 m' },
    { key: 'B12', label: 'B12 SWIR2 20 m' },
    { key: 'SCL', label: 'Scene classification 20 m' },
  ],
  landsat: [
    { key: 'red', label: 'Red 30 m' },
    { key: 'green', label: 'Green 30 m' },
    { key: 'blue', label: 'Blue 30 m' },
    { key: 'nir08', label: 'NIR 30 m' },
    { key: 'swir16', label: 'SWIR1 30 m' },
    { key: 'swir22', label: 'SWIR2 30 m' },
  ],
  s1: [
    { key: 'vv', label: 'VV γ⁰ (RTC, 10 m)' },
    { key: 'vh', label: 'VH γ⁰ (RTC, 10 m)' },
  ],
};

/** Planetary Computer blob URLs need a short-lived SAS token (public signing endpoint, no key). */
export async function signedAssetUrl(href: string): Promise<string> {
  const r = await fetch(`https://planetarycomputer.microsoft.com/api/sas/v1/sign?href=${encodeURIComponent(href)}`);
  if (!r.ok) throw new Error(`signing failed (HTTP ${r.status})`);
  const j = await r.json();
  return j.href;
}
