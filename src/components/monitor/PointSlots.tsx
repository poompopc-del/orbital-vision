// Coordinate slots: type or paste coordinates, keep them as watched points, see them pinned on
// the map, compare the newest image with last year in one click, and get alerts for new images.
import { useMemo, useState } from 'react';
import { useLang } from '../../i18n';
import { Badge, Button, Field, Input, Notice, Panel, Select, cx } from '../ui';
import { useMonitor } from '../../lib/monitorStore';
import { aoiFromPolygon, lastRunOf, PURPOSES, SATELLITES, type MonitorAoi, type Purpose, type SensorMode } from '../../lib/monitor';
import { formatDec, formatDMM, parseCoord, squareAround } from '../../lib/coords';
import { emptyWatch } from '../../lib/slots';
import { notificationsSupported } from './SlotWatcher';

const useL = () => {
  const lang = useLang((s) => s.lang);
  return (th: string, en: string) => (lang === 'th' ? th : en);
};

const SIZES = [0.5, 1, 2, 5];
const STATUS_COLOR: Record<string, string> = { significant: '#ef4444', minor: '#f5b84b', none: '#4fd18b', insufficient: '#94a3b8', error: '#94a3b8', new: '#22d3ee' };

/** One line = one point. "name | coordinates" sets a name. */
export function parseLines(text: string) {
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf('|');
      const name = i >= 0 ? l.slice(0, i).trim() : '';
      const coord = i >= 0 ? l.slice(i + 1).trim() : l;
      return { line: l, name, r: parseCoord(coord) };
    });
}

export default function PointSlots({ selId, onSelect, onCompare, busy }: { selId: string | null; onSelect: (a: MonitorAoi) => void; onCompare: (a: MonitorAoi) => void; busy: boolean }) {
  const L = useL();
  const { aois, runs, setAois } = useMonitor();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [size, setSize] = useState(2);
  const [purpose, setPurpose] = useState<Purpose>('general');
  const [sensor, setSensor] = useState<SensorMode>('optical');
  const [perm, setPerm] = useState<string>(notificationsSupported() ? Notification.permission : 'unsupported');
  const parsed = useMemo(() => parseLines(text), [text]);
  const good = parsed.filter((p) => p.r.ok);
  const slots = aois.filter((a) => a.point);
  const lastCheck = slots.map((a) => a.watch?.lastCheck).filter(Boolean).sort().pop();

  const add = () => {
    if (!good.length) return;
    const now = Date.now();
    const made = good.map((p, i) => {
      const v = (p.r as { ok: true; value: { lat: number; lon: number } }).value;
      const nm = p.name || (good.length === 1 && name.trim()) || (good.length > 1 && name.trim() ? `${name.trim()} ${i + 1}` : `จุด ${formatDMM(v)}`);
      const a = aoiFromPolygon(nm, squareAround(v, size), 'OTHER', purpose, 7, sensor);
      return { ...a, id: `aoi_${now.toString(36)}_p${i}`, point: { ...v, text: p.line.includes('|') ? p.line.split('|')[1].trim() : p.line, sizeKm: size }, watch: emptyWatch(true) } as MonitorAoi;
    });
    setAois((l) => [...l, ...made]);
    setText('');
    setName('');
    onSelect(made[0]);
    // record what already exists so only later images count as new
    window.dispatchEvent(new Event('ov:check-slots'));
  };

  const upd = (id: string, f: (a: MonitorAoi) => MonitorAoi) => setAois((l) => l.map((a) => (a.id === id ? f(a) : a)));
  const askPermission = async () => {
    if (!notificationsSupported()) return;
    setPerm(await Notification.requestPermission());
  };

  return (
    <>
      <Panel title={L('เพิ่มจุดพิกัด (Slot)', 'Add coordinate slots')}>
        <div className="space-y-1.5">
          <Field label={L('พิกัด — บรรทัดละ 1 จุด · ใส่ชื่อได้แบบ “ชื่อ | พิกัด”', 'Coordinates — one point per line · “name | coordinates” sets a name')}>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              placeholder={"11°34.2819'N, 104°40.8893'E\nบ้านท่าเรือ | 11.571365, 104.681488\n12°10'05\"N 102°45'30\"E"}
              className="w-full rounded border border-line bg-ink-900 px-2 py-1.5 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
            />
          </Field>
          {parsed.length > 0 && (
            <ul className="space-y-0.5 font-mono text-[10px]">
              {parsed.map((p, i) => (
                <li key={i} className={p.r.ok ? 'text-ok' : 'text-bad'}>
                  {p.r.ok ? `✓ ${p.name ? `${p.name} · ` : ''}${formatDMM(p.r.value)}  (${formatDec(p.r.value)})` : `✗ ${p.line} — ${p.r.error}`}
                </li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <Field label={L('ชื่อ (ถ้าไม่ใส่จะใช้พิกัด)', 'Name (optional)')}><Input value={name} onChange={(e) => setName(e.target.value)} className="!py-1 text-xs" /></Field>
            <Field label={L('ขนาดพื้นที่รอบจุด', 'Area around the point')}>
              <Select value={size} onChange={(e) => setSize(+e.target.value)} className="!py-1 text-xs">{SIZES.map((s) => <option key={s} value={s}>{s} × {s} {L('กม.', 'km')}</option>)}</Select>
            </Field>
            <Field label={L('เฝ้าดูเรื่อง', 'Watch for')}>
              <Select value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)} className="!py-1 text-xs">{PURPOSES.map((p) => <option key={p.id} value={p.id}>{L(p.labelTh, p.label)}</option>)}</Select>
            </Field>
            <Field label={L('ดาวเทียม', 'Satellite')}>
              <Select value={sensor} onChange={(e) => setSensor(e.target.value as SensorMode)} className="!py-1 text-xs">{SATELLITES.filter((x) => x.id !== 'auto').map((x) => <option key={x.id} value={x.id}>{L(x.th, x.en)}</option>)}</Select>
            </Field>
          </div>
          <Button variant="primary" disabled={!good.length || good.length !== parsed.length} onClick={add}>
            {good.length > 1 ? L(`เพิ่ม ${good.length} จุด`, `Add ${good.length} points`) : L('เพิ่มจุด', 'Add point')}
          </Button>
        </div>
      </Panel>

      <Panel title={L(`จุดที่เฝ้าดู (${slots.length})`, `Watched points (${slots.length})`)}>
        <div className="space-y-1.5">
          {perm !== 'granted' && (
            <Notice tone="info">
              <div className="flex items-center justify-between gap-2">
                <span>
                  {perm === 'unsupported'
                    ? L('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน — จะเห็นการแจ้งเตือนในหน้าเว็บแทน', 'This browser has no notifications — alerts show inside the page')
                    : perm === 'denied'
                      ? L('การแจ้งเตือนถูกปิดในเบราว์เซอร์ — เปิดได้ที่การตั้งค่าเว็บไซต์ (ไอคอนแม่กุญแจ)', 'Notifications are blocked — allow them in the site settings (padlock icon)')
                      : L('เปิดการแจ้งเตือนเพื่อให้เด้งเตือนเมื่อมีภาพใหม่ แม้เปิดแท็บอื่นอยู่', 'Allow notifications to be alerted about new images while in another tab')}
                </span>
                {perm === 'default' && <Button variant="primary" onClick={askPermission}>{L('เปิดแจ้งเตือน', 'Allow')}</Button>}
              </div>
            </Notice>
          )}
          <div className="flex items-center justify-between gap-2 text-[10px] text-muted">
            <span>{lastCheck ? L(`ตรวจภาพใหม่ล่าสุด ${new Date(lastCheck).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })}`, `Last check ${new Date(lastCheck).toLocaleString()}`) : L('ยังไม่ได้ตรวจภาพใหม่', 'Not checked yet')}</span>
            <button className="text-cyan-300 hover:underline disabled:opacity-40" disabled={!slots.length} onClick={() => window.dispatchEvent(new Event('ov:check-slots'))}>{L('ตรวจภาพใหม่ตอนนี้', 'Check now')}</button>
          </div>
          {!slots.length && <p className="text-xs text-muted">{L('ยังไม่มีจุด — วางพิกัดด้านบนแล้วกด “เพิ่มจุด”', 'No points yet — paste coordinates above and add them')}</p>}
          <ul className="max-h-[40vh] space-y-1 overflow-y-auto scroll-thin">
            {slots.map((a) => {
              const r = lastRunOf(a.id, runs);
              const st = !r ? 'new' : r.status !== 'ok' ? (r.status === 'error' ? 'error' : 'insufficient') : r.level ?? 'none';
              const fresh = a.watch?.newScenes ?? [];
              const notify = a.watch?.notify ?? true;
              return (
                <li key={a.id} className={cx('rounded border px-2 py-1.5', a.id === selId ? 'border-cyan-400/60 bg-cyan-400/10' : 'border-line')}>
                  <div className="flex items-start gap-2">
                    <button className="min-w-0 flex-1 text-left" onClick={() => onSelect(a)} title={L('แสดงบนแผนที่', 'Show on map')}>
                      <span className="flex items-center gap-1.5">
                        <span className="text-sm leading-none">📍</span>
                        <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: STATUS_COLOR[st] }} />
                        <span className="truncate text-xs text-white">{a.name}</span>
                        {fresh.length > 0 && <Badge tone="cyan">{L(`ภาพใหม่ ${fresh.length}`, `${fresh.length} new`)}</Badge>}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-muted">{formatDMM(a.point!)} · {a.point!.sizeKm}×{a.point!.sizeKm} {L('กม.', 'km')}</span>
                      <span className="block truncate text-[10px] text-muted">
                        {r ? L(`ผลล่าสุด ${r.A?.datetime.slice(0, 10) ?? '?'} → ${r.B?.datetime.slice(0, 10) ?? '?'}`, `Last result ${r.A?.datetime.slice(0, 10) ?? '?'} → ${r.B?.datetime.slice(0, 10) ?? '?'}`) : L('ยังไม่เคยเทียบภาพ', 'Not compared yet')}
                        {fresh[0] ? L(` · ภาพใหม่ล่าสุด ${fresh[0].datetime.slice(0, 10)}`, ` · newest ${fresh[0].datetime.slice(0, 10)}`) : ''}
                      </span>
                    </button>
                    <button
                      className={cx('text-sm', notify ? 'opacity-100' : 'opacity-35 grayscale')}
                      title={notify ? L('แจ้งเตือนภาพใหม่: เปิด (กดเพื่อปิด)', 'New-image alerts on (click to turn off)') : L('แจ้งเตือนภาพใหม่: ปิด (กดเพื่อเปิด)', 'Alerts off (click to turn on)')}
                      onClick={() => upd(a.id, (x) => ({ ...x, watch: { ...(x.watch ?? emptyWatch()), notify: !notify } }))}
                    >
                      🔔
                    </button>
                    <button
                      className="text-xs text-muted hover:text-bad"
                      title={L('ลบจุดนี้', 'Remove this point')}
                      onClick={() => confirm(L(`ลบ “${a.name}”?`, `Remove “${a.name}”?`)) && setAois((l) => l.filter((x) => x.id !== a.id))}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Button variant={fresh.length ? 'primary' : 'ghost'} disabled={busy} onClick={() => onCompare(a)}>
                      {L('เทียบภาพล่าสุดกับปีที่แล้ว', 'Latest vs last year')}
                    </Button>
                    {fresh.length > 0 && <Button onClick={() => upd(a.id, (x) => ({ ...x, watch: { ...x.watch!, newScenes: [] } }))}>{L('ดูแล้ว', 'Mark seen')}</Button>}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-[10px] leading-relaxed text-muted">
            {L(
              'ระบบตรวจภาพใหม่ตอนเปิดเว็บ ทุก 30 นาทีระหว่างที่เปิดค้างไว้ และเมื่อกลับมาที่แท็บ · แจ้งเฉพาะภาพที่เมฆเหนือจุดไม่เกินเกณฑ์ (ภาพที่มีเมฆบังจุดจะไม่เตือน) · ถ้าปิดเว็บอยู่จะยังไม่เตือน — เปิดเว็บครั้งถัดไประบบจะตรวจและแจ้งภาพที่เข้ามาระหว่างนั้น · “ปีที่แล้ว” = ภาพที่ใกล้วันเดียวกันของปีก่อนที่สุด ดาวเทียมและวงโคจรเดียวกันถ้ามี',
              'New images are checked when the site opens, every 30 minutes while it stays open and when you return to the tab · only images where the point is clear enough trigger an alert · nothing alerts while the site is closed; the next visit reports what arrived meanwhile · “last year” = the clear image closest to the same date a year earlier, same satellite and orbit when possible',
            )}
          </p>
        </div>
      </Panel>
    </>
  );
}
