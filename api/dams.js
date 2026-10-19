// Vercel serverless proxy for the Royal Irrigation Department (กรมชลประทาน) public reservoir API.
// The upstream does not send CORS headers for browsers, so the app reads it through here.
// Response is passed through unchanged, plus fetch metadata.
const RID_DAM = 'https://app.rid.go.th/reservoir/api/dam/public';

export default async function handler(req, res) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(RID_DAM, {
      headers: { 'User-Agent': 'orbital-vision/0.1 (+vercel)', Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      res.status(502).json({ error: `RID HTTP ${r.status}`, source: RID_DAM });
      return;
    }
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json({ source: RID_DAM, fetchedAt: new Date().toISOString(), data });
  } catch (e) {
    res.status(502).json({ error: String(e && e.message ? e.message : e), source: RID_DAM });
  } finally {
    clearTimeout(timer);
  }
}
