// Persistence layer. Uses Supabase (Postgres + PostGIS, RLS per user) when configured and signed in,
// otherwise falls back to this browser's localStorage. The storage location is always shown in the UI.
import { supabase } from './supabase';

export type RequestStatus =
  | 'draft'
  | 'searching_archives'
  | 'results_available'
  | 'awaiting_quote'
  | 'awaiting_confirmation'
  | 'submitted_to_provider'
  | 'accepted_by_provider'
  | 'scheduled'
  | 'acquired'
  | 'processing'
  | 'delivered'
  | 'failed'
  | 'cancelled';

export const STATUS_META: Record<RequestStatus, { label: string; tone: 'idle' | 'info' | 'warn' | 'ok' | 'bad'; providerSide: boolean }> = {
  draft: { label: 'Draft', tone: 'idle', providerSide: false },
  searching_archives: { label: 'Searching archives', tone: 'info', providerSide: false },
  results_available: { label: 'Results available', tone: 'info', providerSide: false },
  awaiting_quote: { label: 'Awaiting provider quote', tone: 'warn', providerSide: true },
  awaiting_confirmation: { label: 'Awaiting confirmation', tone: 'warn', providerSide: false },
  submitted_to_provider: { label: 'Submitted to provider', tone: 'info', providerSide: true },
  accepted_by_provider: { label: 'Accepted by provider', tone: 'ok', providerSide: true },
  scheduled: { label: 'Scheduled', tone: 'ok', providerSide: true },
  acquired: { label: 'Acquired', tone: 'ok', providerSide: true },
  processing: { label: 'Processing', tone: 'info', providerSide: true },
  delivered: { label: 'Delivered', tone: 'ok', providerSide: true },
  failed: { label: 'Failed', tone: 'bad', providerSide: true },
  cancelled: { label: 'Cancelled', tone: 'bad', providerSide: false },
};

export const STATUS_ORDER: RequestStatus[] = Object.keys(STATUS_META) as RequestStatus[];

export interface StatusEvent {
  at: string;
  status: RequestStatus;
  note?: string;
  /** 'platform' = set by this app's own workflow; 'user_reported' = user typed it in after dealing with the provider manually; 'provider_api' = reported by an integrated provider API */
  source: 'platform' | 'user_reported' | 'provider_api';
}

export interface AcquisitionRequest {
  id: string;
  projectId?: string | null;
  title: string;
  kind: 'archive' | 'new_acquisition';
  providerId: string;
  sensor: string;
  aoi: GeoJSON.Polygon | null;
  params: Record<string, unknown>;
  status: RequestStatus;
  history: StatusEvent[];
  deliveryUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail?: Record<string, unknown>;
  actor?: string;
}

const LS = { req: 'ov.requests.v1', proj: 'ov.projects.v1', audit: 'ov.audit.v1' };

function lsGet<T>(k: string): T[] {
  try {
    return JSON.parse(localStorage.getItem(k) || '[]');
  } catch {
    return [];
  }
}
function lsSet<T>(k: string, v: T[]) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

export const uid = () =>
  (crypto as any).randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

async function session() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function storageMode(): Promise<'supabase' | 'local'> {
  return (await session()) ? 'supabase' : 'local';
}

// ---------- requests ----------
const toRow = (r: AcquisitionRequest) => ({
  id: r.id,
  project_id: r.projectId ?? null,
  title: r.title,
  kind: r.kind,
  provider_id: r.providerId,
  sensor: r.sensor,
  aoi: r.aoi,
  params: r.params,
  status: r.status,
  history: r.history,
  delivery_url: r.deliveryUrl ?? null,
  created_at: r.createdAt,
  updated_at: r.updatedAt,
});
const fromRow = (x: any): AcquisitionRequest => ({
  id: x.id,
  projectId: x.project_id,
  title: x.title,
  kind: x.kind,
  providerId: x.provider_id,
  sensor: x.sensor,
  aoi: x.aoi,
  params: x.params || {},
  status: x.status,
  history: x.history || [],
  deliveryUrl: x.delivery_url,
  createdAt: x.created_at,
  updatedAt: x.updated_at,
});

export async function listRequests(): Promise<AcquisitionRequest[]> {
  if (await session()) {
    const { data, error } = await supabase!.from('acquisition_requests').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(fromRow);
  }
  return lsGet<AcquisitionRequest>(LS.req).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveRequest(r: AcquisitionRequest): Promise<void> {
  r.updatedAt = new Date().toISOString();
  if (await session()) {
    const { error } = await supabase!.from('acquisition_requests').upsert(toRow(r));
    if (error) throw error;
  } else {
    const all = lsGet<AcquisitionRequest>(LS.req).filter((x) => x.id !== r.id);
    all.push(r);
    lsSet(LS.req, all);
  }
}

export async function deleteRequest(id: string): Promise<void> {
  if (await session()) {
    const { error } = await supabase!.from('acquisition_requests').delete().eq('id', id);
    if (error) throw error;
  } else {
    lsSet(LS.req, lsGet<AcquisitionRequest>(LS.req).filter((x) => x.id !== id));
  }
  void logAudit('request.delete', { id });
}

// ---------- projects ----------
export async function listProjects(): Promise<Project[]> {
  if (await session()) {
    const { data, error } = await supabase!.from('projects').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map((x: any) => ({ id: x.id, name: x.name, description: x.description, createdAt: x.created_at }));
  }
  return lsGet<Project>(LS.proj);
}

export async function createProject(name: string, description?: string): Promise<Project> {
  const p: Project = { id: uid(), name, description, createdAt: new Date().toISOString() };
  if (await session()) {
    const { error } = await supabase!.from('projects').insert({ id: p.id, name, description, created_at: p.createdAt });
    if (error) throw error;
  } else {
    lsSet(LS.proj, [p, ...lsGet<Project>(LS.proj)]);
  }
  void logAudit('project.create', { id: p.id, name });
  return p;
}

// ---------- audit ----------
export async function logAudit(action: string, detail?: Record<string, unknown>): Promise<void> {
  const e: AuditEntry = { id: uid(), at: new Date().toISOString(), action, detail };
  try {
    if (await session()) {
      await supabase!.from('audit_logs').insert({ id: e.id, at: e.at, action, detail });
      return;
    }
  } catch {
    /* fall through to local */
  }
  const all = lsGet<AuditEntry>(LS.audit);
  all.unshift(e);
  lsSet(LS.audit, all.slice(0, 500));
}

export async function listAudit(): Promise<AuditEntry[]> {
  if (await session()) {
    const { data } = await supabase!.from('audit_logs').select('*').order('at', { ascending: false }).limit(200);
    return (data || []).map((x: any) => ({ id: x.id, at: x.at, action: x.action, detail: x.detail, actor: x.user_id }));
  }
  return lsGet<AuditEntry>(LS.audit);
}
