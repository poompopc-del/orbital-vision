import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n';
import { Link } from 'react-router-dom';
import { Badge, Button, Field, Input, KV, Notice, PageHeader, Panel, Select, cx } from '../components/ui';
import {
  createProject, deleteRequest, listProjects, listRequests, logAudit, saveRequest, storageMode,
  STATUS_META, STATUS_ORDER, type AcquisitionRequest, type Project, type RequestStatus,
} from '../lib/repo';
import { providerById } from '../data/providers';
import { fmtUtc } from '../lib/format';
import { areaKm2, downloadJson } from '../lib/geo';

const SOURCE_LABEL = { platform: t('Platform'), user_reported: t('User-reported'), provider_api: t('Provider API') } as const;

export default function Orders() {
  const [reqs, setReqs] = useState<AcquisitionRequest[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [mode, setMode] = useState<'supabase' | 'local'>('local');
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [projName, setProjName] = useState('');
  const [err, setErr] = useState('');
  const [nextStatus, setNextStatus] = useState<RequestStatus>('submitted_to_provider');
  const [note, setNote] = useState('');
  const [delivery, setDelivery] = useState('');

  const reload = async () => {
    try {
      setMode(await storageMode());
      setReqs(await listRequests());
      setProjects(await listProjects());
    } catch (e: any) {
      setErr(e.message);
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const shown = useMemo(
    () => reqs.filter((r) => filter === 'all' || (filter === 'closed' ? ['delivered', 'failed', 'cancelled'].includes(r.status) : !['delivered', 'failed', 'cancelled'].includes(r.status))),
    [reqs, filter],
  );
  const cur = reqs.find((r) => r.id === sel) ?? null;

  const update = async (r: AcquisitionRequest, status: RequestStatus, source: 'platform' | 'user_reported', n?: string) => {
    const next: AcquisitionRequest = {
      ...r,
      status,
      deliveryUrl: delivery || r.deliveryUrl,
      history: [...r.history, { at: new Date().toISOString(), status, source, note: n || undefined }],
    };
    await saveRequest(next);
    void logAudit('request.status', { id: r.id, status, source });
    setNote('');
    await reload();
  };

  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-y-auto p-4 scroll-thin">
        <PageHeader
          code={t('H · Orders & Projects')}
          title={t('Requests, provider responses and deliveries')}
          sub={t('Locally created requests are never shown as confirmed orders. Each status change records who reported it: this platform, you (after dealing with a provider manually), or an integrated provider API.')}
          right={<Badge tone={mode === 'supabase' ? 'ok' : 'warn'}>{mode === 'supabase' ? t('Stored in Supabase') : t('Stored in this browser only')}</Badge>}
        />
        {err && <div className="mb-3"><Notice tone="bad">{err}</Notice></div>}

        <div className="grid gap-4 xl:grid-cols-[1fr_280px]">
          <Panel
            title={`${t('Requests')} (${shown.length})`}
            right={
              <div className="flex gap-1">
                {(['all', 'open', 'closed'] as const).map((f) => (
                  <Button key={f} variant={filter === f ? 'active' : 'ghost'} onClick={() => setFilter(f)} className="capitalize">{t(f)}</Button>
                ))}
              </div>
            }
            bodyClass="p-0"
          >
            {shown.length === 0 ? (
              <div className="p-4 text-xs text-muted">{t('No requests yet. Create one in')} <Link to="/request?tab=new" className="text-cyan-300 underline">{t('New Acquisition')}</Link> or save an archive scene from{' '}
                <Link to="/gis?tab=search" className="text-cyan-300 underline">{t('Imagery Explorer')}</Link>.
              </div>
            ) : (
              <div className="overflow-x-auto scroll-thin">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead className="label">
                    <tr className="border-b border-line"><th className="px-3 py-2">{t('Title')}</th><th>{t('Type')}</th><th>{t('Provider')}</th><th>{t('Status')}</th><th>{t('Reported by')}</th><th className="pr-3">{t('Updated')}</th></tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => {
                      const m = STATUS_META[r.status];
                      const lastSrc = r.history[r.history.length - 1]?.source ?? 'platform';
                      return (
                        <tr key={r.id} onClick={() => setSel(r.id)} className={cx('cursor-pointer border-b border-white/5 hover:bg-navy-800/60', sel === r.id && 'bg-cyan-400/10')}>
                          <td className="px-3 py-1.5 text-white">{r.title}</td>
                          <td className="text-slate-300">{r.kind === 'archive' ? t('Archive') : t('New acquisition')}</td>
                          <td>{providerById(r.providerId)?.shortName ?? r.providerId}</td>
                          <td><Badge tone={m.tone === 'idle' ? 'idle' : m.tone}>{m.label}</Badge></td>
                          <td className="text-muted">{t(SOURCE_LABEL[lastSrc])}</td>
                          <td className="pr-3 font-mono text-muted">{fmtUtc(r.updatedAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title={t('Projects')}>
            <div className="mb-2 flex gap-1.5">
              <Input value={projName} onChange={(e) => setProjName(e.target.value)} placeholder={t('New project name')} />
              <Button
                variant="primary"
                disabled={!projName.trim()}
                onClick={async () => {
                  await createProject(projName.trim());
                  setProjName('');
                  await reload();
                }}
              >{t('Add')} </Button>
            </div>
            <ul className="space-y-1">
              {projects.map((p) => (
                <li key={p.id} className="flex justify-between border-b border-white/5 py-1 text-xs">
                  <span className="text-slate-200">{p.name}</span>
                  <span className="font-mono text-muted">{reqs.filter((r) => r.projectId === p.id).length}</span>
                </li>
              ))}
              {!projects.length && <li className="text-xs text-muted">{t('No projects.')}</li>}
            </ul>
          </Panel>
        </div>
      </div>

      {cur && (
        <aside className="absolute inset-y-0 right-0 z-30 w-full max-w-[380px] overflow-y-auto border-l border-line bg-navy-900 p-4 shadow-2xl scroll-thin xl:static">
          <div className="mb-2 flex justify-between">
            <span className="label">{t('Request')}</span>
            <button onClick={() => setSel(null)} className="text-muted hover:text-white">✕</button>
          </div>
          <h2 className="text-sm font-semibold text-white">{cur.title}</h2>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge tone={STATUS_META[cur.status].tone === 'idle' ? 'idle' : STATUS_META[cur.status].tone}>{t(STATUS_META[cur.status].label)}</Badge>
            {cur.history.some((h) => h.source === 'user_reported') && <Badge tone="warn">{t('Contains user-reported status')}</Badge>}
            {!cur.history.some((h) => h.source === 'provider_api') && cur.kind === 'new_acquisition' && <Badge>{t('Not provider-confirmed')}</Badge>}
          </div>
          <dl className="mt-3">
            <KV k={t('Provider')} v={providerById(cur.providerId)?.name ?? cur.providerId} />
            <KV k={t('Kind')} v={cur.kind} />
            <KV k={t('Sensor')} v={cur.sensor} />
            <KV k={t('AOI area')} v={cur.aoi ? `${areaKm2(cur.aoi).toFixed(1)} km²` : '—'} />
            <KV k={t('Created')} v={fmtUtc(cur.createdAt)} mono />
            <KV k={t('Delivery')} v={cur.deliveryUrl ? <a className="text-cyan-300 underline" href={cur.deliveryUrl} target="_blank" rel="noreferrer">{t('link ↗')}</a> : '—'} />
          </dl>
          <Field label={t('Project')}>
            <Select
              value={cur.projectId ?? ''}
              onChange={async (e) => {
                await saveRequest({ ...cur, projectId: e.target.value || null });
                await reload();
              }}
            >
              <option value="">{t('— none —')}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>

          <div className="label mb-1 mt-4">{t('Parameters')}</div>
          <pre className="max-h-40 overflow-auto rounded bg-ink-950 p-2 font-mono text-[10px] text-slate-300 scroll-thin">{JSON.stringify(cur.params, null, 2)}</pre>

          <div className="label mb-1 mt-4">{t('Status history')}</div>
          <ol className="space-y-1.5 border-l border-line pl-3">
            {cur.history.map((h, i) => (
              <li key={i} className="text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="text-white">{t(STATUS_META[h.status].label)}</span>
                  <Badge tone={h.source === 'provider_api' ? 'ok' : h.source === 'user_reported' ? 'warn' : 'idle'}>{t(SOURCE_LABEL[h.source])}</Badge>
                </div>
                <div className="font-mono text-[10px] text-muted">{fmtUtc(h.at)}</div>
                {h.note && <div className="text-[11px] text-slate-400">{h.note}</div>}
              </li>
            ))}
          </ol>

          <div className="mt-4 space-y-2 rounded border border-line p-3">
            <div className="label">{t('Record a status update')}</div>
            <p className="text-[11px] text-muted">{t('No provider API is integrated, so provider-side statuses can only be entered by you and are stored as')} <b>{t('user-reported')}</b>.
            </p>
            <Select value={nextStatus} onChange={(e) => setNextStatus(e.target.value as RequestStatus)}>
              {STATUS_ORDER.map((s) => <option key={s} value={s}>{t(STATUS_META[s].label)}{STATUS_META[s].providerSide ? ` ${t('(user-reported)')}` : ''}</option>)}
            </Select>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Note, e.g. provider reference number')} />
            {nextStatus === 'delivered' && <Input value={delivery} onChange={(e) => setDelivery(e.target.value)} placeholder={t('Delivery link (https://…)')} />}
            <Button variant="primary" className="w-full" onClick={() => update(cur, nextStatus, STATUS_META[nextStatus].providerSide ? 'user_reported' : 'platform', note)}>{t('Add status')} </Button>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <Button onClick={() => downloadJson(`request-${cur.id.slice(0, 8)}.json`, cur)}>{t('Export JSON')}</Button>
            <Button onClick={() => update(cur, 'cancelled', 'platform', 'Cancelled in ORBITAL VISION')} disabled={cur.status === 'cancelled'}>{t('Cancel')}</Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!confirm(t('Delete this request permanently?'))) return;
                await deleteRequest(cur.id);
                setSel(null);
                await reload();
              }}
            >{t('Delete')} </Button>
          </div>
        </aside>
      )}
    </div>
  );
}
