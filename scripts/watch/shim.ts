// Just enough of the browser for the change-detection code in src/lib to run under Node:
// createImageBitmap (PNG/JPEG decode), <canvas> 2D pixels (drawImage, get/putImageData,
// polygon clip via 'destination-in', fillRect), toDataURL (PNG/JPEG encode) and localStorage.
// Pure JS (pngjs, jpeg-js) — no native modules, so it runs on any GitHub Actions runner.
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

type Pixels = { width: number; height: number; data: Uint8ClampedArray };

function decode(buf: Buffer): Pixels {
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const p = PNG.sync.read(buf);
    return { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data.buffer, p.data.byteOffset, p.data.length) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    return { width: j.width, height: j.height, data: new Uint8ClampedArray(j.data.buffer, j.data.byteOffset, j.data.length) };
  }
  throw new Error('unsupported image format');
}

function parseColor(s: unknown): [number, number, number, number] {
  const t = String(s ?? '#000').trim();
  let m = /^#([0-9a-f]{6})$/i.exec(t);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 255];
  m = /^rgba?\(([^)]+)\)$/i.exec(t);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0], p[1], p[2], Math.round((p[3] ?? 1) * 255)];
  }
  return [0, 0, 0, 255];
}

/** even–odd fill test for a set of closed rings in pixel space */
function insideRings(x: number, y: number, rings: [number, number][][]) {
  let inside = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}

class Ctx {
  globalCompositeOperation = 'source-over';
  fillStyle: unknown = '#000';
  strokeStyle: unknown = '#000';
  lineWidth = 1;
  imageSmoothingEnabled = true;
  imageSmoothingQuality = 'low';
  globalAlpha = 1;
  private stack: { op: string; fill: unknown; alpha: number }[] = [];
  private rings: [number, number][][] = [];
  constructor(public canvas: Canvas) {}
  get px() {
    return this.canvas._data;
  }
  save() {
    this.stack.push({ op: this.globalCompositeOperation, fill: this.fillStyle, alpha: this.globalAlpha });
  }
  restore() {
    const s = this.stack.pop();
    if (s) {
      this.globalCompositeOperation = s.op;
      this.fillStyle = s.fill;
      this.globalAlpha = s.alpha;
    }
  }
  private blend(o: number, r: number, g: number, b: number, a: number) {
    const d = this.px;
    a = a * this.globalAlpha;
    if (a >= 255) {
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      return;
    }
    if (a <= 0) return;
    const sa = a / 255, da = d[o + 3] / 255, oa = sa + da * (1 - sa);
    d[o] = (r * sa + d[o] * da * (1 - sa)) / oa;
    d[o + 1] = (g * sa + d[o + 1] * da * (1 - sa)) / oa;
    d[o + 2] = (b * sa + d[o + 2] * da * (1 - sa)) / oa;
    d[o + 3] = oa * 255;
  }
  drawImage(src: any, ...a: number[]) {
    const s: Pixels = src instanceof Canvas ? { width: src.width, height: src.height, data: src._data } : src;
    let sx = 0, sy = 0, sw = s.width, sh = s.height, dx: number, dy: number, dw: number, dh: number;
    if (a.length === 2) [dx, dy] = a, dw = sw, dh = sh;
    else if (a.length === 4) [dx, dy, dw, dh] = a;
    else [sx, sy, sw, sh, dx, dy, dw, dh] = a;
    const W = this.canvas.width, H = this.canvas.height;
    const x0 = Math.max(0, Math.floor(dx)), x1 = Math.min(W, Math.ceil(dx + dw));
    const y0 = Math.max(0, Math.floor(dy)), y1 = Math.min(H, Math.ceil(dy + dh));
    for (let y = y0; y < y1; y++) {
      const syy = Math.floor(sy + ((y + 0.5 - dy) / dh) * sh);
      if (syy < 0 || syy >= s.height) continue;
      for (let x = x0; x < x1; x++) {
        const sxx = Math.floor(sx + ((x + 0.5 - dx) / dw) * sw);
        if (sxx < 0 || sxx >= s.width) continue;
        const i = (syy * s.width + sxx) * 4;
        this.blend((y * W + x) * 4, s.data[i], s.data[i + 1], s.data[i + 2], s.data[i + 3]);
      }
    }
  }
  getImageData(x: number, y: number, w: number, h: number): Pixels {
    const out = new Uint8ClampedArray(w * h * 4);
    const W = this.canvas.width;
    for (let r = 0; r < h; r++) {
      const sy = y + r;
      if (sy < 0 || sy >= this.canvas.height) continue;
      for (let c = 0; c < w; c++) {
        const sx = x + c;
        if (sx < 0 || sx >= W) continue;
        const i = (sy * W + sx) * 4, o = (r * w + c) * 4;
        out[o] = this.px[i]; out[o + 1] = this.px[i + 1]; out[o + 2] = this.px[i + 2]; out[o + 3] = this.px[i + 3];
      }
    }
    return { width: w, height: h, data: out };
  }
  createImageData(w: number, h: number): Pixels {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  putImageData(img: Pixels, x: number, y: number) {
    const W = this.canvas.width;
    for (let r = 0; r < img.height; r++) {
      const dy = y + r;
      if (dy < 0 || dy >= this.canvas.height) continue;
      for (let c = 0; c < img.width; c++) {
        const dx = x + c;
        if (dx < 0 || dx >= W) continue;
        const i = (r * img.width + c) * 4, o = (dy * W + dx) * 4;
        this.px[o] = img.data[i]; this.px[o + 1] = img.data[i + 1]; this.px[o + 2] = img.data[i + 2]; this.px[o + 3] = img.data[i + 3];
      }
    }
  }
  fillRect(x: number, y: number, w: number, h: number) {
    const [r, g, b, a] = parseColor(this.fillStyle);
    const W = this.canvas.width, H = this.canvas.height;
    for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(H, Math.ceil(y + h)); yy++)
      for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(W, Math.ceil(x + w)); xx++) this.blend((yy * W + xx) * 4, r, g, b, a);
  }
  clearRect(x: number, y: number, w: number, h: number) {
    const W = this.canvas.width, H = this.canvas.height;
    for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(H, Math.ceil(y + h)); yy++)
      for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(W, Math.ceil(x + w)); xx++) this.px.fill(0, (yy * W + xx) * 4, (yy * W + xx) * 4 + 4);
  }
  beginPath() {
    this.rings = [];
  }
  moveTo(x: number, y: number) {
    this.rings.push([[x, y]]);
  }
  lineTo(x: number, y: number) {
    if (!this.rings.length) this.rings.push([]);
    this.rings[this.rings.length - 1].push([x, y]);
  }
  rect(x: number, y: number, w: number, h: number) {
    this.rings.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
  }
  closePath() {}
  fill() {
    const W = this.canvas.width, H = this.canvas.height;
    if (this.globalCompositeOperation === 'destination-in') {
      // keep only what lies inside the path
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) if (!insideRings(x + 0.5, y + 0.5, this.rings)) this.px[(y * W + x) * 4 + 3] = 0;
      return;
    }
    const [r, g, b, a] = parseColor(this.fillStyle);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (insideRings(x + 0.5, y + 0.5, this.rings)) this.blend((y * W + x) * 4, r, g, b, a);
  }
  // drawing calls the analysis never relies on: accept and ignore
  stroke() {}
  setLineDash() {}
  fillText() {}
  strokeRect() {}
  translate() {}
  scale() {}
  setTransform() {}
  arc() {}
  measureText(s: string) {
    return { width: s.length * 7 };
  }
}

class Canvas {
  _w = 300;
  _h = 150;
  _data = new Uint8ClampedArray(300 * 150 * 4);
  private ctx = new Ctx(this);
  get width() { return this._w; }
  set width(v: number) { this._w = Math.max(1, Math.floor(v)); this._data = new Uint8ClampedArray(this._w * this._h * 4); }
  get height() { return this._h; }
  set height(v: number) { this._h = Math.max(1, Math.floor(v)); this._data = new Uint8ClampedArray(this._w * this._h * 4); }
  getContext() {
    return this.ctx as unknown as CanvasRenderingContext2D;
  }
  toBuffer(type = 'image/png', quality = 0.85): Buffer {
    if (type === 'image/jpeg') {
      // JPEG has no alpha: put transparent pixels on black
      const d = Buffer.from(this._data);
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] < 255) { const a = d[i + 3] / 255; d[i] *= a; d[i + 1] *= a; d[i + 2] *= a; d[i + 3] = 255; }
      return jpeg.encode({ width: this._w, height: this._h, data: d }, Math.round(quality * 100)).data as Buffer;
    }
    const png = new PNG({ width: this._w, height: this._h });
    png.data = Buffer.from(this._data);
    return PNG.sync.write(png);
  }
  toDataURL(type = 'image/png', quality = 0.85) {
    const t = type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${t};base64,${this.toBuffer(t, quality).toString('base64')}`;
  }
}

const g = globalThis as any;
g.createImageBitmap = async (blob: Blob) => {
  const img = decode(Buffer.from(await blob.arrayBuffer()));
  return { ...img, close() {} };
};
g.document = g.document ?? {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error(`document.createElement('${tag}') is not available in the watch runner`);
    return new Canvas();
  },
};
const mem = new Map<string, string>();
g.localStorage = g.localStorage ?? {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
};

export { Canvas, decode };
