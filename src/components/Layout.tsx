import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { NavLink, Outlet } from 'react-router-dom';
import { useOrbit } from '../store';
import { useLang } from '../i18n';
import { supabase, supabaseConfigured } from '../lib/supabase';
import { Badge, Button, Input, cx } from './ui';
import SlotWatcher from './monitor/SlotWatcher';

const NAV = [
  { to: '/', label: 'Home', icon: 'M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z' },
  { to: '/track', label: 'Track satellites', icon: 'M12 3a9 9 0 100 18 9 9 0 000-18zm-9 9h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18' },
  { to: '/gis', label: 'Analyse area', icon: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5' },
  { to: '/disaster', label: 'Disasters', icon: 'M12 3l10 17H2L12 3zm0 6v5m0 3v.5' },
  { to: '/monitor', label: 'Monitor areas', icon: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10-3a3 3 0 100 6 3 3 0 000-6z' },
  { to: '/request', label: 'Order imagery', icon: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4' },
  { to: '/data', label: 'Data & settings', icon: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M2 12h3M19 12h3' },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function UtcClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="font-mono text-[11px] text-slate-300">{now.toISOString().replace('T', ' ').slice(0, 19)} UTC</span>;
}

function AuthControl() {
  const [email, setEmail] = useState('');
  const [user, setUser] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user.email ?? null));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setUser(s?.user.email ?? null));
    return () => data.subscription.unsubscribe();
  }, []);
  if (!supabaseConfigured) return <Badge tone="warn" title={t('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to enable accounts')}>{t('Local storage')}</Badge>;
  if (user)
    return (
      <div className="flex items-center gap-2">
        <Badge tone="ok">{user}</Badge>
        <Button onClick={() => supabase!.auth.signOut()}>{t('Sign out')}</Button>
      </div>
    );
  return (
    <div className="relative">
      <Button onClick={() => setOpen(!open)}>{t('Sign in')}</Button>
      {open && (
        <div className="absolute right-0 top-9 z-50 w-72 space-y-2 rounded border border-line bg-navy-850 p-3 shadow-xl">
          <div className="label">{t('Email magic link')}</div>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          <Button
            variant="primary"
            className="w-full"
            onClick={async () => {
              const { error } = await supabase!.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
              setMsg(error ? error.message : t('Check your inbox for the sign-in link.'));
            }}
          >{t('Send link')} </Button>
          {msg && <p className="text-[11px] text-muted">{msg}</p>}
        </div>
      )}
    </div>
  );
}

function LangToggle() {
  const { lang, setLang } = useLang();
  return (
    <div className="flex overflow-hidden rounded border border-line font-mono text-[10px]">
      {(['th', 'en'] as const).map((l) => (
        <button key={l} onClick={() => setLang(l)} className={cx('px-2 py-1 uppercase', lang === l ? 'bg-cyan-400/15 text-cyan-300' : 'text-muted hover:text-white')}>
          {l}
        </button>
      ))}
    </div>
  );
}

export default function Layout() {
  const { status, sats, fetchedAt } = useOrbit();
  return (
    <div className="flex h-full flex-col bg-ink-900 md:flex-row">
      <nav className="order-2 flex shrink-0 overflow-x-auto border-t border-line bg-ink-950 md:order-1 md:w-[76px] md:flex-col md:overflow-visible md:border-r md:border-t-0">
        <div className="hidden h-14 items-center justify-center border-b border-line md:flex">
          <svg viewBox="0 0 32 32" className="h-7 w-7">
            <circle cx="16" cy="16" r="6.5" fill="#22d3ee" />
            <ellipse cx="16" cy="16" rx="14" ry="5" fill="none" stroke="#7ce7f7" strokeWidth="1.4" transform="rotate(-25 16 16)" />
          </svg>
        </div>
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            title={t(n.label)}
            className={({ isActive }) =>
              cx(
                'group relative flex min-w-[72px] flex-col items-center justify-center gap-1 px-1 py-2 text-muted transition hover:text-white md:min-h-[64px] md:min-w-0',
                isActive && 'text-cyan-300 md:before:absolute md:before:left-0 md:before:top-4 md:before:h-8 md:before:w-[2px] md:before:bg-cyan-400',
              )
            }
          >
            <Icon d={n.icon} />
            <span className="text-center text-[10px] leading-tight">{t(n.label)}</span>
          </NavLink>
        ))}
      </nav>
      <div className="order-1 flex min-h-0 min-w-0 flex-1 flex-col md:order-2">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line bg-ink-950/80 px-4">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs font-medium tracking-[0.3em] text-white">ORBITAL&nbsp;VISION</span>
            <span className="hidden text-[11px] text-muted lg:inline">{t('Multi-provider satellite imagery & tasking')}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline">
              {status === 'ready' ? (
                <Badge tone="cyan" title={`Orbital elements fetched ${fetchedAt?.toISOString()}`}>
                  {sats.length} {t('satellites')} · SGP4
                </Badge>
              ) : status === 'loading' ? (
                <Badge tone="info">{t('Loading orbits…')}</Badge>
              ) : status === 'error' ? (
                <Badge tone="bad">{t('Orbital data unavailable')}</Badge>
              ) : null}
            </span>
            <span className="hidden md:inline">
              <UtcClock />
            </span>
            <LangToggle />
            <AuthControl />
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
          <SlotWatcher />
        </main>
      </div>
    </div>
  );
}
