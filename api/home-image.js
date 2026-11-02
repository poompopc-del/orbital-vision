// Vercel serverless function: home-page panel pictures.
// Esri's export service renders each picture on demand, which takes seconds. This function
// fetches it once and lets Vercel's CDN keep it for a month, so visitors get it instantly.
// Only the fixed places below can be requested (not an open proxy).
//
//   /api/home-image?id=ayutthaya&w=1600   (w = 160 for the quick placeholder, 1600 full size)

const PLACES = {
  ayutthaya: { lat: 14.356, lon: 100.566, w: 0.13 },
  bangkrachao: { lat: 13.683, lon: 100.565, w: 0.16 },
  aranyaprathet: { lat: 13.663, lon: 102.548, w: 0.12 },
  bhumibol: { lat: 17.243, lon: 98.972, w: 0.1 },
  suvarnabhumi: { lat: 13.69, lon: 100.75, w: 0.08 },
};
const WIDTHS = [160, 1600];
const ESRI = 'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export';

export default async function handler(req, res) {
  const q = req.query || {};
  const p = PLACES[String(q.id || '')];
  const w = Number(q.w || 1600);
  if (!p || !WIDTHS.includes(w)) {
    res.status(400).json({ error: `id must be one of ${Object.keys(PLACES).join(', ')}; w must be ${WIDTHS.join(' or ')}` });
    return;
  }
  // 16:9 box on the ground, centred on the subject
  const h = p.w * Math.cos((p.lat * Math.PI) / 180) * (9 / 16);
  const bbox = [p.lon - p.w / 2, p.lat - h / 2, p.lon + p.w / 2, p.lat + h / 2].map((v) => v.toFixed(5)).join(',');
  const url = `${ESRI}?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=${w},${Math.round((w * 9) / 16)}&format=jpg&f=image`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'orbital-vision/0.1 (+vercel)' } });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.startsWith('image/')) {
      res.status(502).json({ error: `Esri HTTP ${r.status}` });
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', ct);
    // browsers keep it a day; the CDN keeps it a month and refreshes in the background
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800');
    res.status(200).send(buf);
  } catch (e) {
    res.status(502).json({ error: String(e && e.message ? e.message : e) });
  }
}
