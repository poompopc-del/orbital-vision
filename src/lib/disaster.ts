// Thailand disaster intelligence: adapters for open feeds → one event model, with source
// registry, health/freshness and provenance on every record.
//
// Rules kept here (from the module spec):
//  • every event carries its source, source id, event time, report time, fetch time and link
//  • no source is assumed to work: each adapter reports ok / error / needs-key / no-api
//  • different kinds of data are never merged into one number (hotspot COUNT ≠ burned AREA,
//    a water-level situation ≠ flooded area); statuses follow the evidence available
import { loadProvinces, provinceAt, thProvince, type Province } from './provinces';

export type Hazard = 'flood' | 'drought' | 'fire' | 'quake' | 'storm' | 'air' | 'other';
export type EvStatus = 'confirmed' | 'reported' | 'unverified' | 'closed';
export type SourceId = 'usgs' | 'firms' | 'gdacs' | 'thaiwater_wl' | 'thaiwater_rain' | 'thaiwater_warn' | 'air4thai' | 'tmd' | 'cems' | 'rid' | 'gistda' | 'ddpm' | 'datagoth';
export type Freshness = 'live' | 'nrt' | 'latest' | 'historical' | 'stale' | 'unavailable' | 'insufficient';

export interface DEvent {
  id: string;
  source: SourceId;
  sourceId: string;
  hazard: Hazard;
  title: string;
  lat: number;
  lon: number;
  bbox?: [number, number, number, number];
  time: string; // when it happened / was measured (ISO, UTC)
  reported?: string; // when the source published it
  fetchedAt: string; // when ORBITAL VISION read it
  status: EvStatus;
  severity: 0 | 1 | 2 | 3;
  severityText: string;
  url?: string;
  province?: string; // English name (geoBoundaries ADM1)
  details: Record<string, string | number | null>;
  points?: [number, number][];
  alsoIn?: string[];
}

export interface Bulletin {
  source: SourceId;
  time: string;
  text: string;
  url?: string;
}

export interface SourceState {
  id: SourceId;
  status: 'ok' | 'error' | 'needs-key' | 'no-api' | 'loading' | 'idle';
  fetchedAt?: string;
  upstreamTime?: string;
  count: number;
  message?: string;
  freshness: Freshness;
}

export interface RegistryEntry {
  id: SourceId;
  name: string;
  org: string;
  hazards: Hazard[];
  format: string;
  endpoint: string;
  cadence: string;
  access: 'open' | 'key' | 'none';
  via: 'direct' | 'proxy' | '—';
  terms: string;
  note?: string;
}

export const REGISTRY: RegistryEntry[] = [
  { id: 'thaiwater_wl', name: 'ThaiWater — water level stations', org: 'สถาบันสารสนเทศทรัพยากรน้ำ (สสน.)', hazards: ['flood', 'drought'], format: 'JSON', endpoint: 'api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load', cadence: '~10–60 min', access: 'open', via: 'direct', terms: 'Public data, cite สสน. / ThaiWater' },
  { id: 'thaiwater_rain', name: 'ThaiWater — 24 h rainfall', org: 'สถาบันสารสนเทศทรัพยากรน้ำ (สสน.)', hazards: ['storm', 'flood'], format: 'JSON', endpoint: 'api-v3.thaiwater.net/api/v1/thaiwater30/public/rain_24h', cadence: 'hourly', access: 'open', via: 'direct', terms: 'Public data, cite สสน. / ThaiWater' },
  { id: 'thaiwater_warn', name: 'ThaiWater — station warnings', org: 'สถาบันสารสนเทศทรัพยากรน้ำ (สสน.)', hazards: ['flood'], format: 'JSON (text)', endpoint: 'api-v3.thaiwater.net/api/v1/thaiwater30/public/warning', cadence: 'hourly', access: 'open', via: 'direct', terms: 'Public data, cite สสน. / ThaiWater' },
  { id: 'firms', name: 'NASA FIRMS — VIIRS active fire', org: 'NASA LANCE / FIRMS', hazards: ['fire'], format: 'CSV', endpoint: 'firms.modaps.eosdis.nasa.gov/data/active_fire/…/SouthEast_Asia_{24h|48h|7d}.csv', cadence: 'near real time (~3 h after overpass)', access: 'open', via: 'proxy', terms: 'NASA open data; cite FIRMS' },
  { id: 'usgs', name: 'USGS Earthquake Catalog', org: 'U.S. Geological Survey', hazards: ['quake'], format: 'GeoJSON', endpoint: 'earthquake.usgs.gov/fdsnws/event/1/query', cadence: 'minutes', access: 'open', via: 'direct', terms: 'Public domain' },
  { id: 'gdacs', name: 'GDACS event list', org: 'EC JRC / UN OCHA', hazards: ['quake', 'storm', 'flood', 'drought', 'fire'], format: 'GeoJSON', endpoint: 'gdacs.org/gdacsapi/api/events/geteventlist/SEARCH', cadence: 'event driven', access: 'open', via: 'proxy', terms: 'Free use with attribution' },
  { id: 'air4thai', name: 'Air4Thai — PM2.5 stations', org: 'กรมควบคุมมลพิษ (คพ.)', hazards: ['air'], format: 'JSON', endpoint: 'air4thai.pcd.go.th/services/getNewAQI_JSON.php', cadence: 'hourly', access: 'open', via: 'proxy', terms: 'Public data, cite คพ.' },
  { id: 'tmd', name: 'TMD weather warnings', org: 'กรมอุตุนิยมวิทยา', hazards: ['storm'], format: 'JSON/XML', endpoint: 'data.tmd.go.th/api/WeatherWarningNews/v2', cadence: 'as issued', access: 'key', via: 'proxy', terms: 'Requires TMD API uid/ukey; the public demo key may be rate-limited or refused' },
  { id: 'cems', name: 'Copernicus EMS rapid mapping', org: 'EU Copernicus', hazards: ['flood', 'storm', 'fire', 'quake'], format: 'JSON', endpoint: 'rapidmapping.emergency.copernicus.eu (dashboard API)', cadence: 'per activation', access: 'open', via: 'proxy', terms: 'Copernicus licence; only activations for Thailand are kept' },
  { id: 'rid', name: 'RID reservoirs', org: 'กรมชลประทาน', hazards: ['flood', 'drought'], format: 'JSON', endpoint: 'app.rid.go.th/reservoir/api/dam/public', cadence: 'daily', access: 'open', via: 'proxy', terms: 'Public data, cite กรมชลประทาน', note: 'Shown in GIS → Dams' },
  { id: 'gistda', name: 'GISTDA Disaster API (flood, burn scar, drought)', org: 'GISTDA', hazards: ['flood', 'fire', 'drought'], format: 'GeoJSON / WMS', endpoint: 'api-gateway.gistda.or.th', cadence: 'daily', access: 'key', via: '—', terms: 'Free API key from GISTDA required — not connected yet' },
  { id: 'ddpm', name: 'DDPM disaster declarations', org: 'กรมป้องกันและบรรเทาสาธารณภัย', hazards: ['flood', 'storm', 'drought', 'fire'], format: 'Web pages / PDF', endpoint: 'disaster.go.th', cadence: 'as declared', access: 'none', via: '—', terms: 'No public machine-readable API found — not connected' },
  { id: 'datagoth', name: 'data.go.th datasets', org: 'สพร. (DGA)', hazards: ['other'], format: 'CKAN (CSV/JSON)', endpoint: 'data.go.th/api/3/action', cadence: 'per dataset', access: 'open', via: '—', terms: 'Per-dataset licence — historical reference, not a live feed' },
];

export const HAZARDS: { id: Hazard; th: string; en: string; color: string; icon: string }[] = [
  { id: 'flood', th: 'อุทกภัย', en: 'Flood', color: '#3b82f6', icon: '🌊' },
  { id: 'drought', th: 'ภัยแล้ง / น้ำน้อย', en: 'Drought / low water', color: '#b45309', icon: '🏜' },
  { id: 'fire', th: 'ไฟป่า / จุดความร้อน', en: 'Fire / hotspots', color: '#ef4444', icon: '🔥' },
  { id: 'quake', th: 'แผ่นดินไหว', en: 'Earthquake', color: '#a855f7', icon: '🌐' },
  { id: 'storm', th: 'พายุ / ฝนหนัก', en: 'Storm / heavy rain', color: '#06b6d4', icon: '🌧' },
  { id: 'air', th: 'ฝุ่น PM2.5', en: 'PM2.5', color: '#f59e0b', icon: '😷' },
  { id: 'other', th: 'อื่น ๆ', en: 'Other', color: '#94a3b8', icon: '⚠' },
];

// ---------------------------------------------------------------- helpers

const nowIso = () => new Date().toISOString();
/** "2026-10-21 10:40" in Thai time → ISO UTC */
const bkk = (s?: string | null) => (s ? new Date(`${s.replace(' ', 'T')}${s.length <= 16 ? ':00' : ''}+07:00`).toISOString() : nowIso());

async function getJson(url: string, ms = 20000): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error(body?.error ? `${body.error}` : `HTTP ${r.status}`);
    return body;
  } finally {
    clearTimeout(t);
  }
}

function freshness(id: SourceId, newest?: string): Freshness {
  if (!newest) return 'latest';
  const h = (Date.now() - new Date(newest).getTime()) / 3600e3;
  const live = id === 'thaiwater_wl' || id === 'thaiwater_rain' || id === 'air4thai';
  if (live) return h <= 3 ? 'live' : h <= 24 ? 'latest' : 'stale';
  if (id === 'firms' || id === 'usgs') return h <= 12 ? 'nrt' : 'latest';
  return 'latest';
}

// ---------------------------------------------------------------- adapters

export interface FetchResult {
  events: DEvent[];
  bulletins: Bulletin[];
  hotspots: { lat: number; lon: number; time: string; frp: number; conf: string; sat: string; daynight: string }[];
  stations: { kind: 'wl' | 'rain' | 'pm'; lat: number; lon: number; value: number; level?: number; name: string; time: string; province?: string }[];
  state: SourceState;
}
const empty = (id: SourceId): FetchResult => ({ events: [], bulletins: [], hotspots: [], stations: [], state: { id, status: 'idle', count: 0, freshness: 'unavailable' } });

async function usgs(days: number): Promise<FetchResult> {
  const out = empty('usgs');
  const start = new Date(Date.now() - Math.min(days, 30) * 86400e3).toISOString().slice(0, 19);
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlatitude=4&maxlatitude=24&minlongitude=95&maxlongitude=107&starttime=${start}&minmagnitude=2.5&orderby=time`;
  const j = await getJson(url);
  const f = nowIso();
  for (const ft of j.features ?? []) {
    const p = ft.properties, [lon, lat, depth] = ft.geometry.coordinates;
    const m = +p.mag;
    out.events.push({
      id: `usgs:${ft.id}`, source: 'usgs', sourceId: ft.id, hazard: 'quake',
      title: `M${m.toFixed(1)} — ${p.place ?? ''}`, lat, lon, time: new Date(p.time).toISOString(), reported: new Date(p.updated).toISOString(), fetchedAt: f,
      status: p.status === 'reviewed' ? 'confirmed' : 'reported',
      severity: m >= 6 ? 3 : m >= 5 ? 2 : m >= 4 ? 1 : 0, severityText: `M${m.toFixed(1)} ${p.magType ?? ''}`.trim(),
      url: p.url, details: { magnitude: m, depth_km: +(+depth).toFixed(1), mag_type: p.magType ?? null, felt_reports: p.felt ?? null, tsunami_flag: p.tsunami ?? 0, review: p.status },
    });
  }
  out.state = { id: 'usgs', status: 'ok', fetchedAt: f, upstreamTime: j.metadata?.generated ? new Date(j.metadata.generated).toISOString() : undefined, count: out.events.length, freshness: 'nrt' };
  return out;
}

async function firms(days: number): Promise<FetchResult> {
  const out = empty('firms');
  const period = days <= 1 ? '24h' : days <= 2 ? '48h' : '7d';
  const j = await getJson(`/api/feeds?src=firms&period=${period}`, 40000);
  const lines: string[] = String(j.csv ?? '').split('\n');
  const head = lines[0].split(',');
  const ix = (k: string) => head.indexOf(k);
  const iLat = ix('latitude'), iLon = ix('longitude'), iD = ix('acq_date'), iT = ix('acq_time'), iF = ix('frp'), iC = ix('confidence'), iS = ix('sensor'), iDN = ix('daynight');
  for (const l of lines.slice(1)) {
    const c = l.split(',');
    if (c.length < head.length - 1) continue;
    const t = String(c[iT]).padStart(4, '0');
    out.hotspots.push({ lat: +c[iLat], lon: +c[iLon], time: `${c[iD]}T${t.slice(0, 2)}:${t.slice(2)}:00Z`, frp: +c[iF], conf: c[iC], sat: c[iS], daynight: c[iDN] });
  }
  // clusters: hotspots within ~2 km chain together (grid of 0.02°); clusters of ≥ 3 become events
  const cell = (v: number) => Math.floor(v / 0.02);
  const grid = new Map<string, number[]>();
  out.hotspots.forEach((h, i) => {
    const k = `${cell(h.lon)},${cell(h.lat)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  });
  const seen = new Uint8Array(out.hotspots.length);
  const f = nowIso();
  out.hotspots.forEach((h0, i0) => {
    if (seen[i0]) return;
    const members: number[] = [];
    const stack = [i0];
    seen[i0] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      members.push(i);
      const h = out.hotspots[i];
      const cx = cell(h.lon), cy = cell(h.lat);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const j2 of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (seen[j2]) continue;
            const o = out.hotspots[j2];
            if (Math.abs(o.lat - h.lat) < 0.02 && Math.abs(o.lon - h.lon) < 0.02) {
              seen[j2] = 1;
              stack.push(j2);
            }
          }
    }
    if (members.length < 3) return;
    const pts = members.map((m) => out.hotspots[m]);
    const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length, lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
    const times = pts.map((p) => p.time).sort();
    const frp = Math.max(...pts.map((p) => p.frp));
    const xs = pts.map((p) => p.lon), ys = pts.map((p) => p.lat);
    out.events.push({
      id: `firms:${lat.toFixed(3)},${lon.toFixed(3)}:${times[0]}`, source: 'firms', sourceId: `${period}:${lat.toFixed(3)},${lon.toFixed(3)}`, hazard: 'fire',
      title: `กลุ่มจุดความร้อน ${pts.length} จุด`, lat, lon, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      time: times[times.length - 1], fetchedAt: f, status: 'reported',
      severity: pts.length >= 30 ? 3 : pts.length >= 10 ? 2 : 1, severityText: `${pts.length} hotspots · max FRP ${frp.toFixed(0)} MW`,
      url: 'https://firms.modaps.eosdis.nasa.gov/map/', points: pts.map((p) => [p.lon, p.lat]),
      details: { hotspots: pts.length, first_detection: times[0], last_detection: times[times.length - 1], max_frp_mw: +frp.toFixed(1), high_conf: pts.filter((p) => p.conf === 'h').length, sensors: [...new Set(pts.map((p) => p.sat))].join(', ') },
    });
  });
  const newest = out.hotspots.map((h) => h.time).sort().pop();
  out.state = { id: 'firms', status: 'ok', fetchedAt: j.fetchedAt ?? f, upstreamTime: newest, count: out.hotspots.length, freshness: freshness('firms', newest), message: `${period} · ${out.hotspots.length} hotspots, ${out.events.length} clusters ≥ 3` };
  return out;
}

async function thaiwaterWl(): Promise<FetchResult> {
  const out = empty('thaiwater_wl');
  const j = await getJson('https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load', 30000);
  const f = nowIso();
  const rows: any[] = j?.waterlevel_data?.data ?? [];
  for (const r of rows) {
    const lat = +r.station?.tele_station_lat, lon = +r.station?.tele_station_long;
    if (!lat || !lon) continue;
    const lv = r.situation_level as number | undefined;
    const pct = r.storage_percent != null ? +r.storage_percent : NaN;
    const name = r.station?.tele_station_name?.th ?? r.station?.tele_station_name?.en ?? '';
    const prov = r.geocode?.province_name?.en ?? undefined;
    out.stations.push({ kind: 'wl', lat, lon, value: pct, level: lv, name, time: bkk(r.waterlevel_datetime), province: prov });
    if (lv === 5 || lv === 1) {
      out.events.push({
        id: `twl:${r.station?.id}`, source: 'thaiwater_wl', sourceId: String(r.station?.id ?? r.id), hazard: lv === 5 ? 'flood' : 'drought',
        title: `${lv === 5 ? 'น้ำล้นตลิ่ง' : 'น้ำน้อยวิกฤติ'} — สถานี${name}`, lat, lon, time: bkk(r.waterlevel_datetime), fetchedAt: f, status: 'confirmed',
        severity: lv === 5 ? (pct >= 120 ? 3 : 2) : 1, severityText: `${Number.isFinite(pct) ? pct.toFixed(0) : '—'}% ของความจุลำน้ำ (ระดับตลิ่ง)`,
        url: 'https://www.thaiwater.net/water/wl', province: prov,
        details: { station: name, river_capacity_pct: Number.isFinite(pct) ? +pct.toFixed(1) : null, water_level_msl_m: r.waterlevel_msl != null ? +r.waterlevel_msl : null, previous_msl_m: r.waterlevel_msl_previous != null ? +r.waterlevel_msl_previous : null, bank_left_m: r.station?.left_bank ?? null, bank_right_m: r.station?.right_bank ?? null, basin: r.basin?.basin_name?.th ?? null, amphoe: r.geocode?.amphoe_name?.th ?? null, agency: r.agency?.agency_shortname?.th ?? null },
      });
    }
  }
  const newest = out.stations.map((s) => s.time).sort().pop();
  out.state = { id: 'thaiwater_wl', status: 'ok', fetchedAt: f, upstreamTime: newest, count: out.stations.length, freshness: freshness('thaiwater_wl', newest), message: `${out.events.filter((e) => e.hazard === 'flood').length} overflowing · ${out.events.filter((e) => e.hazard === 'drought').length} critically low` };
  return out;
}

async function thaiwaterRain(): Promise<FetchResult> {
  const out = empty('thaiwater_rain');
  const j = await getJson('https://api-v3.thaiwater.net/api/v1/thaiwater30/public/rain_24h', 40000);
  const f = nowIso();
  for (const r of j?.data ?? []) {
    const mm = +r.rain_24h;
    const lat = +r.station?.tele_station_lat, lon = +r.station?.tele_station_long;
    if (!lat || !lon || !(mm >= 35.1)) continue;
    const name = r.station?.tele_station_name?.th ?? '';
    const prov = r.geocode?.province_name?.en;
    out.stations.push({ kind: 'rain', lat, lon, value: mm, name, time: bkk(r.rainfall_datetime), province: prov });
    if (mm >= 90.1)
      out.events.push({
        id: `trn:${r.station?.id}`, source: 'thaiwater_rain', sourceId: String(r.station?.id ?? r.id), hazard: 'storm',
        title: `ฝนหนักมาก ${mm.toFixed(1)} มม./24 ชม. — ${name}`, lat, lon, time: bkk(r.rainfall_datetime), fetchedAt: f, status: 'confirmed',
        severity: mm >= 150 ? 3 : 2, severityText: `${mm.toFixed(1)} mm / 24 h`, url: 'https://www.thaiwater.net/water/rain', province: prov,
        details: { station: name, rain_24h_mm: mm, rain_1h_mm: r.rain_1h ?? null, amphoe: r.geocode?.amphoe_name?.th ?? null, agency: r.agency?.agency_shortname?.th ?? null },
      });
  }
  const newest = out.stations.map((s) => s.time).sort().pop();
  out.state = { id: 'thaiwater_rain', status: 'ok', fetchedAt: f, upstreamTime: newest, count: out.stations.length, freshness: freshness('thaiwater_rain', newest), message: `${out.stations.length} stations ≥ 35.1 mm · ${out.events.length} ≥ 90.1 mm` };
  return out;
}

async function thaiwaterWarn(): Promise<FetchResult> {
  const out = empty('thaiwater_warn');
  const j = await getJson('https://api-v3.thaiwater.net/api/v1/thaiwater30/public/warning');
  for (const r of j?.data ?? []) out.bulletins.push({ source: 'thaiwater_warn', time: bkk(r.datetime), text: String(r.message ?? '').trim(), url: 'https://www.thaiwater.net' });
  out.state = { id: 'thaiwater_warn', status: 'ok', fetchedAt: nowIso(), upstreamTime: out.bulletins[0]?.time, count: out.bulletins.length, freshness: freshness('thaiwater_wl', out.bulletins[0]?.time) };
  return out;
}

async function air4thai(): Promise<FetchResult> {
  const out = empty('air4thai');
  const j = await getJson('/api/feeds?src=air4thai', 30000);
  const d = JSON.parse(j.body);
  const f = j.fetchedAt ?? nowIso();
  for (const s of d.stations ?? []) {
    const pm = s.AQILast?.PM25?.value != null ? +s.AQILast.PM25.value : NaN;
    const lat = +s.lat, lon = +s.long;
    if (!Number.isFinite(pm) || pm < 0 || !lat || !lon) continue;
    const t = s.AQILast?.date && s.AQILast?.time ? bkk(`${s.AQILast.date} ${s.AQILast.time}`) : f;
    out.stations.push({ kind: 'pm', lat, lon, value: pm, name: s.nameTH ?? s.stationID, time: t });
    if (pm > 75)
      out.events.push({
        id: `pm:${s.stationID}`, source: 'air4thai', sourceId: String(s.stationID), hazard: 'air', title: `PM2.5 ${pm.toFixed(0)} µg/m³ — ${s.nameTH ?? ''}`,
        lat, lon, time: t, fetchedAt: f, status: 'confirmed', severity: pm > 150 ? 3 : 2, severityText: `${pm.toFixed(0)} µg/m³ (มาตรฐาน 24 ชม. 37.5)`,
        url: 'http://air4thai.pcd.go.th/webV3/', details: { station: s.nameTH ?? null, area: s.areaTH ?? null, pm25_ugm3: pm, aqi: s.AQILast?.AQI?.aqi ?? null },
      });
  }
  const newest = out.stations.map((s) => s.time).sort().pop();
  out.state = { id: 'air4thai', status: 'ok', fetchedAt: f, upstreamTime: newest, count: out.stations.length, freshness: freshness('air4thai', newest), message: `${out.events.length} stations > 75 µg/m³` };
  return out;
}

const GD: Record<string, Hazard> = { EQ: 'quake', TC: 'storm', FL: 'flood', DR: 'drought', WF: 'fire', VO: 'other' };
async function gdacs(): Promise<FetchResult> {
  const out = empty('gdacs');
  const j = await getJson('/api/feeds?src=gdacs', 30000);
  const d = JSON.parse(j.body);
  const f = j.fetchedAt ?? nowIso();
  for (const ft of d.features ?? []) {
    const p = ft.properties ?? {};
    const [lon, lat] = ft.geometry?.coordinates ?? [];
    if (lat == null) continue;
    const al = String(p.alertlevel ?? '').toLowerCase();
    out.events.push({
      id: `gdacs:${p.eventtype}${p.eventid}`, source: 'gdacs', sourceId: `${p.eventtype}${p.eventid}`, hazard: GD[p.eventtype] ?? 'other',
      title: p.name || p.description || `${p.eventtype} ${p.eventid}`, lat, lon, time: new Date(p.fromdate).toISOString(), reported: p.datemodified ? new Date(p.datemodified).toISOString() : undefined, fetchedAt: f,
      status: String(p.iscurrent) === 'false' ? 'closed' : 'reported', severity: al === 'red' ? 3 : al === 'orange' ? 2 : 1, severityText: `GDACS ${p.alertlevel ?? ''} alert`,
      url: p.url?.report ?? `https://www.gdacs.org/report.aspx?eventtype=${p.eventtype}&eventid=${p.eventid}`,
      details: { country: p.country ?? null, alert: p.alertlevel ?? null, from: p.fromdate ?? null, to: p.todate ?? null, severity: p.severitydata?.severitytext ?? null },
    });
  }
  out.state = { id: 'gdacs', status: 'ok', fetchedAt: f, count: out.events.length, freshness: 'latest' };
  return out;
}

async function tmd(): Promise<FetchResult> {
  const out = empty('tmd');
  const j = await getJson('/api/feeds?src=tmd', 30000);
  const d = JSON.parse(j.body);
  const w = d.Warning ?? d.Warnings?.Warning ?? [];
  const items: any[] = Array.isArray(w) ? w : w && typeof w === 'object' && Object.keys(w).length ? [w] : [];
  for (const it of items) {
    const title = it.TitleThai ?? it.TitleEnglish;
    if (!title) continue;
    const head = it.HeadlineThai ?? it.HeadlineEnglish ?? '';
    const span = it.EffectStartDate ? ` (มีผล ${String(it.EffectStartDate).slice(0, 16)} – ${String(it.EffectEndDate ?? '').slice(0, 16)})` : '';
    out.bulletins.push({ source: 'tmd', time: it.AnnounceDate ? bkk(String(it.AnnounceDate).slice(0, 16)) : j.fetchedAt, text: `${String(title).trim()}${span}${head ? ` — ${String(head).trim()}` : ''}`, url: it.WebUrlThai ?? 'https://www.tmd.go.th' });
  }
  const built = d.header?.lastBuildDate ? bkk(String(d.header.lastBuildDate).slice(0, 16)) : undefined;
  out.state = { id: 'tmd', status: 'ok', fetchedAt: j.fetchedAt, upstreamTime: built, count: out.bulletins.length, freshness: 'latest', message: out.bulletins.length ? undefined : 'No warning in force' };
  return out;
}

async function cems(): Promise<FetchResult> {
  const out = empty('cems');
  const j = await getJson('/api/feeds?src=cems', 30000);
  const d = JSON.parse(j.body);
  const list: any[] = d.results ?? d.activations ?? (Array.isArray(d) ? d : []);
  for (const a of list) {
    const txt = JSON.stringify(a);
    if (!/thailand/i.test(txt)) continue;
    const code = a.code ?? a.activationCode ?? a.id;
    out.bulletins.push({ source: 'cems', time: new Date(a.activationTime ?? a.eventTime ?? a.created ?? Date.now()).toISOString(), text: `${code ?? ''} ${a.name ?? a.title ?? ''}`.trim(), url: code ? `https://rapidmapping.emergency.copernicus.eu/${code}` : 'https://rapidmapping.emergency.copernicus.eu' });
  }
  out.state = { id: 'cems', status: 'ok', fetchedAt: j.fetchedAt, count: out.bulletins.length, freshness: 'latest', message: out.bulletins.length ? `${out.bulletins.length} activation(s) mentioning Thailand` : 'No activations for Thailand in the latest list' };
  return out;
}
const ADAPTERS: Partial<Record<SourceId, (days: number) => Promise<FetchResult>>> = {
  thaiwater_wl: () => thaiwaterWl(),
  thaiwater_rain: () => thaiwaterRain(),
  thaiwater_warn: () => thaiwaterWarn(),
  firms: (d) => firms(d),
  usgs: (d) => usgs(d),
  gdacs: () => gdacs(),
  air4thai: () => air4thai(),
  tmd: () => tmd(),
  cems: () => cems(),
};

export interface Snapshot {
  events: DEvent[];
  bulletins: Bulletin[];
  hotspots: FetchResult['hotspots'];
  stations: FetchResult['stations'];
  states: Record<string, SourceState>;
  provinces: Province[] | null;
  at: string;
  days: number;
}

/** Fetch every connected source in parallel; a failing source never blocks the others. */
export async function fetchAll(days: number, onState?: (s: SourceState) => void): Promise<Snapshot> {
  const provinces = await loadProvinces().catch(() => null);
  const states: Record<string, SourceState> = {};
  REGISTRY.forEach((r) => {
    if (r.access === 'none') states[r.id] = { id: r.id, status: 'no-api', count: 0, freshness: 'unavailable', message: r.terms };
    else if (r.id === 'gistda') states[r.id] = { id: r.id, status: 'needs-key', count: 0, freshness: 'unavailable', message: r.terms };
    else if (!ADAPTERS[r.id]) states[r.id] = { id: r.id, status: 'idle', count: 0, freshness: 'historical', message: r.note ?? r.terms };
  });
  const results = await Promise.all(
    (Object.keys(ADAPTERS) as SourceId[]).map(async (id) => {
      onState?.({ id, status: 'loading', count: 0, freshness: 'unavailable' });
      try {
        const r = await ADAPTERS[id]!(days);
        onState?.(r.state);
        return r;
      } catch (e: any) {
        const st: SourceState = { id, status: 'error', count: 0, fetchedAt: nowIso(), freshness: 'unavailable', message: e?.name === 'AbortError' ? 'timed out' : e?.message ?? String(e) };
        onState?.(st);
        return { ...empty(id), state: st };
      }
    }),
  );
  results.forEach((r) => (states[r.state.id] = r.state));
  let events = results.flatMap((r) => r.events);
  // province for every event (Thai sources already carry it; fill the rest by point-in-polygon)
  if (provinces) for (const e of events) if (!e.province) e.province = provinceAt(provinces, e.lon, e.lat)?.en;
  // de-duplicate: a GDACS earthquake that matches a USGS event (≤ 100 km, ≤ 10 min) is folded into it
  const quakes = events.filter((e) => e.source === 'usgs');
  events = events.filter((e) => {
    if (e.source !== 'gdacs' || e.hazard !== 'quake') return true;
    const m = quakes.find((q) => Math.abs(new Date(q.time).getTime() - new Date(e.time).getTime()) < 600e3 && Math.hypot(q.lat - e.lat, q.lon - e.lon) < 0.9);
    if (m) {
      m.alsoIn = [...(m.alsoIn ?? []), `GDACS ${e.severityText}`];
      return false;
    }
    return true;
  });
  // time window
  const cutoff = Date.now() - days * 86400e3;
  events = events.filter((e) => e.status !== 'closed' ? new Date(e.time).getTime() >= cutoff || e.source === 'gdacs' : new Date(e.time).getTime() >= cutoff);
  events.sort((a, b) => b.severity - a.severity || b.time.localeCompare(a.time));
  return {
    events,
    bulletins: results.flatMap((r) => r.bulletins).sort((a, b) => b.time.localeCompare(a.time)),
    hotspots: results.flatMap((r) => r.hotspots),
    stations: results.flatMap((r) => r.stations),
    states,
    provinces,
    at: nowIso(),
    days,
  };
}

export const hazardOf = (h: Hazard) => HAZARDS.find((x) => x.id === h)!;
export const provinceLabel = (en?: string) => (en ? thProvince(en) : 'นอกประเทศไทย / ไม่ระบุ');

export const STATUS_TH: Record<EvStatus, string> = { confirmed: 'ยืนยันจากการตรวจวัด', reported: 'รายงาน / ตรวจพบ', unverified: 'ยังไม่ยืนยัน', closed: 'สิ้นสุดแล้ว' };
export const FRESH_TH: Record<Freshness, string> = { live: 'สด (Live)', nrt: 'ใกล้เวลาจริง (NRT)', latest: 'ล่าสุดที่มี', historical: 'ย้อนหลัง', stale: 'ข้อมูลเก่า (Stale)', unavailable: 'เข้าถึงไม่ได้', insufficient: 'ข้อมูลไม่พอ' };
