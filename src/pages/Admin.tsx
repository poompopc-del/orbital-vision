import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { Badge, Button, KV, Notice, PageHeader, Panel, cx } from '../components/ui';
import { PROVIDERS } from '../data/providers';
import { listAudit, storageMode, type AuditEntry } from '../lib/repo';
import { QUOTA_LIMITS, readQuotas, type QuotaKey } from '../lib/quotas';
import { supabase, supabaseConfigured, cesiumTokenConfigured } from '../lib/supabase';
import { useOrbit } from '../store';
import { fmtUtc } from '../lib/format';
import { refreshOrbits } from '../lib/orbitLoader';

const TABS = ['Users', 'Integrations', 'Credentials', 'Quotas', 'Audit log'] as const;

export default function Admin() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Integrations');
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [mode, setMode] = useState<'supabase' | 'local'>('local');
  const [me, setMe] = useState<{ email?: string; role?: string } | null>(null);
  const orbit = useOrbit();
  const quotas = readQuotas();

  useEffect(() => {
    void (async () => {
      setMode(await storageMode());
      setAudit(await listAudit());
      if (supabase) {
        const { data } = await supabase.auth.getUser();
        if (data.user) {
          const { data: prof } = await supabase.from('profiles').select('role').eq('id', data.user.id).maybeSingle();
          setMe({ email: data.user.email ?? undefined, role: prof?.role });
        }
      }
    })();
  }, [tab]);

  return (
    <div className="h-full overflow-y-auto p-4 scroll-thin">
      <PageHeader code={t('I · Administration')} title={t('Platform administration')} sub={t('Users, provider integrations, credentials, quotas and audit logs.')} />
      <div className="mb-4 flex flex-wrap gap-1">
        {TABS.map((tb) => (
          <Button key={tb} variant={tab === tb ? 'active' : 'ghost'} onClick={() => setTab(tb)}>{t(tb)}</Button>
        ))}
      </div>

      {tab === 'Users' && (
        <Panel title={t('Users & roles')}>
          {!supabaseConfigured ? (
            <Notice tone="warn">{t('Accounts need Supabase. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY, run supabase/schema.sql, then sign in.')}</Notice>
          ) : me ? (
            <dl className="max-w-md">
              <KV k={t('Signed in as')} v={me.email} />
              <KV k={t('Role')} v={me.role ?? 'analyst'} />
              <p className="mt-2 text-xs text-muted">
                Roles live in the <code>profiles</code> table. Promote an admin in the Supabase SQL editor — role changes are deliberately not possible from
                the browser with the publishable key.
              </p>
            </dl>
          ) : (
            <p className="text-xs text-muted">{t('Sign in (top right) to see your account.')}</p>
          )}
        </Panel>
      )}

      {tab === 'Integrations' && (
        <div className="space-y-4">
          <Panel title={t('Data sources')}>
            <dl className="max-w-2xl">
              <KV k={t('Orbital elements')} v={<span>{orbit.source || '—'} · {orbit.sats.length} satellites · fetched {fmtUtc(orbit.fetchedAt)}</span>} />
              <KV k={t('Archive search')} v="Earth Search STAC v1 (Element 84) — Sentinel-2 L2A, Landsat C2 L2, Sentinel-1 GRD" />
              <KV k={t('Geocoding')} v="OpenStreetMap Nominatim (rate-limited, 1 req/s)" />
              <KV k={t('Base map')} v={cesiumTokenConfigured ? 'Cesium ion (Bing Maps Aerial) + World Terrain' : 'Esri World Imagery (no ion token — terrain disabled)'} />
              <KV k={t('Persistence')} v={mode === 'supabase' ? 'Supabase (Postgres + PostGIS, RLS)' : 'Browser localStorage'} />
            </dl>
            <div className="mt-2"><Button onClick={() => refreshOrbits(true)}>{t('Force refresh orbital data')}</Button></div>
          </Panel>
          <Panel title={t('Provider integrations')} bodyClass="p-0">
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="label"><tr className="border-b border-line"><th className="px-3 py-2">{t('Provider')}</th><th>{t('Status')}</th><th>{t('Mode')}</th><th className="pr-3">{t('Notes')}</th></tr></thead>
                <tbody>
                  {PROVIDERS.map((p) => (
                    <tr key={p.id} className="border-b border-white/5">
                      <td className="px-3 py-1.5 text-white">{p.name}</td>
                      <td><Badge tone={p.integration === 'integrated-stac' ? 'ok' : 'warn'}>{p.integration === 'integrated-stac' ? 'Archive (STAC)' : t('Not integrated')}</Badge></td>
                      <td className="text-slate-300">{p.integration === 'integrated-stac' ? t('Search') : t('Manual / official portal')}</td>
                      <td className="pr-3 text-muted">{p.integrationNote}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}

      {tab === 'Credentials' && (
        <Panel title={t('API credentials')}>
          <Notice tone="warn">
            Provider API keys must never be placed in the browser. Store them as server-side environment variables in Vercel (without the VITE_ prefix)
            and call providers from serverless functions in <code>/api</code>. This page only shows which public configuration is present.
          </Notice>
          <dl className="mt-3 max-w-xl">
            {[
              ['VITE_CESIUM_ION_TOKEN', cesiumTokenConfigured],
              ['VITE_SUPABASE_URL', !!import.meta.env.VITE_SUPABASE_URL],
              ['VITE_SUPABASE_PUBLISHABLE_KEY', !!import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY],
            ].map(([k, v]) => (
              <KV key={k as string} k={k as string} v={<Badge tone={v ? 'ok' : 'idle'}>{v ? t('Configured') : t('Not set')}</Badge>} mono />
            ))}
            <KV k={t('Provider secrets')} v="Server-side only — not visible here" />
          </dl>
        </Panel>
      )}

      {tab === 'Quotas' && (
        <Panel title={t('Usage today (this browser)')}>
          <div className="space-y-3">
            {(Object.keys(QUOTA_LIMITS) as QuotaKey[]).map((k) => {
              const used = quotas[k];
              const lim = QUOTA_LIMITS[k];
              const pct = Math.min(100, (used / lim.perDay) * 100);
              return (
                <div key={k} className="max-w-xl">
                  <div className="flex justify-between text-xs"><span className="text-slate-200">{t(lim.label)}</span><span className="font-mono text-muted">{used} / {lim.perDay} {t('soft limit')}</span></div>
                  <div className="mt-1 h-1.5 rounded bg-ink-950"><div className={cx('h-1.5 rounded', pct > 80 ? 'bg-warn' : 'bg-cyan-400')} style={{ width: `${pct}%` }} /></div>
                  <div className="mt-0.5 text-[10px] text-muted">{lim.policy}</div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {tab === 'Audit log' && (
        <Panel title={`${t('Audit log')} (${mode === 'supabase' ? 'Supabase' : 'local'})`} bodyClass="p-0">
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[600px] text-left text-xs">
              <thead className="label"><tr className="border-b border-line"><th className="px-3 py-2">{t('Time')}</th><th>{t('Action')}</th><th className="pr-3">{t('Detail')}</th></tr></thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id} className="border-b border-white/5 align-top">
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted">{fmtUtc(a.at)}</td>
                    <td className="font-mono text-cyan-300">{a.action}</td>
                    <td className="pr-3 font-mono text-[10px] text-slate-400">{a.detail ? JSON.stringify(a.detail) : ''}</td>
                  </tr>
                ))}
                {!audit.length && <tr><td colSpan={3} className="px-3 py-3 text-muted">{t('No entries.')}</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
