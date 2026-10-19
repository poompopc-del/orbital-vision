// Vercel serverless function: aggregates public orbital elements from CelesTrak
// and caches them at the edge, so browsers don't hit CelesTrak directly.
// CelesTrak asks clients not to re-download the same data more often than every ~2 hours.

const QUERIES = [
  'GROUP=resource',
  'GROUP=planet',
  'GROUP=weather',
  'NAME=SENTINEL',
  'NAME=LANDSAT',
  'NAME=WORLDVIEW',
  'NAME=GEOEYE',
  'NAME=PLEIADES',
  'NAME=SPOT',
  'NAME=BLACKSKY',
  'NAME=NUSAT',
  'NAME=ICEYE',
  'NAME=CAPELLA',
  'NAME=UMBRA',
  'NAME=THEOS',
  'NAME=NAPA',
];

export default async function handler(req, res) {
  const results = await Promise.allSettled(
    QUERIES.map(async (q) => {
      const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?${q}&FORMAT=3le`, {
        headers: { 'User-Agent': 'orbital-vision/0.1 (+vercel)' },
      });
      if (!r.ok) throw new Error(`${q}: HTTP ${r.status}`);
      const text = await r.text();
      if (/No GP data found/i.test(text)) return '';
      return text;
    }),
  );

  const seen = new Set();
  const out = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      errors.push(String(r.reason && r.reason.message ? r.reason.message : r.reason));
      return;
    }
    const lines = r.value.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
    for (let k = 0; k + 2 < lines.length + 1; k += 3) {
      const name = lines[k];
      const l1 = lines[k + 1];
      const l2 = lines[k + 2];
      if (!l1 || !l2 || !l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
      const id = l1.substring(2, 7).trim();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(`${name.replace(/^0 /, '')}\n${l1}\n${l2}`);
    }
    void i;
  });

  if (out.length === 0) {
    res.status(502).json({ error: 'CelesTrak unavailable', details: errors });
    return;
  }

  res.setHeader('Cache-Control', 's-maxage=7200, stale-while-revalidate=3600');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(
    JSON.stringify({
      source: 'CelesTrak GP (3LE)',
      fetchedAt: new Date().toISOString(),
      count: out.length,
      partialErrors: errors,
      tle: out.join('\n'),
    }),
  );
}
