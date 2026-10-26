// Background check for new imagery over coordinate slots, mounted once for the whole app.
// Runs shortly after the site opens, every 30 minutes while it stays open, and when the tab comes
// back into view. New scenes where the point is clear enough are shown as an in-app alert and,
// when the person has allowed it, as a browser notification. Clicking either opens the slot and
// compares the new image with last year.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../../i18n';
import { useMonitor } from '../../lib/monitorStore';
import { loadQc } from '../../lib/qc';
import { checkNewScenes } from '../../lib/slots';
import type { MonitorAoi, SlotWatch } from '../../lib/monitor';

const EVERY_MS = 30 * 60e3;
const MIN_GAP_MS = 25 * 60e3;

type Alert = { id: string; aoiId: string; name: string; scenes: SlotWatch['newScenes'] };

export const slotLink = (aoiId: string, compare = true) => `/monitor?tab=watch&slot=${encodeURIComponent(aoiId)}${compare ? '&compare=1' : ''}`;

export const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window;

const collName = (c: string) => (c === 'sentinel-2-l2a' ? 'Sentinel-2' : c === 'landsat-c2-l2' ? 'Landsat' : c.startsWith('sentinel-1') ? 'Sentinel-1' : c);

async function showBrowserNotification(title: string, body: string, tag: string, onClick: () => void) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    // some mobile browsers only allow notifications from a service worker
    const reg = await navigator.serviceWorker?.getRegistration?.().catch(() => undefined);
    await reg?.showNotification(title, { body, tag }).catch(() => undefined);
  }
}

let running = false;

/** Check every slot that has alerts on (skips slots checked in the last 25 minutes unless forced). */
export async function checkAllSlots(force = false, onNew?: (a: MonitorAoi, added: SlotWatch['newScenes']) => void) {
  if (running) return;
  running = true;
  try {
    const qc = loadQc();
    const list = useMonitor.getState().aois.filter((a) => a.point && a.active && (a.watch?.notify ?? true));
    for (const a of list) {
      if (!force && a.watch?.lastCheck && Date.now() - new Date(a.watch.lastCheck).getTime() < MIN_GAP_MS) continue;
      const res = await checkNewScenes(a, qc).catch(() => null);
      if (!res) continue;
      useMonitor.getState().setAois((l) => l.map((x) => (x.id === a.id ? { ...x, watch: res.watch } : x)));
      if (res.added.length) onNew?.(a, res.added);
    }
  } finally {
    running = false;
  }
}

export default function SlotWatcher() {
  const navigate = useNavigate();
  const lang = useLang((s) => s.lang);
  const L = (th: string, en: string) => (lang === 'th' ? th : en);
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    const onNew = (a: MonitorAoi, added: SlotWatch['newScenes']) => {
      const latest = added[0];
      setAlerts((l) => [{ id: `${a.id}:${latest.id}`, aoiId: a.id, name: a.name, scenes: added }, ...l.filter((x) => x.aoiId !== a.id)].slice(0, 4));
      const body = `${added.length > 1 ? `${added.length} ภาพ · ` : ''}${latest.datetime.slice(0, 10)} · ${collName(latest.collection)}${latest.cloud != null ? ` · เมฆเหนือจุด ${latest.cloud}%` : ''}\nคลิกเพื่อดูการเปลี่ยนแปลงเทียบกับปีที่แล้ว`;
      void showBrowserNotification(`ภาพใหม่: ${a.name}`, body, `slot-${a.id}`, () => navigate(slotLink(a.id)));
    };
    const tick = () => void checkAllSlots(false, onNew);
    const first = setTimeout(tick, 10e3);
    const timer = setInterval(tick, EVERY_MS);
    const onVis = () => document.visibilityState === 'visible' && tick();
    const onForce = () => void checkAllSlots(true, onNew);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('ov:check-slots', onForce);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('ov:check-slots', onForce);
    };
  }, [navigate]);

  if (!alerts.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-[min(340px,calc(100vw-2rem))] flex-col gap-2">
      {alerts.map((al) => (
        <div key={al.id} className="rounded-md border border-cyan-400/60 bg-ink-950/95 p-3 text-xs text-slate-200 shadow-lg backdrop-blur">
          <div className="font-semibold text-cyan-300">🛰 {L('ภาพใหม่เข้ามา', 'New imagery')} · {al.name}</div>
          <div className="mt-0.5 text-[11px] text-muted">
            {al.scenes.length > 1 ? L(`${al.scenes.length} ภาพ · `, `${al.scenes.length} scenes · `) : ''}
            {al.scenes[0].datetime.slice(0, 10)} · {collName(al.scenes[0].collection)}
            {al.scenes[0].cloud != null ? ` · ${L('เมฆเหนือจุด', 'cloud at point')} ${al.scenes[0].cloud}%` : ''}
          </div>
          <div className="mt-2 flex gap-2">
            <button
              className="rounded bg-cyan-500 px-2 py-1 text-[11px] font-semibold text-ink-950 hover:bg-cyan-400"
              onClick={() => {
                navigate(slotLink(al.aoiId));
                setAlerts((l) => l.filter((x) => x.id !== al.id));
              }}
            >
              {L('ดูการเปลี่ยนแปลงเทียบปีที่แล้ว', 'Compare with last year')}
            </button>
            <button className="text-[11px] text-muted hover:text-white" onClick={() => setAlerts((l) => l.filter((x) => x.id !== al.id))}>{L('ปิด', 'Dismiss')}</button>
          </div>
        </div>
      ))}
    </div>
  );
}
