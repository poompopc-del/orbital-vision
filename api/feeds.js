// Vercel serverless proxy for open disaster feeds that browsers cannot read directly (no CORS):
//   ?src=firms&period=24h|48h|7d  NASA FIRMS VIIRS (S-NPP + NOAA-20) active fire CSV, South-East Asia,
//                                 trimmed to a Thailand bounding box
//   ?src=gdacs                    GDACS event list (last 60 days) around Thailand
//   ?src=air4thai                 Pollution Control Department station AQI / PM2.5
//   ?src=tmd                      Thai Meteorological Department weather warnings (public demo key)
//   ?src=cems                     Copernicus EMS rapid-mapping public activations (JSON)
// Responses carry the upstream URL and fetch time; upstream data is passed through unaltered
// except for the FIRMS geographic trim.
const BBOX = { w: 96.5, s: 4.5, e: 106.5, n: 21.5 };

const FIRMS = {
  '24h': ['https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_SouthEast_Asia_24h.csv', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_SouthEast_Asia_24h.csv'],
  '48h': ['https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_SouthEast_Asia_48h.csv', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_SouthEast_Asia_48h.csv'],
  '7d': ['https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_SouthEast_Asia_7d.csv', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_SouthEast_Asia_7d.csv'],
};

async function get(url, timeout = 25000, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'orbital-vision/0.2 (+vercel)', ...headers }, signal: ctrl.signal });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text, lastModified: r.headers.get('last-modified') };
  } finally {
    clearTimeout(t);
  }
}

function trimCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { header: '', rows: [] };
  const header = lines[0];
  const cols = header.split(',');
  const iLat = cols.indexOf('latitude'), iLon = cols.indexOf('longitude');
  const rows = lines.slice(1).filter((l) => {
    const c = l.split(',');
    const lat = +c[iLat], lon = +c[iLon];
    return lat >= BBOX.s && lat <= BBOX.n && lon >= BBOX.w && lon <= BBOX.e;
  });
  return { header, rows };
}

export default async function handler(req, res) {
  const src = String(req.query.src || '');
  const now = new Date().toISOString();
  try {
    if (src === 'firms') {
      const period = FIRMS[req.query.period] ? req.query.period : '24h';
      const parts = await Promise.all(FIRMS[period].map((u) => get(u).catch((e) => ({ ok: false, status: 0, text: String(e), url: u }))));
      let header = '';
      const rows = [];
      const sources = [];
      parts.forEach((p, i) => {
        sources.push({ url: FIRMS[period][i], status: p.status, lastModified: p.lastModified || null });
        if (!p.ok) return;
        const t = trimCsv(p.text);
        header = header || t.header;
        const sat = i === 0 ? 'VIIRS S-NPP' : 'VIIRS NOAA-20';
        t.rows.forEach((r) => rows.push(`${r},${sat}`));
      });
      if (!header) return res.status(502).json({ error: 'FIRMS unavailable', sources, fetchedAt: now });
      res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
      return res.status(200).json({ src, period, fetchedAt: now, sources, csv: `${header},sensor\n${rows.join('\n')}` });
    }
    // ThaiWater (สสน.) — read once per 10 min for everyone (edge cache) and trimmed, because the
    // public API rate-limits (HTTP 429) and the rainfall list is ~4 MB
    if (src === 'tw_wl' || src === 'tw_rain' || src === 'tw_warn') {
      const TW = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public/';
      const url = TW + (src === 'tw_wl' ? 'waterlevel_load' : src === 'tw_rain' ? 'rain_24h' : 'warning');
      const r = await get(url, 25000, { Accept: 'application/json' });
      if (!r.ok) return res.status(502).json({ error: `upstream HTTP ${r.status}`, source: url, fetchedAt: now });
      const j = JSON.parse(r.text);
      let data;
      if (src === 'tw_wl')
        data = (j.waterlevel_data?.data || []).map((x) => ({
          dt: x.waterlevel_datetime, msl: x.waterlevel_msl, prev: x.waterlevel_msl_previous, pct: x.storage_percent, lv: x.situation_level,
          st: { id: x.station?.id, th: x.station?.tele_station_name?.th, en: x.station?.tele_station_name?.en, lat: x.station?.tele_station_lat, lon: x.station?.tele_station_long, lb: x.station?.left_bank, rb: x.station?.right_bank },
          prov: x.geocode?.province_name?.en, amphoe: x.geocode?.amphoe_name?.th, basin: x.basin?.basin_name?.th, agency: x.agency?.agency_shortname?.th,
        }));
      else if (src === 'tw_rain')
        data = (j.data || []).filter((x) => +x.rain_24h >= 35.1).map((x) => ({
          dt: x.rainfall_datetime, mm: +x.rain_24h, mm1h: x.rain_1h,
          st: { id: x.station?.id, th: x.station?.tele_station_name?.th, lat: x.station?.tele_station_lat, lon: x.station?.tele_station_long },
          prov: x.geocode?.province_name?.en, amphoe: x.geocode?.amphoe_name?.th, agency: x.agency?.agency_shortname?.th,
        }));
      else data = j.data || [];
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
      return res.status(200).json({ src, source: url, fetchedAt: now, data });
    }
    const map = {
      gdacs: () => {
        const to = new Date(), from = new Date(Date.now() - 60 * 86400e3);
        const d = (x) => x.toISOString().slice(0, 10);
        return `https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;DR;WF;VO&fromDate=${d(from)}&toDate=${d(to)}`;
      },
      air4thai: () => 'https://air4thai.pcd.go.th/services/getNewAQI_JSON.php',
      tmd: () => 'https://data.tmd.go.th/api/WeatherWarningNews/v2/?uid=api&ukey=api12345&format=json',
      cems: () => 'https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/?limit=200',
    };
    if (!map[src]) return res.status(400).json({ error: 'unknown src', allowed: ['firms', ...Object.keys(map)] });
    const url = map[src]();
    let r = await get(url, src === 'gdacs' ? 28000 : 25000, src === 'gdacs' || src === 'cems' ? { Accept: 'application/json' } : {}).catch((e) => ({ ok: false, status: 0, text: String(e && e.message) }));
    // Air4Thai sometimes answers only over plain http
    if (!r.ok && src === 'air4thai') r = await get(url.replace('https:', 'http:')).catch((e) => ({ ok: false, status: 0, text: String(e && e.message) }));
    if (!r.ok && src === 'air4thai') r = await get('http://air4thai.com/forweb/getAQI_JSON.php').catch((e) => ({ ok: false, status: 0, text: String(e && e.message) }));
    // CEMS: the listing path has moved before — try the known variants
    if (src === 'cems' && (!r.ok || /mandatory/i.test(r.text))) {
      for (const alt of ['https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/activations/?limit=200', 'https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations/?limit=200&code=']) {
        const t = await get(alt, 20000, { Accept: 'application/json' }).catch(() => null);
        if (t && t.ok && !/mandatory/i.test(t.text)) { r = t; break; }
      }
    }
    if (!r.ok) return res.status(502).json({ error: `upstream HTTP ${r.status}`, source: url, fetchedAt: now, sample: r.text.slice(0, 300) });
    let body = r.text;
    if (src === 'gdacs') {
      // keep only events whose point lies in the Thailand region box
      try {
        const j = JSON.parse(body);
        j.features = (j.features || []).filter((f) => {
          const c = f.geometry && f.geometry.coordinates;
          if (!c) return false;
          return c[1] >= BBOX.s - 3 && c[1] <= BBOX.n + 3 && c[0] >= BBOX.w - 3 && c[0] <= BBOX.e + 3;
        });
        body = JSON.stringify(j);
      } catch {
        /* pass through */
      }
    }
    res.setHeader('Cache-Control', `s-maxage=${src === 'air4thai' ? 600 : 1800}, stale-while-revalidate=1800`);
    return res.status(200).json({ src, source: url, fetchedAt: now, lastModified: r.lastModified || null, body });
  } catch (e) {
    return res.status(502).json({ error: String(e && e.message ? e.message : e), src, fetchedAt: now });
  }
}
