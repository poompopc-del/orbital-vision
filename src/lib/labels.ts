// Labels on detected changes: "this spot is a new track / a clearing / a false alarm …".
// Stored in Supabase (table change_labels, supabase/labels.sql) when the user is signed in and the
// table exists; otherwise in this browser (localStorage) and moved up on the next signed-in save.
// The set is the training data for a later classifier, and lets a new detection near an earlier
// label show what it was labelled.
import { supabase, supabaseConfigured } from './supabase';

import type { ChangeLabel, LabelKind } from './labelCore';
export * from './labelCore';

const KEY = 'ov.labels.v1';
const readLocal = (): ChangeLabel[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
};
const writeLocal = (l: ChangeLabel[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(l.slice(0, 5000)));
  } catch {
    /* storage blocked */
  }
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`);

/** 'on' = Supabase table usable · 'local' = this browser only (signed out / not configured / table missing) */
export type LabelStore = 'on' | 'local';
let store: LabelStore | null = null;
async function userId(): Promise<string | null> {
  if (!supabaseConfigured || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

const toRow = (l: ChangeLabel) => ({
  id: l.id, label: l.label, note: l.note ?? null, lon: l.lon, lat: l.lat, area_km2: l.areaKm2 ?? null, length_km: l.lengthKm ?? null,
  source: l.source, purpose: l.purpose ?? null, aoi_name: l.aoiName ?? null, a_scene: l.aScene ?? null, b_scene: l.bScene ?? null,
  a_datetime: l.aDatetime ?? null, b_datetime: l.bDatetime ?? null, features: l.features ?? {}, updated_at: new Date().toISOString(),
});
const fromRow = (r: any): ChangeLabel => ({
  id: r.id, createdAt: r.created_at, label: r.label, note: r.note ?? undefined, lon: r.lon, lat: r.lat, areaKm2: r.area_km2, lengthKm: r.length_km,
  source: r.source, purpose: r.purpose ?? undefined, aoiName: r.aoi_name ?? undefined, aScene: r.a_scene ?? undefined, bScene: r.b_scene ?? undefined,
  aDatetime: r.a_datetime ?? undefined, bDatetime: r.b_datetime ?? undefined, features: r.features ?? {}, where: 'cloud',
});

let cache: ChangeLabel[] | null = null;
const listeners = new Set<() => void>();
export const onLabels = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};
const changed = () => listeners.forEach((f) => f());

export async function loadLabels(): Promise<{ labels: ChangeLabel[]; store: LabelStore }> {
  const local = readLocal().map((l) => ({ ...l, where: 'local' as const }));
  const me = await userId().catch(() => null);
  if (me && supabase) {
    const { data, error } = await supabase.from('change_labels').select('*').order('created_at', { ascending: false }).limit(5000);
    if (!error) {
      store = 'on';
      // labels made while signed out go up now
      if (local.length) {
        const { error: e2 } = await supabase.from('change_labels').upsert(local.map(toRow));
        if (!e2) writeLocal([]);
      }
      const cloud = (data ?? []).map(fromRow);
      const ids = new Set(cloud.map((x) => x.id));
      cache = [...cloud, ...(local.length ? local.filter((l) => !ids.has(l.id)).map((l) => ({ ...l, where: 'cloud' as const })) : [])];
      return { labels: cache, store };
    }
  }
  store = 'local';
  cache = local;
  return { labels: cache, store };
}
export const labelStore = () => store;
export const cachedLabels = () => cache ?? [];

export async function saveLabel(l: Omit<ChangeLabel, 'id' | 'createdAt'> & { id?: string }): Promise<ChangeLabel> {
  const full: ChangeLabel = { ...l, id: l.id ?? uid(), createdAt: new Date().toISOString() };
  if (store === null) await loadLabels();
  if (store === 'on' && supabase) {
    const { error } = await supabase.from('change_labels').upsert(toRow(full));
    if (!error) {
      full.where = 'cloud';
      cache = [full, ...(cache ?? []).filter((x) => x.id !== full.id)];
      changed();
      return full;
    }
  }
  full.where = 'local';
  writeLocal([full, ...readLocal().filter((x) => x.id !== full.id)]);
  cache = [full, ...(cache ?? []).filter((x) => x.id !== full.id)];
  changed();
  return full;
}

export async function deleteLabel(id: string) {
  if (store === 'on' && supabase) await supabase.from('change_labels').delete().eq('id', id);
  writeLocal(readLocal().filter((x) => x.id !== id));
  cache = (cache ?? []).filter((x) => x.id !== id);
  changed();
}

