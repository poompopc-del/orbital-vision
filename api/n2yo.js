// Vercel serverless function: proxy for the N2YO REST API (https://www.n2yo.com/api/).
// The API key lives only on the server (env N2YO_API_KEY) and is never sent to the browser.
// Responses are cached at the edge so repeated requests do not use up N2YO's hourly limits
// (tle / positions: 1000 per hour · radiopasses / visualpasses / above: 100 per hour).
//
//   /api/n2yo?op=status
//   /api/n2yo?op=tle&id=25544
//   /api/n2yo?op=positions&id=25544&lat=13.7&lng=100.5&alt=0&seconds=60
//   /api/n2yo?op=radiopasses&id=25544&lat=13.7&lng=100.5&alt=0&days=3&minEl=10
//   /api/n2yo?op=visualpasses&id=25544&lat=13.7&lng=100.5&alt=0&days=3&minVisibility=60
//   /api/n2yo?op=above&lat=13.7&lng=100.5&alt=0&radius=70&category=0

const BASE = 'https://api.n2yo.com/rest/v1/satellite';

const num = (v, min, max) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
// round coordinates so nearby requests share one cache entry (≈100 m)
const r3 = (n) => Math.round(n * 1000) / 1000;

export default async function handler(req, res) {
  const key = process.env.N2YO_API_KEY;
  const q = req.query || {};
  const op = String(q.op || '');

  if (op === 'status') {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ configured: !!key });
    return;
  }
  if (!key) {
    res.status(503).json({ configured: false, error: 'N2YO_API_KEY is not set on the server' });
    return;
  }

  const bad = (msg) => res.status(400).json({ error: msg });
  const id = /^\d{1,9}$/.test(String(q.id || '')) ? String(parseInt(q.id, 10)) : null;
  const lat = num(q.lat, -90, 90);
  const lng = num(q.lng, -180, 180);
  const alt = num(q.alt ?? 0, -500, 9000);

  let path;
  let ttl;
  switch (op) {
    case 'tle':
      if (!id) return bad('id must be a NORAD catalogue number');
      path = `/tle/${id}`;
      ttl = 7200;
      break;
    case 'positions': {
      const s = num(q.seconds, 1, 300);
      if (!id || lat == null || lng == null || alt == null || s == null) return bad('need id, lat, lng, alt and seconds (1–300)');
      path = `/positions/${id}/${r3(lat)}/${r3(lng)}/${Math.round(alt)}/${Math.round(s)}`;
      ttl = 15;
      break;
    }
    case 'radiopasses': {
      const d = num(q.days, 1, 10);
      const m = num(q.minEl, 0, 90);
      if (!id || lat == null || lng == null || alt == null || d == null || m == null) return bad('need id, lat, lng, alt, days (1–10) and minEl (0–90)');
      path = `/radiopasses/${id}/${r3(lat)}/${r3(lng)}/${Math.round(alt)}/${Math.round(d)}/${Math.round(m)}`;
      ttl = 900;
      break;
    }
    case 'visualpasses': {
      const d = num(q.days, 1, 10);
      const v = num(q.minVisibility, 1, 3600);
      if (!id || lat == null || lng == null || alt == null || d == null || v == null) return bad('need id, lat, lng, alt, days (1–10) and minVisibility (s)');
      path = `/visualpasses/${id}/${r3(lat)}/${r3(lng)}/${Math.round(alt)}/${Math.round(d)}/${Math.round(v)}`;
      ttl = 900;
      break;
    }
    case 'above': {
      const radius = num(q.radius, 0, 90);
      const cat = num(q.category ?? 0, 0, 100);
      if (lat == null || lng == null || alt == null || radius == null || cat == null) return bad('need lat, lng, alt, radius (0–90) and category');
      path = `/above/${r3(lat)}/${r3(lng)}/${Math.round(alt)}/${Math.round(radius)}/${Math.round(cat)}`;
      ttl = 30;
      break;
    }
    default:
      return bad('op must be status, tle, positions, radiopasses, visualpasses or above');
  }

  try {
    // N2YO expects the key appended with "&" directly after the path
    const r = await fetch(`${BASE}${path}&apiKey=${encodeURIComponent(key)}`, {
      headers: { 'User-Agent': 'orbital-vision/0.1 (+vercel)' },
    });
    const text = await r.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      res.status(502).json({ error: `N2YO HTTP ${r.status}: not JSON` });
      return;
    }
    if (!r.ok || j.error) {
      res.status(502).json({ error: `N2YO: ${j.error || `HTTP ${r.status}`}` });
      return;
    }
    res.setHeader('Cache-Control', `s-maxage=${ttl}, stale-while-revalidate=${ttl}`);
    res.status(200).json({ source: 'N2YO', fetchedAt: new Date().toISOString(), ...j });
  } catch (e) {
    res.status(502).json({ error: String(e && e.message ? e.message : e) });
  }
}
