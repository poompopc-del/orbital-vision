// ORBITAL VISION — automatic area watch ("CCTV from orbit").
// Runs on GitHub Actions every few hours. For every active watch area it:
//   1. looks for Sentinel-2 / Landsat scenes newer than the last one it has seen,
//   2. measures cloud and shadow inside the area for each new scene (per-pixel mask),
//   3. for each new usable scene, compares it with the previous usable scene ("latest") and with
//      the usable scenes nearest 7 / 30 / 365 days earlier ("week" / "month" / "year"),
//   4. stores results + before/after/change images in Supabase, and
//   5. emails an alert when the latest comparison reaches the area's alert level.
// The comparison is the same code the website uses (src/lib/monitor.ts → compareScenes).
//
// Dry run (no database, no email unless WATCH_TEST_EMAIL_TO is set):
//   WATCH_DRY_RUN=1 WATCH_TEST_BBOX="102.50,13.62,102.60,13.70" node watch-runner.mjs
// Outputs land in ./watch-out (JSON + images + the alert email as HTML).
import './shim';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import { compareScenes, measureAoiCloud, type MonitorAoi, type MonitorRun, type Purpose, type Region, type SensorMode } from '../../src/lib/monitor';
import { fetchItem, searchArchive, type ImageryItem, type StacCollectionId } from '../../src/lib/stac';
import { checkScene, QC_DEFAULT, type AoiCloud, type QcSettings } from '../../src/lib/qc';
import { alertEmail, alertSubject, type HorizonResult } from './email';

// ------------------------------------------------------------------ settings
const env = process.env;
const DRY = env.WATCH_DRY_RUN === '1';
const LOOKBACK_DAYS = +(env.WATCH_LOOKBACK_DAYS || 20);
const BASELINE_DAYS = 120; // how far back to look for a usable "before" scene
const MAX_MINUTES = +(env.WATCH_MAX_MINUTES || 150); // leave time for the next scheduled run
const MAX_NEW_PER_AREA = 3; // newest usable scenes processed per area per run
const ALERT_ON_FIRST = env.WATCH_ALERT_ON_FIRST === '1';
const APP_URL = (env.APP_URL || '').replace(/\/$/, '');
const HORIZONS: { h: 'week' | 'month' | 'year'; days: number; tol: number }[] = [
  { h: 'week', days: 7, tol: 4 },
  { h: 'month', days: 30, tol: 12 },
  { h: 'year', days: 365, tol: 30 },
];
const started = Date.now();
const timeLeft = () => Date.now() - started < MAX_MINUTES * 60e3;
const day = 86400e3;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ------------------------------------------------------------------ data model
interface Area {
  id: string;
  user_id: string;
  name: string;
  region: Region;
  purpose: Purpose;
  sensor: SensorMode;
  geometry: GeoJSON.Polygon;
  notify_level: 'significant' | 'minor' | 'any';
  notify_email: string | null;
  last_checked_at: string | null;
  last_scene_at: string | null;
  edited_at?: string | null;
}
interface SeenRow {
  area_id: string;
  scene_id: string;
  collection: string;
  datetime: string;
  scene_cloud: number | null;
  aoi_cloud: number | null;
  aoi_shadow: number | null;
  usable: boolean;
  reasons: string | null;
}
interface Store {
  areas(): Promise<Area[]>;
  seen(areaId: string): Promise<Map<string, SeenRow>>;
  putSeen(r: SeenRow): Promise<void>;
  usableBetween(areaId: string, collection: string, from: string, to: string): Promise<SeenRow[]>;
  upload(p: string, dataUrl: string): Promise<string>;
  insertRun(row: Record<string, unknown>): Promise<void>;
  insertAlert(row: Record<string, unknown>): Promise<void>;
  updateArea(id: string, patch: Partial<Area>): Promise<void>;
  emailOf(userId: string): Promise<string | null>;
}

// ------------------------------------------------------------------ stores
class SupabaseStore implements Store {
  constructor(private db: SupabaseClient) {}
  async areas() {
    const { data, error } = await this.db.from('watch_areas').select('*').eq('active', true).order('last_checked_at', { ascending: true, nullsFirst: true });
    if (error) throw new Error(`watch_areas: ${error.message}`);
    return (data ?? []) as Area[];
  }
  async seen(areaId: string) {
    const { data, error } = await this.db.from('watch_scenes').select('*').eq('area_id', areaId);
    if (error) throw new Error(`watch_scenes: ${error.message}`);
    return new Map((data ?? []).map((r: SeenRow) => [r.scene_id, r]));
  }
  async putSeen(r: SeenRow) {
    const { error } = await this.db.from('watch_scenes').upsert(r);
    if (error) throw new Error(`watch_scenes upsert: ${error.message}`);
  }
  async usableBetween(areaId: string, collection: string, from: string, to: string) {
    const { data, error } = await this.db.from('watch_scenes').select('*').eq('area_id', areaId).eq('collection', collection).eq('usable', true)
      .gte('datetime', from).lt('datetime', to).order('datetime', { ascending: false });
    if (error) throw new Error(`watch_scenes: ${error.message}`);
    return (data ?? []) as SeenRow[];
  }
  async upload(p: string, dataUrl: string) {
    const [meta, b64] = dataUrl.split(',');
    const type = /image\/jpeg/.test(meta) ? 'image/jpeg' : 'image/png';
    const { error } = await this.db.storage.from('watch').upload(p, Buffer.from(b64, 'base64'), { contentType: type, upsert: true });
    if (error) throw new Error(`storage upload ${p}: ${error.message}`);
    return this.db.storage.from('watch').getPublicUrl(p).data.publicUrl;
  }
  async insertRun(row: Record<string, unknown>) {
    const { error } = await this.db.from('watch_runs').insert(row);
    if (error) throw new Error(`watch_runs insert: ${error.message}`);
  }
  async insertAlert(row: Record<string, unknown>) {
    const { error } = await this.db.from('watch_alerts').insert(row);
    if (error) throw new Error(`watch_alerts insert: ${error.message}`);
  }
  async updateArea(id: string, patch: Partial<Area>) {
    const { error } = await this.db.from('watch_areas').update(patch).eq('id', id);
    if (error) throw new Error(`watch_areas update: ${error.message}`);
  }
  async emailOf(userId: string) {
    const { data } = await this.db.auth.admin.getUserById(userId);
    return data?.user?.email ?? null;
  }
}

/** Dry run: one test area, everything kept in memory and written to ./watch-out. */
class FileStore implements Store {
  private rows = new Map<string, SeenRow>();
  constructor(private dir: string, private area: Area) {
    fs.mkdirSync(dir, { recursive: true });
  }
  async areas() {
    return [this.area];
  }
  async seen() {
    return new Map(this.rows);
  }
  async putSeen(r: SeenRow) {
    this.rows.set(r.scene_id, r);
  }
  async usableBetween(_a: string, collection: string, from: string, to: string) {
    return [...this.rows.values()].filter((r) => r.usable && r.collection === collection && r.datetime >= from && r.datetime < to).sort((a, b) => b.datetime.localeCompare(a.datetime));
  }
  async upload(p: string, dataUrl: string) {
    const f = path.join(this.dir, p.replace(/\//g, '_'));
    fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
    return path.basename(f);
  }
  async insertRun(row: Record<string, unknown>) {
    fs.writeFileSync(path.join(this.dir, `run_${row.horizon}_${row.id}.json`), JSON.stringify(row, null, 2));
  }
  async insertAlert(row: Record<string, unknown>) {
    fs.writeFileSync(path.join(this.dir, `alert_${row.id}.json`), JSON.stringify(row, null, 2));
  }
  async updateArea(_id: string, patch: Partial<Area>) {
    Object.assign(this.area, patch);
  }
  async emailOf() {
    return env.WATCH_TEST_EMAIL_TO || null;
  }
}

// ------------------------------------------------------------------ email
const mailer =
  env.SMTP_USER && env.SMTP_PASS
    ? nodemailer.createTransport({
        host: env.SMTP_HOST || 'smtp.gmail.com',
        port: +(env.SMTP_PORT || 465),
        secure: +(env.SMTP_PORT || 465) === 465,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      })
    : null;

// ------------------------------------------------------------------ scene helpers
function collectionsFor(sensor: SensorMode): StacCollectionId[] {
  if (sensor === 'landsat') return ['landsat-c2-l2'];
  if (sensor === 'optical-any') return ['sentinel-2-l2a', 'landsat-c2-l2'];
  return ['sentinel-2-l2a']; // optical alerts; radar areas also use Sentinel-2 here for now
}
function qcFor(sensor: SensorMode): QcSettings {
  return sensor === 'landsat' || sensor === 'optical-any' ? { ...QC_DEFAULT, maxGsdM: 30 } : QC_DEFAULT;
}
const toMonitorAoi = (a: Area): MonitorAoi => ({
  id: a.id, name: a.name, region: a.region, purpose: a.purpose, sensor: a.sensor, geometry: a.geometry,
  freqDays: 1, createdAt: '', active: true,
});

class AreaJob {
  private seen = new Map<string, SeenRow>();
  private clouds = new Map<string, AoiCloud | null>();
  private items = new Map<string, ImageryItem>();
  constructor(private store: Store, private a: Area) {}
  private qc() {
    return qcFor(this.a.sensor);
  }

  async search(from: number, to: number): Promise<ImageryItem[]> {
    // Planetary Computer returns at most ~100 items per query: long windows are split into 45-day pieces
    const out = new Map<string, ImageryItem>();
    for (let a = from; a < to; a += 45 * day) {
      const b = Math.min(to, a + 45 * day);
      const list = await searchArchive({ aoi: this.a.geometry, collections: collectionsFor(this.a.sensor), from: iso(a), to: iso(b), maxCloud: this.qc().maxSceneCloud, limit: 100 });
      list.filter((x) => x.source === 'planetary-computer' && (x.coveragePct ?? 100) >= 60).forEach((x) => out.set(x.id, x));
    }
    out.forEach((x) => this.items.set(x.id, x));
    return [...out.values()].sort((p, q) => p.datetime.localeCompare(q.datetime));
  }

  /** Measure AOI cloud once per scene and remember the verdict (database + memory). */
  async examine(it: ImageryItem): Promise<SeenRow> {
    const had = this.seen.get(it.id);
    if (had) return had;
    const cl = await measureAoiCloud(it, this.a.geometry).catch(() => null);
    const chk = checkScene(it, cl, this.qc());
    const row: SeenRow = {
      area_id: this.a.id, scene_id: it.id, collection: it.collection, datetime: it.datetime, scene_cloud: it.cloudCover,
      aoi_cloud: cl?.cloudPct ?? null, aoi_shadow: cl?.shadowPct ?? null, usable: chk.ok, reasons: chk.reasons.join('; ') || null,
    };
    this.clouds.set(it.id, cl);
    this.seen.set(it.id, row);
    await this.store.putSeen(row);
    log(`  ${it.datetime.slice(0, 16)} ${it.collection} cloud in area ${cl ? (cl.cloudPct + cl.shadowPct).toFixed(1) + '%' : 'n/a'} → ${chk.ok ? 'usable' : 'skip (' + row.reasons + ')'}`);
    return row;
  }

  async item(row: SeenRow): Promise<ImageryItem | null> {
    const got = this.items.get(row.scene_id) ?? (await fetchItem(row.collection, row.scene_id, this.a.geometry));
    if (got) this.items.set(got.id, got);
    return got;
  }

  /** Newest usable scene of the same satellite strictly inside (from, to), checking candidates newest first. */
  async usableIn(B: ImageryItem, from: number, to: number, prefer?: number): Promise<ImageryItem | null> {
    const known = await this.store.usableBetween(this.a.id, B.collection, new Date(from).toISOString(), new Date(to).toISOString());
    const order = (xs: { datetime: string }[]) =>
      prefer == null ? xs : [...xs].sort((p, q) => Math.abs(new Date(p.datetime).getTime() - prefer) - Math.abs(new Date(q.datetime).getTime() - prefer));
    for (const r of order(known).slice(0, 2)) {
      const it = await this.item(r);
      if (it && it.id !== B.id) return it;
    }
    const cands = order((await this.search(from, to)).filter((x) => x.collection === B.collection && x.id !== B.id && new Date(x.datetime).getTime() < to).reverse());
    let checked = 0;
    for (const it of cands) {
      if (checked++ >= 6) break;
      const r = await this.examine(it);
      if (r.usable) return it;
    }
    return null;
  }

  async compare(A: ImageryItem, B: ImageryItem, horizon: HorizonResult['horizon']): Promise<HorizonResult & { id: string }> {
    const id = randomUUID();
    const images: Record<string, string> = {};
    const raw: Record<string, string> = {};
    log(`  compare ${horizon}: ${A.datetime.slice(0, 10)} → ${B.datetime.slice(0, 10)}`);
    const run: MonitorRun = await compareScenes(toMonitorAoi(this.a), A, B, () => {}, undefined, {
      qc: this.qc(), clA: this.clouds.get(A.id) ?? null, clB: this.clouds.get(B.id) ?? null, mode: 'auto',
      saveImage: async (key, dataUrl) => void (raw[key.split(':')[1]] = dataUrl),
    });
    run.id = id;
    for (const [k, v] of Object.entries(raw)) images[k] = await this.store.upload(`${this.a.id}/${id}/${k}.${/jpeg/.test(v.slice(0, 30)) ? 'jpg' : 'png'}`, v);
    await this.store.insertRun({
      id, area_id: this.a.id, user_id: this.a.user_id, horizon, trigger_scene: B.id, status: run.status, level: run.level ?? null,
      confidence: run.confidence ?? null, change_km2: run.stats?.interestKm2 ?? null,
      valid_pct: run.stats ? (100 * run.stats.validKm2) / Math.max(run.stats.aoiKm2, 1e-9) : null,
      a_datetime: A.datetime, b_datetime: B.datetime, run, images,
    });
    log(`    → ${run.status}${run.level ? ' / ' + run.level : ''}${run.stats ? ` · change ${run.stats.interestKm2.toFixed(3)} km² · checkable ${((100 * run.stats.validKm2) / run.stats.aoiKm2).toFixed(0)}%` : ''}${run.reason ? ' · ' + run.reason : ''}`);
    return { id, horizon, run, images };
  }

  /** Same pair as an earlier comparison: store it again under another horizon (no recomputation). */
  async copyAs(src: HorizonResult & { id: string }, horizon: HorizonResult['horizon'], A: ImageryItem, B: ImageryItem): Promise<HorizonResult & { id: string }> {
    const id = randomUUID();
    const run = { ...src.run, id };
    await this.store.insertRun({
      id, area_id: this.a.id, user_id: this.a.user_id, horizon, trigger_scene: B.id, status: run.status, level: run.level ?? null,
      confidence: run.confidence ?? null, change_km2: run.stats?.interestKm2 ?? null,
      valid_pct: run.stats ? (100 * run.stats.validKm2) / Math.max(run.stats.aoiKm2, 1e-9) : null,
      a_datetime: A.datetime, b_datetime: B.datetime, run, images: src.images,
    });
    log(`  ${horizon}: same earlier scene as "latest" (${A.datetime.slice(0, 10)})`);
    return { id, horizon, run, images: src.images };
  }

  async process(B: ImageryItem, firstRun: boolean) {
    const t = new Date(B.datetime).getTime();
    const A = await this.usableIn(B, t - BASELINE_DAYS * day, t - 3600e3);
    if (!A) {
      log(`  no usable earlier scene within ${BASELINE_DAYS} days — ${B.datetime.slice(0, 10)} becomes the baseline`);
      return;
    }
    const results: (HorizonResult & { id: string })[] = [await this.compare(A, B, 'latest')];
    for (const hz of HORIZONS) {
      if (!timeLeft()) break;
      const target = t - hz.days * day;
      const H = await this.usableIn(B, target - hz.tol * day, Math.min(target + hz.tol * day, t - 3600e3), target);
      if (!H) {
        log(`  ${hz.h}: no usable scene near ${iso(target)}`);
        continue;
      }
      results.push(H.id === A.id ? await this.copyAs(results[0], hz.h, A, B) : await this.compare(H, B, hz.h));
    }
    const latest = results[0].run;
    const lvl = this.a.notify_level;
    const meets = latest.status === 'ok' && (lvl === 'any' || latest.level === 'significant' || (lvl === 'minor' && latest.level === 'minor'));
    if (!meets) return;
    if (firstRun && !ALERT_ON_FIRST) {
      log('  first check of this area: result stored as baseline, no email');
      return;
    }
    const to = this.a.notify_email || (await this.store.emailOf(this.a.user_id));
    const areaUrl = APP_URL ? `${APP_URL}/imagery?tab=watch&area=${this.a.id}` : '#';
    const html = alertEmail({ areaName: this.a.name, region: this.a.region, purpose: this.a.purpose, areaUrl, results });
    const alert: Record<string, unknown> = { id: randomUUID(), area_id: this.a.id, run_id: results[0].id, user_id: this.a.user_id, level: latest.level, emailed_to: to };
    if (DRY) fs.writeFileSync(path.join('watch-out', 'alert-email.html'), html);
    if (to && mailer) {
      try {
        await mailer.sendMail({ from: env.ALERT_FROM || env.SMTP_USER, to, subject: alertSubject(this.a.name, latest), html });
        alert.emailed_at = new Date().toISOString();
        log(`  ✉ alert sent to ${to}`);
      } catch (e: any) {
        alert.email_error = String(e?.message ?? e);
        log(`  ✉ email failed: ${alert.email_error}`);
      }
    } else alert.email_error = !to ? 'no recipient' : 'SMTP not configured';
    await this.store.insertAlert(alert);
  }

  async run() {
    const a = this.a;
    // the user moved/resized the box after the last check: cloud figures of earlier scenes were for the old
    // shape, so look at them again and start a new reference instead of alerting on the reshaped area
    const reshaped = !!(a.edited_at && a.last_checked_at && a.edited_at > a.last_checked_at);
    this.seen = reshaped ? new Map() : await this.store.seen(a.id);
    const firstRun = !a.last_checked_at || reshaped;
    const now = Date.now();
    const since = Math.max(now - LOOKBACK_DAYS * day, a.last_scene_at && !reshaped ? new Date(a.last_scene_at).getTime() - day : 0);
    log(`▶ ${a.name} (${a.id.slice(0, 8)}) since ${iso(since)}${reshaped ? ' · box edited, new reference' : firstRun ? ' · first check' : ''}`);
    const fresh = (await this.search(since, now + day)).filter((x) => !this.seen.has(x.id));
    const usable: ImageryItem[] = [];
    for (const it of fresh) if ((await this.examine(it)).usable) usable.push(it);
    if (!fresh.length) log('  no new scenes');
    // one satellite pass can appear as two overlapping tiles: keep one per pass (best coverage of the area)
    const pass = new Map<string, ImageryItem>();
    for (const it of usable) {
      const k = `${it.platform}|${it.datetime.slice(0, 13)}`;
      const had = pass.get(k);
      if (!had || (it.coveragePct ?? 0) > (had.coveragePct ?? 0)) pass.set(k, it);
    }
    const passes = [...pass.values()].sort((p, q) => p.datetime.localeCompare(q.datetime));
    const todo = (firstRun ? passes.slice(-1) : passes.slice(-MAX_NEW_PER_AREA));
    for (const B of todo) {
      if (!timeLeft()) break;
      await this.process(B, firstRun);
    }
    const newest = [...usable].map((x) => x.datetime).sort().pop();
    await this.store.updateArea(a.id, { last_checked_at: new Date().toISOString(), ...(newest && (!a.last_scene_at || newest > a.last_scene_at) ? { last_scene_at: newest } : {}) });
  }
}

// ------------------------------------------------------------------ main
function testArea(): Area {
  const raw = env.WATCH_TEST_AOI || '';
  let geometry: GeoJSON.Polygon;
  if (raw.trim().startsWith('{')) geometry = JSON.parse(raw);
  else {
    const [w, s, e, n] = (env.WATCH_TEST_BBOX || '102.50,13.62,102.60,13.70').split(',').map(Number);
    geometry = { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
  }
  return {
    id: '00000000-0000-0000-0000-000000000000', user_id: 'dry-run', name: env.WATCH_TEST_NAME || 'ทดสอบ (dry run)', region: 'TH-KH', purpose: (env.WATCH_TEST_PURPOSE as Purpose) || 'construction',
    sensor: 'optical', geometry, notify_level: 'any', notify_email: env.WATCH_TEST_EMAIL_TO || null,
    last_checked_at: ALERT_ON_FIRST ? null : '1970-01-01T00:00:00Z', last_scene_at: null,
  };
}

async function main() {
  let store: Store;
  if (DRY) {
    store = new FileStore('watch-out', testArea());
    log('dry run → ./watch-out');
  } else {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (GitHub → Settings → Secrets and variables → Actions)');
    store = new SupabaseStore(createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }));
  }
  if (!mailer) log('SMTP not configured — alerts are stored but not emailed (set SMTP_USER and SMTP_PASS)');
  const areas = await store.areas();
  log(`${areas.length} active area(s)`);
  let done = 0, failed = 0;
  for (const a of areas) {
    if (!timeLeft()) {
      log(`time budget (${MAX_MINUTES} min) reached — ${areas.length - done - failed} area(s) left for the next run`);
      break;
    }
    try {
      await new AreaJob(store, a).run();
      done++;
    } catch (e: any) {
      failed++;
      log(`✖ ${a.name}: ${e?.message ?? e}`);
    }
  }
  log(`finished: ${done} checked, ${failed} failed, ${((Date.now() - started) / 60e3).toFixed(1)} min`);
  if (failed && !done) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
