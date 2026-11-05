import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { tl } from '../lib/classify/i18n';
import { useOrbit } from '../store';
import { useLang } from '../i18n';
import { supabase, supabaseConfigured } from '../lib/supabase';
import { Badge, Button, Input, cx } from './ui';

/**
 * Navigation: six work areas. Every entry points at an existing page/tab (no function was removed;
 * old URLs still redirect in App.tsx). A group opens a fly-out (desktop) or bottom sheet (mobile)
 * so the menu never takes space from the map.
 */
interface NavItem {
  label: string;
  th: string;
  hint: string;
  hintTh: string;
  path: string;
  tab?: string;
  panel?: string;
}
interface NavGroup {
  id: string;
  label: string;
  th: string;
  icon: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'mission', label: 'Mission Control', th: 'ศูนย์ควบคุมภารกิจ',
    icon: 'M12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM4.5 16.5C2 13 4.6 7.3 10.3 4.6S21.7 3.4 21 7M19.5 7.5C22 11 19.4 16.7 13.7 19.4S2.3 20.6 3 17',
    items: [
      { label: 'Satellite tracking', th: 'ติดตามดาวเทียม', hint: 'Live positions from SGP4', hintTh: 'ตำแหน่งปัจจุบันคำนวณด้วย SGP4', path: '/track', tab: 'live' },
      { label: 'Pass prediction', th: 'คาดการณ์การโคจรผ่าน', hint: 'When satellites rise above your station', hintTh: 'เวลาที่ดาวเทียมขึ้นเหนือสถานีของคุณ', path: '/track', tab: 'passes' },
      { label: 'Imaging swaths', th: 'แนวถ่ายภาพ', hint: 'Where imaging satellites can see now', hintTh: 'บริเวณที่ดาวเทียมถ่ายภาพมองเห็นอยู่ตอนนี้', path: '/track', tab: 'imaging' },
      { label: 'Coverage planner', th: 'วางแผนการถ่ายครอบคลุม', hint: 'When a swath may cover your area', hintTh: 'ช่วงเวลาที่แนวถ่ายภาพอาจผ่านพื้นที่ของคุณ', path: '/track', tab: 'coverage' },
    ],
  },
  {
    id: 'imagery', label: 'Imagery', th: 'ภาพถ่ายดาวเทียม',
    icon: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
    items: [
      { label: 'Search satellite images', th: 'ค้นหาภาพดาวเทียม', hint: 'Area → timeline → pick images A and B', hintTh: 'เลือกพื้นที่ → ไทม์ไลน์ → เลือกภาพ A และ B', path: '/imagery', tab: 'flow' },
      { label: 'Image archive', th: 'คลังภาพ', hint: 'Every archive scene over the area as a list', hintTh: 'ภาพในคลังทั้งหมดที่ครอบคลุมพื้นที่ แสดงเป็นรายการ', path: '/gis', tab: 'search' },
      { label: 'Image comparison', th: 'เปรียบเทียบภาพ', hint: 'Swipe, blink and measure two scenes', hintTh: 'เลื่อน กะพริบ และวัดภาพสองภาพ', path: '/gis', tab: 'compare' },
      { label: 'New acquisition', th: 'สั่งถ่ายภาพใหม่', hint: 'Commercial tasking request package', hintTh: 'เตรียมคำขอถ่ายภาพจากผู้ให้บริการเชิงพาณิชย์', path: '/request', tab: 'new' },
    ],
  },
  {
    id: 'analysis', label: 'Image Analysis', th: 'วิเคราะห์ภาพ',
    icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    items: [
      { label: 'Spectral indices', th: 'ดัชนีเชิงสเปกตรัม', hint: 'NDVI, NDWI, NBR… with legend and histogram', hintTh: 'NDVI, NDWI, NBR ฯลฯ พร้อมคำอธิบายสีและฮิสโทแกรม', path: '/gis', tab: 'map', panel: 'spectral' },
      { label: 'Land cover', th: 'จำแนกสิ่งปกคลุมดิน', hint: 'Multi-index classification with confidence', hintTh: 'จำแนกด้วยหลายดัชนีพร้อมระดับความเชื่อมั่น', path: '/gis', tab: 'map', panel: 'landcover' },
      { label: 'Change detection', th: 'ตรวจจับการเปลี่ยนแปลง', hint: 'Index or class change between two dates', hintTh: 'การเปลี่ยนแปลงของดัชนีหรือประเภทระหว่างสองวัน', path: '/gis', tab: 'map', panel: 'change' },
      { label: 'Flood analysis', th: 'วิเคราะห์น้ำท่วม', hint: 'Water and possible flood, optical or radar', hintTh: 'แหล่งน้ำและพื้นที่ที่อาจมีน้ำท่วม จากภาพออปติคัลหรือเรดาร์', path: '/gis', tab: 'map', panel: 'flood' },
      { label: 'Terrain analysis', th: 'วิเคราะห์ภูมิประเทศ', hint: 'Elevation, slope, watershed', hintTh: 'ความสูง ความลาดชัน ลุ่มน้ำ', path: '/gis', tab: 'map', panel: 'terrain' },
      { label: 'Advanced GIS', th: 'GIS ขั้นสูง', hint: 'Layer manager and every tool on one map', hintTh: 'จัดการชั้นข้อมูลและเครื่องมือทั้งหมดบนแผนที่เดียว', path: '/gis', tab: 'map', panel: 'layers' },
    ],
  },
  {
    id: 'monitoring', label: 'Monitoring', th: 'เฝ้าระวัง',
    icon: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zm10-3a3 3 0 100 6 3 3 0 000-6z',
    items: [
      { label: 'Area watchlist', th: 'รายการพื้นที่เฝ้าระวัง', hint: 'Automatic checks against new imagery', hintTh: 'ตรวจอัตโนมัติเมื่อมีภาพใหม่', path: '/imagery', tab: 'watch' },
      { label: 'Change reports', th: 'รายงานการเปลี่ยนแปลง', hint: 'Report from the latest monitoring results', hintTh: 'รายงานจากผลเฝ้าระวังล่าสุด', path: '/imagery', tab: 'report' },
      { label: 'Disaster monitoring', th: 'ติดตามภัยพิบัติ', hint: 'Floods, fire, earthquakes, storms, PM2.5', hintTh: 'น้ำท่วม ไฟป่า แผ่นดินไหว พายุ PM2.5', path: '/disaster', tab: 'map' },
      { label: 'Flood news', th: 'ข่าวน้ำท่วม', hint: 'News located on the map, checked with imagery', hintTh: 'ข่าวที่ระบุตำแหน่งบนแผนที่ และตรวจกับภาพดาวเทียม', path: '/disaster', tab: 'news' },
      { label: 'Situation report', th: 'รายงานสถานการณ์', hint: 'Report from the latest open data', hintTh: 'รายงานจากข้อมูลเปิดล่าสุด', path: '/disaster', tab: 'report' },
    ],
  },
  {
    id: 'data', label: 'Data & Providers', th: 'ข้อมูลและผู้ให้บริการ',
    icon: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    items: [
      { label: 'Satellite catalog', th: 'แคตตาล็อกดาวเทียม', hint: 'Missions, orbits and sensors', hintTh: 'ภารกิจ วงโคจร และเซนเซอร์', path: '/data', tab: 'catalog' },
      { label: 'Imagery providers', th: 'ผู้ให้บริการภาพ', hint: 'Archive and tasking providers compared', hintTh: 'เปรียบเทียบผู้ให้บริการคลังภาพและการสั่งถ่าย', path: '/data', tab: 'providers' },
      { label: 'Data sources', th: 'แหล่งข้อมูล', hint: 'Open-data feeds and their health', hintTh: 'แหล่งข้อมูลเปิดและสถานะการเชื่อมต่อ', path: '/disaster', tab: 'sources' },
    ],
  },
  {
    id: 'workspace', label: 'Workspace & Admin', th: 'พื้นที่ทำงานและผู้ดูแล',
    icon: 'M3 7h18v13H3zM8 7V4h8v3M3 12h18',
    items: [
      { label: 'Projects & orders', th: 'โปรเจกต์และคำขอ', hint: 'Your requests, their status and projects', hintTh: 'คำขอของคุณ สถานะ และโปรเจกต์', path: '/request', tab: 'list' },
      { label: 'Administration', th: 'ผู้ดูแลระบบ', hint: 'Users, integrations, quotas, audit log', hintTh: 'ผู้ใช้ การเชื่อมต่อ โควตา และบันทึกการใช้งาน', path: '/data', tab: 'admin' },
    ],
  },
];

const hrefOf = (it: NavItem) => `${it.path}${it.tab ? `?tab=${it.tab}${it.panel ? `&panel=${it.panel}` : ''}` : ''}`;
const DEFAULT_TAB: Record<string, string> = { '/track': 'live', '/imagery': 'flow', '/gis': 'map', '/disaster': 'map', '/request': 'new', '/data': 'catalog' };

/** The nav item that matches the current URL (most specific match wins). */
export function activeNav(pathname: string, search: string): { group: NavGroup; item: NavItem } | null {
  const q = new URLSearchParams(search);
  const tab = q.get('tab') ?? DEFAULT_TAB[pathname];
  const panel = q.get('panel');
  let best: { group: NavGroup; item: NavItem; score: number } | null = null;
  for (const g of NAV_GROUPS)
    for (const it of g.items) {
      if (it.path !== pathname || (it.tab && it.tab !== tab)) continue;
      const score = 1 + (it.tab ? 1 : 0) + (it.panel && it.panel === panel ? 2 : it.panel ? -0.5 : 0);
      if (!best || score > best.score) best = { group: g, item: it, score };
    }
  return best;
}

function Icon({ d, className = 'h-[18px] w-[18px]' }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden>
      <circle cx="16" cy="16" r="5.5" fill="#2fc4b2" />
      <g className="ov-orbit">
        <ellipse cx="16" cy="16" rx="13.5" ry="5" fill="none" stroke="#7fe3d6" strokeOpacity="0.55" strokeWidth="1.2" transform="rotate(-25 16 16)" />
        <circle cx="28.2" cy="10.3" r="1.6" fill="#e2ad55" />
      </g>
    </svg>
  );
}

function NavMenu() {
  const loc = useLocation();
  const nav = useNavigate();
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const act = activeNav(loc.pathname, loc.search);
  useEffect(() => setOpen(null), [loc.pathname, loc.search]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(null);
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);
  const g = NAV_GROUPS.find((x) => x.id === open);
  return (
    <div ref={ref} className="contents">
      <nav aria-label={tl('Main menu', 'เมนูหลัก')} className="order-2 flex shrink-0 overflow-x-auto border-t border-line bg-ink-950 md:order-1 md:w-[76px] md:flex-col md:overflow-visible md:border-r md:border-t-0">
        <NavLink to="/" end title={t('Home')} className="hidden h-14 items-center justify-center border-b border-line md:flex" aria-label="ORBITAL VISION — home">
          <Logo />
        </NavLink>
        <NavLink
          to="/"
          end
          className={({ isActive }) => cx('flex min-w-[64px] flex-col items-center justify-center gap-1 px-1 py-2 text-muted md:hidden', isActive && 'text-cyan-300')}
        >
          <Icon d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z" />
          <span className="text-[10px] leading-tight">{t('Home')}</span>
        </NavLink>
        {NAV_GROUPS.map((n) => {
          const active = act?.group.id === n.id;
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => setOpen(open === n.id ? null : n.id)}
              aria-expanded={open === n.id}
              aria-haspopup="menu"
              title={tl(n.label, n.th)}
              className={cx(
                'group relative flex min-w-[72px] flex-col items-center justify-center gap-1 px-1 py-2 transition-colors duration-150 md:min-h-[62px] md:min-w-0',
                active || open === n.id ? 'text-cyan-300' : 'text-muted hover:text-white',
                active && 'md:before:absolute md:before:left-0 md:before:top-3.5 md:before:h-8 md:before:w-[2px] md:before:rounded-r md:before:bg-cyan-400',
                open === n.id && 'bg-white/[0.04]',
              )}
            >
              <Icon d={n.icon} />
              <span className="text-center text-[10px] leading-tight">{tl(n.label, n.th)}</span>
            </button>
          );
        })}
      </nav>
      {g && (
        <div
          role="menu"
          aria-label={tl(g.label, g.th)}
          className="ov-sheet fixed inset-x-2 bottom-[64px] z-[60] max-h-[70vh] overflow-y-auto rounded-md border border-line bg-navy-900 p-2 shadow-float scroll-thin md:absolute md:inset-x-auto md:bottom-auto md:left-[76px] md:top-12 md:w-[300px] md:rounded-l-none"
        >
          <div className="label px-2 pb-1.5 pt-1">{tl(g.label, g.th)}</div>
          {g.items.map((it) => {
            const on = act?.item === it;
            return (
              <button
                key={hrefOf(it)}
                role="menuitem"
                type="button"
                onClick={() => nav(hrefOf(it))}
                className={cx('block w-full rounded px-2 py-1.5 text-left transition-colors duration-150', on ? 'bg-cyan-400/10' : 'hover:bg-white/[0.05]')}
              >
                <div className={cx('text-[13px]', on ? 'text-cyan-300' : 'text-slate-100')}>{tl(it.label, it.th)}</div>
                <div className="text-[11px] leading-snug text-muted">{tl(it.hint, it.hintTh)}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Breadcrumb() {
  const loc = useLocation();
  const act = activeNav(loc.pathname, loc.search);
  if (!act) return <span className="hidden text-[11px] text-muted lg:inline">{t('Multi-provider satellite imagery & tasking')}</span>;
  return (
    <span className="hidden min-w-0 items-center gap-1.5 truncate text-[11px] sm:flex">
      <span className="text-muted">{tl(act.group.label, act.group.th)}</span>
      <span className="text-slate-700">/</span>
      <span className="text-slate-200">{tl(act.item.label, act.item.th)}</span>
    </span>
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
        <button key={l} onClick={() => setLang(l)} className={cx('px-2 py-1 uppercase transition-colors duration-150', lang === l ? 'bg-cyan-400/15 text-cyan-300' : 'text-muted hover:text-white')}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** Fades the page in on route / tab change (opacity only; the globe canvas is never transformed). */
function PageFrame({ children }: { children: ReactNode }) {
  const loc = useLocation();
  return <div key={`${loc.pathname}?${new URLSearchParams(loc.search).get('tab') ?? ''}`} className="ov-page h-full">{children}</div>;
}

export default function Layout() {
  const { status, sats, fetchedAt } = useOrbit();
  return (
    <div className="relative flex h-full flex-col bg-ink-900 md:flex-row">
      <NavMenu />
      <div className="order-1 flex min-h-0 min-w-0 flex-1 flex-col md:order-2">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line bg-ink-950/80 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="shrink-0 font-mono text-xs font-medium tracking-[0.3em] text-white">ORBITAL&nbsp;VISION</span>
            <Breadcrumb />
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
          <PageFrame>
            <Outlet />
          </PageFrame>
        </main>
      </div>
    </div>
  );
}
