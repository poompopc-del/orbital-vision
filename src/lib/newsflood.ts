// Flood news → places → satellite check.
//
// 1. Collect flood news from open feeds (Google News search across Thai outlets, government
//    sites on *.go.th, GDELT, ReliefWeb) through /api/news.
// 2. Read place names written in each story (ตำบล/อำเภอ/จังหวัด, ต./อ./จ., province names) and look
//    them up (OpenStreetMap Nominatim). A located point is accepted only if it falls inside the
//    province the story names — otherwise it is dropped, never guessed.
// 3. Group stories by place; each place can then be checked with the latest radar/optical images.
//
// Honesty rules: the place comes from the text of the story, not from the photo. Photos are shown
// as published; placing a photo is left to the analyst (manual pin), and is labelled as such.
import { centroid as turfCentroid } from '@turf/turf';
import { loadProvinces, provinceAt, PROVINCE_TH, type Province } from './provinces';

export type FeedId = 'gnews' | 'gnews_gov' | 'gdelt' | 'reliefweb' | 'manual';
export type Precision = 'tambon' | 'amphoe' | 'province' | 'pin';

export interface NewsArticle {
  id: string;
  feed: FeedId;
  title: string;
  link: string;
  outlet: string;
  published: string | null;
  summary?: string;
  image?: string | null;
  /** full text read from the publisher page (when it could be read) */
  text?: string;
  realUrl?: string;
  readState?: 'ok' | 'failed';
  places: PlaceRef[];
}

export interface PlaceRef {
  province: string; // English name as in PROVINCE_TH keys
  amphoe?: string;
  tambon?: string;
  precision: Precision;
  /** the words in the story the place was read from */
  quote: string;
}

export interface NewsPlace {
  key: string;
  labelTh: string;
  province: string;
  amphoe?: string;
  tambon?: string;
  precision: Precision;
  lat: number;
  lon: number;
  bbox?: [number, number, number, number];
  geocoder: string;
  articleIds: string[];
}

export interface FeedState {
  id: FeedId;
  label: string;
  status: 'loading' | 'ok' | 'error';
  count: number;
  error?: string;
  source?: string;
  fetchedAt?: string;
}

export const FEEDS: { id: Exclude<FeedId, 'manual'>; label: string; labelTh: string; note: string }[] = [
  { id: 'gnews', label: 'Google News — Thai outlets', labelTh: 'Google News — สำนักข่าวไทย', note: 'ค้นข่าวภาษาไทยจากทุกสำนักข่าว (ไทยรัฐ, Thai PBS, มติชน, ข่าวสด, ฯลฯ)' },
  { id: 'gnews_gov', label: 'Google News — government (*.go.th)', labelTh: 'เว็บไซต์หน่วยงานรัฐ (*.go.th)', note: 'ปภ., กรมประชาสัมพันธ์, กรมอุตุฯ, สำนักงานจังหวัด ฯลฯ' },
  { id: 'gdelt', label: 'GDELT Project', labelTh: 'GDELT (ฐานข่าวทั่วโลก)', note: 'ข่าวที่เผยแพร่จากประเทศไทย พร้อมภาพประกอบข่าว · จำกัดความถี่การเรียก' },
];

// ---------------------------------------------------------------- place extraction

const ALIAS: Record<string, string> = {
  กทม: 'Bangkok', กรุงเทพฯ: 'Bangkok', กรุงเทพ: 'Bangkok', โคราช: 'Nakhon Ratchasima', อยุธยา: 'Phra Nakhon Si Ayutthaya', กรุงเก่า: 'Phra Nakhon Si Ayutthaya',
  'นครศรีฯ': 'Nakhon Si Thammarat', 'สุราษฎร์ฯ': 'Surat Thani', 'อุบลฯ': 'Ubon Ratchathani', 'อุบล': 'Ubon Ratchathani', 'ปทุมฯ': 'Pathum Thani', 'สมุทรปราการฯ': 'Samut Prakan',
  'ลพบุรี': 'Lopburi', 'พังงา': 'Phangnga', 'ชลบุรี': 'Chon Buri', 'บุรีรัมย์': 'Buri Ram', 'ศรีสะเกษ': 'Si Sa Ket', 'หนองบัวลำภู': 'Nong Bua Lam Phu',
};
// Short names that are also everyday Thai words — accepted only after จ./จังหวัด
const AMBIGUOUS = new Set(['เลย', 'ตาก', 'แพร่', 'ตรัง', 'น่าน', 'ระนอง', 'สตูล', 'ยะลา', 'พะเยา']);

const TH_TO_EN: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  Object.entries(PROVINCE_TH).forEach(([en, th]) => (m[th] = en));
  Object.entries(ALIAS).forEach(([th, en]) => (m[th] = en));
  return m;
})();
const NAMES = Object.keys(TH_TO_EN).sort((a, b) => b.length - a.length);

const STOP = new Set(['เมื่อ', 'ที่', 'และ', 'ใน', 'ของ', 'ซึ่ง', 'ได้', 'ไป', 'มา', 'นี้', 'ดังกล่าว', 'ต่างๆ', 'ฯลฯ']);

/** Put a space before each admin marker so names written without spaces separate cleanly. */
function prep(text: string) {
  return (' ' + text + ' ')
    .replace(/\s+/g, ' ')
    .replace(/(ตำบล|อำเภอ|จังหวัด|แขวง|เขต(?=[ก-๙])|ต\.(?=\s?[ก-๙])|อ\.(?=\s?[ก-๙])|จ\.(?=\s?[ก-๙])|ม\.(?=\s?\d)|หมู่ที่)/g, ' $1')
    .replace(/([ก-๙])\(/g, '$1 (');
}

interface Mark {
  kind: 't' | 'a' | 'p';
  name: string;
  at: number;
  end: number;
  en?: string;
}

function marks(t: string): Mark[] {
  const out: Mark[] = [];
  const re = /(?:^|[\s(])(ตำบล|แขวง|ต\.|อำเภอ|เขต|อ\.|จังหวัด|จ\.)\s?([ก-๙]{2,40})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const k = m[1];
    // Thai is written without spaces, so a name can run into the next word ("อ.ลาดกระบังและ…")
    let name = m[2].replace(/(และ|รวมถึง|ตลอดจน|ซึ่ง|ที่มี|ที่|ใน|ของ|ได้รับ|ได้|ส่วน|โดย|เป็น|มี|จน|ทำให้|ถูก|ประสบ|เกิด|น้ำท่วม|ท่วม|ล่าสุด)$/, '');
    if (STOP.has(name) || /^(ตำบล|อำเภอ|จังหวัด|แขวง|เขต|พื้นที่)/.test(name)) {
      re.lastIndex = m.index + m[0].length - name.length - 1; // let the inner marker be read
      continue;
    }
    const kind: Mark['kind'] = /^(ตำบล|แขวง|ต\.)$/.test(k) ? 't' : /^(อำเภอ|เขต|อ\.)$/.test(k) ? 'a' : 'p';
    if (kind === 'p') {
      const hit = NAMES.find((n) => name.startsWith(n));
      if (!hit) continue;
      out.push({ kind, name: hit, at: m.index, end: m.index + m[0].length, en: TH_TO_EN[hit] });
    } else {
      // strip a trailing province name glued on ("อ.บางบาลพระนครศรีอยุธยา" is rare but happens)
      // a province name glued on the end: "อำเภอเมืองอ่างทอง" (Mueang district keeps its full name)
      // or "อ.บางบาลพระนครศรีอยุธยา" (rare) — either way the province is recorded as well
      const glued = NAMES.find((n) => name.length > n.length + 1 && name.endsWith(n) && !AMBIGUOUS.has(n));
      const end = m.index + m[0].length;
      if (glued) {
        if (!name.startsWith('เมือง')) name = name.slice(0, -glued.length);
        out.push({ kind, name, at: m.index, end: end - glued.length });
        out.push({ kind: 'p', name: glued, at: end - glued.length, end, en: TH_TO_EN[glued] });
      } else out.push({ kind, name, at: m.index, end });
    }
  }
  // bare province names (no จ. prefix)
  for (const n of NAMES) {
    if (AMBIGUOUS.has(n)) continue;
    let i = t.indexOf(n);
    while (i >= 0) {
      if (!out.some((o) => i >= o.at && i < o.end)) out.push({ kind: 'p', name: n, at: i, end: i + n.length, en: TH_TO_EN[n] });
      i = t.indexOf(n, i + n.length);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Read the places a story names. Districts are tied to the next province named within ~80 characters,
 *  or to the story's only province when it names just one. */
export function extractPlaces(text: string): PlaceRef[] {
  const t = prep(text);
  const ms = marks(t);
  const provs = [...new Set(ms.filter((m) => m.kind === 'p').map((m) => m.en!))];
  const used = new Set<Mark>();
  const refs: PlaceRef[] = [];
  // province for a district: the next one named within ~90 characters, or the story's only one;
  // with the gazetteer loaded, the province (among those the story names) where that district exists
  const provinceFor = (from: number, amp?: string, tam?: string, within = 90) => {
    const p = ms.find((m) => m.kind === 'p' && m.at >= from && m.at - from <= within);
    if (gazNow && (amp || tam)) {
      const order = [...(p ? [p.en!] : []), ...provs.filter((x) => x !== p?.en)];
      const ok = order.find((en) => exists(gazNow!, en, amp, tam));
      if (ok) {
        const pm = ms.find((m) => m.kind === 'p' && m.en === ok && m.at >= from);
        if (pm) used.add(pm);
        return ok;
      }
      return null;
    }
    if (p) {
      used.add(p);
      return p.en!;
    }
    return provs.length === 1 ? provs[0] : null;
  };
  ms.forEach((m, i) => {
    if (used.has(m) || m.kind === 'p') return;
    if (m.kind === 't') {
      const a = ms.slice(i + 1).find((x) => x.kind === 'a' && x.at - m.end <= 40);
      const p = provinceFor(a ? a.end : m.end, a?.name, m.name);
      if (!p) return;
      used.add(m);
      if (a) used.add(a);
      refs.push({ province: p, tambon: m.name, amphoe: a?.name, precision: 'tambon', quote: t.slice(m.at, Math.min(t.length, (a ?? m).end + 40)).trim().slice(0, 120) });
    } else {
      const p = provinceFor(m.end, m.name);
      if (!p) return;
      used.add(m);
      refs.push({ province: p, amphoe: m.name, precision: 'amphoe', quote: t.slice(m.at, Math.min(t.length, m.end + 40)).trim().slice(0, 120) });
    }
  });
  provs.forEach((p) => {
    if (!refs.some((r) => r.province === p)) {
      const m = ms.find((x) => x.kind === 'p' && x.en === p)!;
      refs.push({ province: p, precision: 'province', quote: t.slice(Math.max(0, m.at - 30), m.end + 30).trim() });
    }
  });
  // a story listing many provinces (forecasts, nationwide round-ups) does not locate a flood;
  // keep only the places it names at district level
  const wide = refs.filter((r) => r.precision === 'province').length > 4;
  // de-duplicate
  const seen = new Set<string>();
  return refs.filter((r) => {
    if (wide && r.precision === 'province') return false;
    const k = placeKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const placeKey = (r: { province: string; amphoe?: string; tambon?: string }) => [r.province, r.amphoe ?? '', r.tambon ?? ''].join('|');
export const placeLabel = (r: { province: string; amphoe?: string; tambon?: string }) =>
  [r.tambon && `ต.${r.tambon}`, r.amphoe && `อ.${r.amphoe}`, `จ.${PROVINCE_TH[r.province] ?? r.province}`].filter(Boolean).join(' ');

// ---------------------------------------------------------------- geocoding

const GEO_KEY = 'ov.newsGeo.v1';
type GeoHit = { lat: number; lon: number; bbox?: [number, number, number, number]; name: string } | null;
const geoCache: Record<string, GeoHit> = (() => {
  try {
    return JSON.parse(localStorage.getItem(GEO_KEY) || '{}');
  } catch {
    return {};
  }
})();
const saveGeo = () => {
  try {
    localStorage.setItem(GEO_KEY, JSON.stringify(geoCache));
  } catch {
    /* ignore */
  }
};
let lastCall = 0;
async function nominatim(q: string): Promise<{ name: string; lat: number; lon: number; bbox?: number[]; type?: string }[]> {
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const r = await fetch(`/api/news?src=geocode&q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(`geocoder HTTP ${r.status}`);
  return (await r.json()).results ?? [];
}


// Offline gazetteer of Thailand's 7,367 tambon and 928 amphoe with Thai names, centroids and extents
// (OpenGISData-Thailand, CC BY 4.0) — instant and exact; Nominatim is only the fallback.
interface Gaz {
  source: string;
  p: string[];
  t: [string, string, number, number, number, number, number, number, number][];
  a: [string, number, number, number, number, number, number, number][];
}
let gazP: Promise<Gaz> | null = null;
let gazNow: Gaz | null = null;
export const loadGaz = () =>
  (gazP ??= fetch('/gazetteer-th.json').then(async (r) => {
    if (!r.ok) throw new Error(`gazetteer HTTP ${r.status}`);
    return (gazNow = await r.json()) as Gaz;
  }).catch((e) => {
    gazP = null;
    throw e;
  }));
const norm = (s: string) => s.replace(/^(อำเภอ|ตำบล|แขวง|เขต|กิ่งอำเภอ)/, '').replace(/\s+/g, '');

function fromGaz(g: Gaz, ref: PlaceRef): (GeoHit & { level: 'tambon' | 'amphoe' }) | null {
  const th = PROVINCE_TH[ref.province];
  const pi = g.p.indexOf(th);
  if (pi < 0) return null;
  let amp = ref.amphoe ? norm(ref.amphoe) : '';
  if (amp === 'เมือง') amp = `เมือง${th}`;
  const ampHit = amp ? g.a.find((x) => x[1] === pi && (x[0] === amp || x[0] === `เมือง${amp}`)) : undefined;
  if (ref.tambon) {
    const tam = norm(ref.tambon);
    const cands = g.t.filter((x) => x[2] === pi && x[0] === tam);
    const t = (ampHit ? cands.find((x) => x[1] === ampHit[0]) : undefined) ?? (cands.length === 1 || !amp ? cands[0] : undefined);
    if (t) return { lat: t[3], lon: t[4], bbox: [t[5], t[6], t[7], t[8]], name: `ต.${t[0]} อ.${t[1]} จ.${th}`, level: 'tambon' };
  }
  if (ampHit) return { lat: ampHit[2], lon: ampHit[3], bbox: [ampHit[4], ampHit[5], ampHit[6], ampHit[7]], name: `อ.${ampHit[0]} จ.${th}`, level: 'amphoe' };
  return null;
}

function exists(g: Gaz, provEn: string, amp?: string, tam?: string) {
  const ref: PlaceRef = { province: provEn, amphoe: amp, tambon: tam, precision: tam ? 'tambon' : 'amphoe', quote: '' };
  const h = fromGaz(g, ref);
  return !!h && (!tam || h.level === 'tambon' || !!amp);
}

export const GAZ_LABEL = 'ทำเนียบตำบล/อำเภอ (OpenGISData-Thailand)';

/** Locate a place. The result must lie inside the named province; otherwise null. */
export async function geocode(ref: PlaceRef, provinces: Province[]): Promise<GeoHit & { via?: string; level?: Precision }> {
  const key = placeKey(ref);
  const prov = provinces.find((p) => p.en === ref.province);
  if (!prov) return null;
  if (ref.precision === 'province') {
    const [lon, lat] = turfCentroid(prov.geometry as any).geometry.coordinates;
    return { lat, lon, bbox: prov.bbox, name: `จังหวัด${prov.th}`, via: 'ขอบเขตจังหวัด (geoBoundaries)', level: 'province' };
  }
  const g = await loadGaz().catch(() => null);
  const hit = g ? fromGaz(g, ref) : null;
  if (hit) return { ...hit, via: GAZ_LABEL, level: hit.level };
  // the gazetteer lists every tambon and amphoe, so a miss means the name/province pair in the
  // story does not exist — do not guess. Nominatim is used only when the gazetteer is unavailable.
  if (g) return null;
  if (key in geoCache) return geoCache[key] ? { ...geoCache[key]!, via: 'OpenStreetMap Nominatim' } : null;
  let out: GeoHit = null;
  const isBkk = ref.province === 'Bangkok';
  const queries: string[] = [];
  if (ref.tambon) queries.push(`${isBkk ? 'แขวง' : 'ตำบล'}${norm(ref.tambon)} ${ref.amphoe ? `${isBkk ? 'เขต' : 'อำเภอ'}${norm(ref.amphoe)} ` : ''}${isBkk ? 'กรุงเทพมหานคร' : 'จังหวัด' + prov.th}`);
  if (ref.amphoe) queries.push(`${isBkk ? 'เขต' : 'อำเภอ'}${norm(ref.amphoe)} ${isBkk ? 'กรุงเทพมหานคร' : 'จังหวัด' + prov.th}`);
  for (const q of queries) {
    const res = await nominatim(q).catch(() => []);
    const ok = res.find((x) => provinceAt([prov], x.lon, x.lat));
    if (ok) {
      const b = ok.bbox; // [s, n, w, e]
      out = { lat: ok.lat, lon: ok.lon, bbox: b && b.length === 4 ? [b[2], b[0], b[3], b[1]] : undefined, name: ok.name };
      break;
    }
  }
  geoCache[key] = out;
  saveGeo();
  return out ? { ...out, via: 'OpenStreetMap Nominatim' } : null;
}

// ---------------------------------------------------------------- feeds

async function feed(id: Exclude<FeedId, 'manual'>, days: number): Promise<{ items: NewsArticle[]; source?: string; fetchedAt?: string }> {
  const q =
    id === 'gnews' ? `gnews&days=${Math.min(days, 7)}` : id === 'gnews_gov' ? `gnews&scope=gov&days=${Math.min(days, 7)}` : id === 'gdelt' ? `gdelt&days=${Math.min(days, 7)}` : `reliefweb&days=${Math.max(days, 7)}`;
  const r = await fetch(`/api/news?src=${q}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  const items: NewsArticle[] = (j.items ?? []).map((x: any) => {
    // Google appends " - Outlet" to titles
    const title = String(x.title ?? '').replace(new RegExp(`\\s+-\\s+${(x.outlet ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
    return {
      id: `${id}:${x.link}`,
      feed: id,
      title,
      link: x.link,
      outlet: x.outlet ?? '',
      published: x.published ?? null,
      summary: x.summary && x.summary !== x.title ? x.summary : undefined,
      image: x.image ?? null,
      places: [],
    };
  });
  return { items, source: j.source, fetchedAt: j.fetchedAt };
}

const FLOOD_WORDS = /น้ำท่วม|อุทกภัย|น้ำล้น|น้ำป่า|ท่วมขัง|ท่วม|flood/i;
const normTitle = (s: string) => s.replace(/[\s"“”'‘’!?.,:;()\-–—|]/g, '').slice(0, 60);

export interface NewsSnapshot {
  articles: NewsArticle[];
  places: NewsPlace[];
  unplaced: string[];
  feeds: FeedState[];
  fetchedAt: string;
  days: number;
}

/** Read the full story behind a link (resolves Google News links) and re-read its places. */
export async function readArticle(a: NewsArticle): Promise<NewsArticle> {
  try {
    const r = await fetch(`/api/news?src=article&url=${encodeURIComponent(a.link)}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    const text = String(j.text ?? '');
    // keep the part of the page around the headline / flood words to avoid menus and other stories
    const body = focus(text, a.title);
    return { ...a, text: body, image: a.image ?? j.image ?? null, realUrl: j.source, published: a.published ?? j.published ?? null, readState: 'ok', places: extractPlaces(`${a.title} ${j.description ?? ''} ${body}`) };
  } catch {
    return { ...a, readState: 'failed' };
  }
}

function focus(text: string, title: string) {
  const head = title.slice(0, 18);
  let i = head ? text.indexOf(head) : -1;
  if (i < 0) i = text.search(FLOOD_WORDS);
  if (i < 0) return text.slice(0, 4000);
  return text.slice(Math.max(0, i - 200), i + 5000);
}

export async function fetchNews(days: number, onFeed: (s: FeedState) => void, onProgress: (msg: string) => void, readFull = 30): Promise<NewsSnapshot> {
  const states: FeedState[] = [];
  const all: NewsArticle[] = [];
  await loadGaz().catch(() => null);
  await Promise.all(
    FEEDS.map(async (f) => {
      const st: FeedState = { id: f.id, label: f.labelTh, status: 'loading', count: 0 };
      onFeed(st);
      try {
        const r = await feed(f.id, days).catch(async () => {
          await new Promise((ok) => setTimeout(ok, 2500));
          return feed(f.id, days);
        });
        Object.assign(st, { status: 'ok', count: r.items.length, source: r.source, fetchedAt: r.fetchedAt });
        all.push(...r.items);
      } catch (e: any) {
        Object.assign(st, { status: 'error', error: e?.message ?? String(e) });
      }
      states.push(st);
      onFeed({ ...st });
    }),
  );
  // time window + flood wording + de-duplicate by headline
  const since = Date.now() - days * 86400e3;
  const seen = new Set<string>();
  let arts = all
    .filter((a) => !a.published || new Date(a.published).getTime() >= since)
    .filter((a) => FLOOD_WORDS.test(`${a.title} ${a.summary ?? ''}`))
    .sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''))
    .filter((a) => {
      const k = normTitle(a.title);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  arts = arts.map((a) => ({ ...a, places: extractPlaces(`${a.title} ${a.summary ?? ''}`) }));

  // read the full text of the newest stories that look Thai-domestic, to find district-level places
  const toRead = arts.filter((a) => a.feed !== 'reliefweb' && (a.places.length > 0 || /[ก-๙]/.test(a.title))).slice(0, readFull);
  let done = 0;
  const pool = 4;
  const queue = [...toRead];
  await Promise.all(
    Array.from({ length: pool }, async () => {
      while (queue.length) {
        const a = queue.shift()!;
        const r = await readArticle(a);
        const i = arts.findIndex((x) => x.id === a.id);
        if (i >= 0) arts[i] = { ...r, places: r.readState === 'ok' ? mergeRefs(a.places, r.places) : a.places };
        onProgress(`อ่านเนื้อข่าว ${++done}/${toRead.length}`);
      }
    }),
  );
  const { places, unplaced } = await placeArticles(arts, onProgress);
  return { articles: arts, places, unplaced, feeds: states, fetchedAt: new Date().toISOString(), days };
}

const mergeRefs = (a: PlaceRef[], b: PlaceRef[]) => {
  const m = new Map<string, PlaceRef>();
  [...a, ...b].forEach((r) => m.set(placeKey(r), r));
  // drop a province-only ref when a finer place in that province exists
  const list = [...m.values()];
  return list.filter((r) => r.precision !== 'province' || !list.some((x) => x.province === r.province && x.precision !== 'province'));
};

export async function placeArticles(arts: NewsArticle[], onProgress: (m: string) => void, pins: NewsPlace[] = []): Promise<{ places: NewsPlace[]; unplaced: string[] }> {
  const provinces = await loadProvinces();
  const byKey = new Map<string, NewsPlace>();
  pins.forEach((p) => byKey.set(p.key, { ...p, articleIds: [...p.articleIds] }));
  const refs = new Map<string, PlaceRef>();
  arts.forEach((a) => a.places.forEach((r) => refs.set(placeKey(r), r)));
  let i = 0;
  for (const [k, r] of refs) {
    onProgress(`หาพิกัด ${++i}/${refs.size}: ${placeLabel(r)}`);
    const g = await geocode(r, provinces);
    if (!g) {
      // fall back to the province when the district cannot be found inside it
      if (r.precision !== 'province') {
        const pr: PlaceRef = { province: r.province, precision: 'province', quote: r.quote };
        const pg = await geocode(pr, provinces);
        if (pg) {
          const pk = placeKey(pr);
          if (!byKey.has(pk)) byKey.set(pk, { key: pk, labelTh: placeLabel(pr), province: r.province, precision: 'province', lat: pg.lat, lon: pg.lon, bbox: pg.bbox, geocoder: pg.via ?? '', articleIds: [] });
          refs.set(k, pr);
        }
      }
      continue;
    }
    // a tambon that could not be found but whose amphoe could is placed at amphoe level
    const eff: PlaceRef = g.level === 'amphoe' && r.precision === 'tambon' ? { province: r.province, amphoe: r.amphoe, precision: 'amphoe', quote: r.quote } : r;
    const ek = placeKey(eff);
    if (ek !== k) refs.set(k, eff);
    if (!byKey.has(ek))
      byKey.set(ek, {
        key: ek, labelTh: placeLabel(eff), province: r.province, amphoe: eff.amphoe, tambon: eff.tambon, precision: eff.precision, lat: g.lat, lon: g.lon, bbox: g.bbox,
        geocoder: g.via ?? '', articleIds: [],
      });
  }
  const unplaced: string[] = [];
  arts.forEach((a) => {
    let placed = false;
    a.places.forEach((r) => {
      const ref = refs.get(placeKey(r)) ?? r;
      const p = byKey.get(placeKey(ref)) ?? byKey.get(placeKey(r));
      if (p && !p.articleIds.includes(a.id)) {
        p.articleIds.push(a.id);
        placed = true;
      }
    });
    if (!placed && !pins.some((p) => p.articleIds.includes(a.id))) unplaced.push(a.id);
  });
  const places = [...byKey.values()].filter((p) => p.articleIds.length).sort((a, b) => b.articleIds.length - a.articleIds.length || rank(a.precision) - rank(b.precision));
  return { places, unplaced };
}

const rank = (p: Precision) => ({ pin: 0, tambon: 1, amphoe: 2, province: 3 })[p];

export const PRECISION_TH: Record<Precision, string> = { tambon: 'ระดับตำบล', amphoe: 'ระดับอำเภอ', province: 'ระดับจังหวัด', pin: 'ปักหมุดโดยผู้ใช้' };
export const PRECISION_COLOR: Record<Precision, string> = { pin: '#f472b6', tambon: '#22d3ee', amphoe: '#3b82f6', province: '#94a3b8' };

/** Analysis box around a place: the tambon's own extent (kept between ±2 and ±6 km of its centre),
 *  ±8 km around an amphoe centre, ±3 km around a pin. Province-level places are not analysed. */
export function aoiForPlace(p: NewsPlace): GeoJSON.Polygon | null {
  if (p.precision === 'province') return null;
  const ky = 1 / 110.574, kx = 1 / (111.32 * Math.cos((p.lat * Math.PI) / 180));
  let box: [number, number, number, number];
  if (p.precision === 'tambon' && p.bbox) {
    const [w0, s0, e0, n0] = p.bbox;
    const clampX = (v: number, sgn: number) => p.lon + sgn * Math.min(6 * kx, Math.max(2 * kx, sgn * (v - p.lon)));
    const clampY = (v: number, sgn: number) => p.lat + sgn * Math.min(6 * ky, Math.max(2 * ky, sgn * (v - p.lat)));
    box = [clampX(w0, -1), clampY(s0, -1), clampX(e0, 1), clampY(n0, 1)];
  } else {
    const half = p.precision === 'pin' ? 3 : p.precision === 'tambon' ? 4 : 8;
    box = [p.lon - half * kx, p.lat - half * ky, p.lon + half * kx, p.lat + half * ky];
  }
  const [w, s, e, n] = box;
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

export const PINS_KEY = 'ov.newsPins.v1';
export function loadPins(): NewsPlace[] {
  try {
    return JSON.parse(localStorage.getItem(PINS_KEY) || '[]');
  } catch {
    return [];
  }
}
export function savePins(l: NewsPlace[]) {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(l));
  } catch {
    /* ignore */
  }
}
