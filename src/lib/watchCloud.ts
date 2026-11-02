// Watch areas, results and alerts on the server (Supabase), so the automatic checker
// (GitHub Actions) can watch the areas while no browser is open. See WATCH_SETUP.md.
import { supabase, supabaseConfigured } from './supabase';
import { registerRemoteImages, type MonitorAoi, type MonitorRun, type Purpose, type Region, type SensorMode } from './monitor';

/** off = Supabase not configured · signed-out · no-tables = supabase/watch.sql not run yet · on */
export type CloudState = 'off' | 'signed-out' | 'no-tables' | 'on' | 'error';

export interface WatchAlert {
  id: string;
  areaId: string;
  runId: string;
  level: string | null;
  createdAt: string;
  emailedTo: string | null;
  emailedAt: string | null;
  emailError: string | null;
  readAt: string | null;
}

export interface CloudArea extends MonitorAoi {
  notifyLevel: 'significant' | 'minor' | 'any';
  notifyEmail: string | null;
  lastCheckedAt: string | null;
  lastSceneAt: string | null;
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`);
/** server rows need uuid ids; local areas use other ids */
export const ensureUuid = (a: MonitorAoi): MonitorAoi => (isUuid(a.id) ? a : { ...a, id: newId() });

async function userId(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

export async function cloudStatus(): Promise<CloudState> {
  if (!supabaseConfigured || !supabase) return 'off';
  if (!(await userId())) return 'signed-out';
  const { error } = await supabase.from('watch_areas').select('id', { head: true, count: 'exact' });
  if (!error) return 'on';
  return /does not exist|relation|schema cache/i.test(error.message) ? 'no-tables' : 'error';
}

const rowToArea = (r: any): CloudArea => ({
  id: r.id,
  name: r.name,
  region: r.region as Region,
  purpose: r.purpose as Purpose,
  sensor: r.sensor as SensorMode,
  geometry: r.geometry,
  freqDays: 1,
  createdAt: r.created_at,
  notes: r.notes ?? undefined,
  active: r.active,
  editedAt: r.edited_at ?? undefined,
  notifyLevel: r.notify_level,
  notifyEmail: r.notify_email,
  lastCheckedAt: r.last_checked_at,
  lastSceneAt: r.last_scene_at,
});

const areaToRow = (a: MonitorAoi & Partial<CloudArea>, uid: string) => ({
  id: a.id,
  user_id: uid,
  name: a.name,
  region: a.region,
  purpose: a.purpose,
  // the server checker works with optical imagery; radar-only areas use Sentinel-2 there
  sensor: a.sensor ?? 'auto',
  geometry: a.geometry,
  active: a.active,
  notes: a.notes ?? null,
  edited_at: a.editedAt ?? null,
  notify_level: a.notifyLevel ?? 'significant',
  notify_email: a.notifyEmail ?? null,
});

export async function loadCloud(): Promise<{ aois: CloudArea[]; runs: MonitorRun[]; alerts: WatchAlert[] }> {
  const db = supabase!;
  const [ar, rr, al] = await Promise.all([
    db.from('watch_areas').select('*').order('created_at'),
    db.from('watch_runs').select('*').order('created_at', { ascending: false }).limit(400),
    db.from('watch_alerts').select('*').order('created_at', { ascending: false }).limit(200),
  ]);
  if (ar.error) throw new Error(ar.error.message);
  const aois = (ar.data ?? []).map(rowToArea);
  const names = new Map(aois.map((a) => [a.id, a.name]));
  // one entry per new scene: the "latest" comparison carries the week / month / year ones
  const byTrigger = new Map<string, MonitorRun>();
  const extra: MonitorRun[] = [];
  for (const row of rr.data ?? []) {
    const run: MonitorRun = { ...(row.run as MonitorRun), id: row.id, aoiId: row.area_id, aoiName: names.get(row.area_id) ?? row.run?.aoiName ?? '', at: row.created_at, server: true, horizon: row.horizon };
    registerRemoteImages(row.id, row.images);
    if (row.horizon === 'latest') byTrigger.set(`${row.area_id}|${row.trigger_scene}`, { ...run, horizons: byTrigger.get(`${row.area_id}|${row.trigger_scene}`)?.horizons });
    else extra.push({ ...run, trigger: row.trigger_scene } as MonitorRun & { trigger: string });
  }
  for (const h of extra as (MonitorRun & { trigger: string })[]) {
    const k = `${h.aoiId}|${h.trigger}`;
    const main = byTrigger.get(k);
    if (main) main.horizons = { ...(main.horizons ?? {}), [h.horizon!]: h };
  }
  const runs = [...byTrigger.values()].sort((a, b) => b.at.localeCompare(a.at));
  const alerts: WatchAlert[] = (al.data ?? []).map((r: any) => ({
    id: r.id, areaId: r.area_id, runId: r.run_id, level: r.level, createdAt: r.created_at,
    emailedTo: r.emailed_to, emailedAt: r.emailed_at, emailError: r.email_error, readAt: r.read_at,
  }));
  return { aois, runs, alerts };
}

/** Write the areas that changed and delete the ones that are gone. */
export async function syncAreas(before: MonitorAoi[], after: MonitorAoi[]): Promise<void> {
  const uid = await userId();
  if (!uid || !supabase) return;
  const prev = new Map(before.map((a) => [a.id, a]));
  const changed = after.filter((a) => prev.get(a.id) !== a);
  const gone = before.filter((a) => !after.some((b) => b.id === a.id)).map((a) => a.id);
  if (changed.length) {
    const { error } = await supabase.from('watch_areas').upsert(changed.map((a) => areaToRow(a, uid)));
    if (error) throw new Error(error.message);
  }
  if (gone.length) {
    const { error } = await supabase.from('watch_areas').delete().in('id', gone);
    if (error) throw new Error(error.message);
  }
}

export async function deleteCloudRun(id: string) {
  await supabase?.from('watch_runs').delete().eq('id', id);
}

export async function markAlertsRead(ids: string[]) {
  if (!ids.length) return;
  await supabase?.from('watch_alerts').update({ read_at: new Date().toISOString() }).in('id', ids);
}
