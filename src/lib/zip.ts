// Minimal ZIP reader (stored + deflate entries) for KMZ, XLSX and zipped shapefiles.
// Uses the platform DecompressionStream, so it adds no dependency. ZIP64 and encryption are not supported.

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unzip files (no DecompressionStream) — unzip the file first');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw' as CompressionFormat));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Read every file entry of a ZIP archive. Paths keep their folders; directories are skipped. */
export async function unzip(buf: Uint8Array, maxBytes = 200 * 1024 * 1024): Promise<Map<string, Uint8Array>> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP file');
  const count = u16(buf, eocd + 10);
  let p = u32(buf, eocd + 16);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (u32(buf, p) !== 0x02014b50) throw new Error('Corrupt ZIP directory');
    const flags = u16(buf, p + 8), method = u16(buf, p + 10);
    const csize = u32(buf, p + 20), usize = u32(buf, p + 24);
    const nlen = u16(buf, p + 28), xlen = u16(buf, p + 30), clen = u16(buf, p + 32);
    const local = u32(buf, p + 42);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/') || flags & 1) continue; // directory or encrypted
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error('ZIP64 archives are not supported');
    total += usize;
    if (total > maxBytes) throw new Error('ZIP content is too large');
    const start = local + 30 + u16(buf, local + 26) + u16(buf, local + 28);
    const raw = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflateRaw(raw));
    // other methods (bzip2, lzma…) are skipped
  }
  return out;
}
