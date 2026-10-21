// Vercel serverless proxy for flood news and place lookup (browsers cannot read these directly):
//   ?src=gnews&scope=all|gov&days=1..7  Google News RSS search (Thai), parsed to JSON
//   ?src=gdelt&days=1..7                GDELT DOC 2.0 article list, Thai-language flood news (has images)
//   ?src=reliefweb&days=1..30           ReliefWeb reports on Thailand floods (UN OCHA, governments, NGOs)
//   ?src=article&url=…                  one news page → title, image, publish time, plain text
//   ?src=geocode&q=…                    OpenStreetMap Nominatim search limited to Thailand
// Nothing is rewritten: titles, links and times are passed through as published.

const UA = 'orbital-vision/0.3 (+https://orbital-vision-olive.vercel.app)';

async function get(url, timeout = 20000, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'th,en;q=0.8', ...headers }, signal: ctrl.signal, redirect: 'follow' });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text, url: r.url };
  } finally {
    clearTimeout(t);
  }
}

const decode = (s) =>
  String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .trim();
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
};
const attr = (xml, name, a) => {
  const m = xml.match(new RegExp(`<${name}\\s[^>]*${a}="([^"]*)"`, 'i'));
  return m ? decode(m[1]) : '';
};
const stripTags = (h) => decode(String(h).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const FLOOD_TH = '(น้ำท่วม OR อุทกภัย OR "น้ำล้นตลิ่ง" OR "น้ำป่าไหลหลาก" OR "ท่วมขัง")';

function blockedHost(h) {
  h = h.toLowerCase();
  return h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(\d+\.){3}\d+$/.test(h) || h.includes(':') || h === 'metadata.google.internal';
}

// Google News RSS links point at news.google.com/rss/articles/<id>; the publisher URL is obtained
// the same way the Google News web page does it (signature + timestamp → batchexecute).
async function resolveGoogle(u) {
  const id = u.pathname.split('/').pop();
  const page = await get(`https://news.google.com/rss/articles/${id}`, 12000, { Accept: 'text/html' });
  const sg = page.text.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = page.text.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sg || !ts) return null;
  const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, +ts, sg]);
  const freq = JSON.stringify([[['Fbv4je', inner, null, 'generic']]]);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'f.req=' + encodeURIComponent(freq),
      signal: ctrl.signal,
    });
    const text = await r.text();
    const line = text.split('\n').find((l) => l.includes('garturlres'));
    if (!line) return null;
    const outer = JSON.parse(line);
    const res = JSON.parse(outer[0][2]);
    return typeof res[1] === 'string' ? res[1] : null;
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res) {
  const src = String(req.query.src || '');
  const now = new Date().toISOString();
  try {
    if (src === 'gnews') {
      const days = Math.min(7, Math.max(1, +req.query.days || 3));
      const scope = req.query.scope === 'gov' ? 'gov' : 'all';
      const q = `${FLOOD_TH}${scope === 'gov' ? ' site:go.th' : ''} when:${days}d`;
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=th&gl=TH&ceid=TH:th`;
      const r = await get(url);
      if (!r.ok) return res.status(502).json({ error: `upstream HTTP ${r.status}`, source: url, fetchedAt: now });
      const items = (r.text.match(/<item>[\s\S]*?<\/item>/g) || []).map((it) => ({
        title: tag(it, 'title'),
        link: tag(it, 'link'),
        published: tag(it, 'pubDate') ? new Date(tag(it, 'pubDate')).toISOString() : null,
        outlet: tag(it, 'source'),
        outletUrl: attr(it, 'source', 'url'),
        summary: stripTags(tag(it, 'description')).slice(0, 400),
      }));
      res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
      return res.status(200).json({ src, scope, source: url, fetchedAt: now, items });
    }

    if (src === 'gdelt') {
      const days = Math.min(7, Math.max(1, +req.query.days || 3));
      const q = '(น้ำท่วม OR อุทกภัย OR flood OR flooding) sourcecountry:thailand';
      const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&format=json&maxrecords=150&sort=datedesc&timespan=${days}d`;
      let r = await get(url, 25000);
      // GDELT allows one request per 5 s per IP; shared serverless IPs hit that — wait and retry once
      if (r.status === 429) {
        await new Promise((ok) => setTimeout(ok, 6000));
        r = await get(url, 20000);
      }
      if (!r.ok) return res.status(502).json({ error: `upstream HTTP ${r.status}`, source: url, fetchedAt: now, sample: r.text.slice(0, 200) });
      let j;
      try {
        j = JSON.parse(r.text);
      } catch {
        return res.status(502).json({ error: 'GDELT returned non-JSON', source: url, fetchedAt: now, sample: r.text.slice(0, 200) });
      }
      const items = (j.articles || []).map((a) => ({
        title: a.title,
        link: a.url,
        published: a.seendate ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}T${a.seendate.slice(9, 11)}:${a.seendate.slice(11, 13)}:${a.seendate.slice(13, 15)}Z` : null,
        outlet: a.domain,
        image: a.socialimage || null,
        language: a.language,
      }));
      res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
      return res.status(200).json({ src, source: url, fetchedAt: now, items });
    }

    if (src === 'reliefweb') {
      const days = Math.min(30, Math.max(1, +req.query.days || 7));
      const from = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 19) + '+00:00';
      const url = 'https://api.reliefweb.int/v2/reports?appname=orbital-vision';
      const body = {
        limit: 50,
        sort: ['date.created:desc'],
        fields: { include: ['title', 'url', 'date.created', 'source.shortname', 'source.name', 'body', 'file.preview', 'primary_country.name'] },
        filter: { operator: 'AND', conditions: [{ field: 'country.iso3', value: 'THA' }, { field: 'disaster_type.name', value: 'Flood' }, { field: 'date.created', value: { from } }] },
      };
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      let r;
      try {
        r = await fetch(url, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
      } finally {
        clearTimeout(t);
      }
      const text = await r.text();
      if (!r.ok) return res.status(502).json({ error: `upstream HTTP ${r.status}`, source: url, fetchedAt: now, sample: text.slice(0, 200) });
      const j = JSON.parse(text);
      const items = (j.data || []).map((d) => ({
        title: d.fields.title,
        link: d.fields.url,
        published: d.fields.date?.created || null,
        outlet: (d.fields.source || []).map((s) => s.shortname || s.name).join(', '),
        summary: String(d.fields.body || '').replace(/[#*_>\[\]]/g, '').slice(0, 3000),
        image: d.fields.file?.[0]?.preview?.['url-thumb'] || null,
      }));
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
      return res.status(200).json({ src, source: url, fetchedAt: now, items });
    }

    if (src === 'article') {
      let u;
      try {
        u = new URL(String(req.query.url || ''));
      } catch {
        return res.status(400).json({ error: 'bad url' });
      }
      if (!/^https?:$/.test(u.protocol) || blockedHost(u.hostname)) return res.status(400).json({ error: 'url not allowed' });
      let target = u.toString();
      if (u.hostname === 'news.google.com') {
        const real = await resolveGoogle(u).catch(() => null);
        if (!real) return res.status(502).json({ error: 'could not resolve Google News link', source: target, fetchedAt: now });
        target = real;
        const ru = new URL(real);
        if (!/^https?:$/.test(ru.protocol) || blockedHost(ru.hostname)) return res.status(400).json({ error: 'url not allowed' });
      }
      const r = await get(target, 15000, { Accept: 'text/html' });
      if (!r.ok) return res.status(502).json({ error: `upstream HTTP ${r.status}`, source: target, fetchedAt: now });
      const u2 = new URL(r.url || target);
      const h = r.text.slice(0, 1_500_000);
      const meta = (p) => {
        const m = h.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']*)["']`, 'i')) || h.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${p}["']`, 'i'));
        return m ? decode(m[1]) : '';
      };
      const body = (h.match(/<article[\s\S]*?<\/article>/i) || [h.match(/<body[\s\S]*<\/body>/i)?.[0] || h])[0];
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
      return res.status(200).json({
        src, source: r.url || target, fetchedAt: now,
        title: meta('og:title') || tag(h, 'title'),
        image: meta('og:image') || meta('twitter:image') || null,
        description: meta('og:description') || meta('description'),
        published: meta('article:published_time') || meta('og:updated_time') || null,
        outlet: meta('og:site_name') || u2.hostname,
        text: stripTags(body).slice(0, 20000),
      });
    }

    if (src === 'geocode') {
      const q = String(req.query.q || '').slice(0, 200);
      if (!q) return res.status(400).json({ error: 'q required' });
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=th&accept-language=th&limit=5&addressdetails=1&q=${encodeURIComponent(q)}`;
      const r = await get(url, 15000, { Accept: 'application/json' });
      if (!r.ok) return res.status(502).json({ error: `upstream HTTP ${r.status}`, source: url, fetchedAt: now });
      const results = JSON.parse(r.text).map((x) => ({ name: x.display_name, lat: +x.lat, lon: +x.lon, type: x.addresstype || x.type, cls: x.class, bbox: x.boundingbox?.map(Number), address: x.address }));
      res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=604800');
      return res.status(200).json({ src, q, source: 'OpenStreetMap Nominatim', fetchedAt: now, results });
    }

    return res.status(400).json({ error: 'unknown src', allowed: ['gnews', 'gdelt', 'reliefweb', 'article', 'geocode'] });
  } catch (e) {
    return res.status(502).json({ error: String(e && e.message ? e.message : e), src, fetchedAt: now });
  }
}
