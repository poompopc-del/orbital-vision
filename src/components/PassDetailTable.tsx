// Ground-station pass table: one row per pass, grouped by local date, in the layout receiving
// stations use (UTC window · local date · AOS · LOS · duration · max elevation · comment).
// Passes whose max elevation is below the abort limit are marked "abort".
import { useMemo, useState, type ReactNode } from 'react';
import * as sat from 'satellite.js';
import { t } from '../i18n';
import type { Observer, VisiblePass } from '../lib/lookangles';
import type { SatRecord } from '../lib/orbit';
import { Button, cx } from './ui';

const TZ = 7 * 3600e3; // Thailand time (UTC+7)
const pad = (n: number) => String(n).padStart(2, '0');
const dmy = (ms: number) => { const d = new Date(ms); return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`; };
const hms = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const durTxt = (s: number) => `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;

/** Mean motion in revolutions per day, from the parsed elements. */
const revPerDay = (r: SatRecord) => (r.satrec.no * 1440) / (2 * Math.PI);

/** First moment SGP4 can no longer propagate (the model's decay) between `from` and `until`.
 *  Scans forward in 30 s steps: near the end propagation can fail on and off. */
function decayTime(r: SatRecord, from: number, until: number): number | null {
  for (let t = from; t <= until; t += 30_000) {
    const pv = sat.propagate(r.satrec, new Date(t));
    if (!(pv && pv.position && typeof pv.position !== 'boolean')) return t;
  }
  return null;
}

export default function PassDetailTable({
  passes, sats, observer, from, to, onClose,
}: {
  passes: VisiblePass[];
  sats: SatRecord[];
  observer: Observer;
  from: Date;
  to: Date;
  onClose: () => void;
}) {
  const [abortBelow, setAbortBelow] = useState(5);
  const satIds = useMemo(() => [...new Set(passes.map((p) => p.sat.noradId))], [passes]);
  const [only, setOnly] = useState<string>(satIds.length === 1 ? satIds[0] : 'all');
  const list = passes.filter((p) => only === 'all' || p.sat.noradId === only);

  // warnings per satellite: element age, decay
  const notes = useMemo(() => {
    const out: { id: string; text: string; tone: 'warn' | 'bad' }[] = [];
    for (const r of sats) {
      if (only !== 'all' && r.noradId !== only) continue;
      const ageD = (Date.now() - r.epoch.getTime()) / 86400e3;
      const mm = revPerDay(r);
      const dec = decayTime(r, from.getTime(), to.getTime());
      if (dec != null) {
        out.push({ id: r.noradId + 'd', tone: 'bad', text: `${r.name}: ${t('the orbit model stops after')} ${dmy(dec + TZ)} ${hms(dec + TZ)} (${t('Thailand time')}) — ${t('the satellite is very low and may re-enter; passes after this cannot be computed')}` });
      } else if (mm > 16) {
        out.push({ id: r.noradId + 'm', tone: 'bad', text: `${r.name}: ${mm.toFixed(2)} ${t('rev/day — the satellite is decaying fast; times drift by minutes per day, refresh elements before every pass')}` });
      }
      if (ageD > 1.5) out.push({ id: r.noradId + 'a', tone: 'warn', text: `${r.name}: ${t('elements are')} ${ageD.toFixed(1)} ${t('days old')}` });
    }
    return out;
  }, [sats, only, from, to]);

  // group by local date
  const groups = useMemo(() => {
    const m = new Map<string, VisiblePass[]>();
    for (const p of [...list].sort((a, b) => a.aos.getTime() - b.aos.getTime())) {
      const k = dmy(p.aos.getTime() + TZ);
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.entries()];
  }, [list]);

  const csv = () => {
    const head = 'satellite,norad,date_utc,aos_utc,los_utc,date_local,aos_local,los_local,duration_s,max_el_deg,aos_az,los_az,comment';
    const rows = list.map((p) => {
      const a = p.aos.getTime(), l = p.los.getTime();
      return [JSON.stringify(p.sat.name), p.sat.noradId, dmy(a), hms(a), hms(l), dmy(a + TZ), hms(a + TZ), hms(l + TZ), Math.round(p.durationS), p.maxEl.toFixed(2), p.aosAz.toFixed(1), p.losAz.toFixed(1), p.maxEl < abortBelow ? 'abort' : ''].join(',');
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + [head, ...rows].join('\n')], { type: 'text/csv' }));
    a.download = `passes_${observer.name.replace(/[^\w-]+/g, '_')}_${dmy(from.getTime() + TZ)}.csv`;
    a.click();
  };

  const epochOf = (id: string) => sats.find((s) => s.noradId === id)?.epoch;

  return (
    <div className="absolute inset-3 z-30 flex flex-col rounded-md border border-line bg-ink-900 shadow-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="text-sm font-semibold text-white">{t('Pass detail table')}</h2>
        <span className="font-mono text-[11px] text-muted">
          {observer.name} · {observer.lat.toFixed(5)}, {observer.lon.toFixed(5)}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
          {satIds.length > 1 && (
            <select value={only} onChange={(e) => setOnly(e.target.value)} className="rounded border border-line bg-ink-950 px-2 py-1 text-xs text-white">
              <option value="all">{t('All satellites')}</option>
              {satIds.map((id) => <option key={id} value={id}>{passes.find((p) => p.sat.noradId === id)!.sat.name}</option>)}
            </select>
          )}
          <label className="flex items-center gap-1 text-muted">
            {t('abort below')}
            <input type="number" min={0} max={90} step={0.5} value={abortBelow} onChange={(e) => setAbortBelow(+e.target.value)} className="w-14 rounded border border-line bg-ink-950 px-1 py-0.5 font-mono text-white" />°
          </label>
          <Button onClick={csv}>CSV</Button>
          <Button onClick={() => window.print()}>{t('Print')}</Button>
          <Button onClick={onClose} aria-label={t('Close')}>✕</Button>
        </div>
      </div>

      {notes.length > 0 && (
        <div className="space-y-0.5 border-b border-line px-3 py-1.5 text-[11px]">
          {notes.map((n) => <p key={n.id} className={n.tone === 'bad' ? 'text-bad' : 'text-warn'}>⚠ {n.text}</p>)}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto scroll-thin">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="sticky top-0 bg-navy-800 text-[11px] font-semibold text-slate-200">
            <tr>
              {(only === 'all' && satIds.length > 1) && <th className="px-3 py-2">{t('Satellite')}</th>}
              <th className="px-3 py-2">DateTime (UTC)</th>
              <th className="px-2 text-center">Date ({t('local')})</th>
              <th className="px-2 text-center">AOS ({t('local')})</th>
              <th className="px-2 text-center">LOS ({t('local')})</th>
              <th className="px-2 text-center">{t('Duration')}</th>
              <th className="px-2 text-center">Max EL.</th>
              <th className="px-2 text-center">Az AOS → LOS</th>
              <th className="px-3 text-center">{t('Comments')}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(([day, ps]) => (
              <FragmentRows key={day} day={day} cols={only === 'all' && satIds.length > 1 ? 9 : 8}>
                {ps.map((p) => {
                  const a = p.aos.getTime(), l = p.los.getTime();
                  const abort = p.maxEl < abortBelow;
                  return (
                    <tr key={`${p.sat.noradId}-${a}`} className={cx('border-b border-white/5', abort && 'bg-bad/10')}>
                      {(only === 'all' && satIds.length > 1) && <td className="px-3 py-1.5 text-white">{p.sat.name}</td>}
                      <td className="px-3 py-1.5 font-mono leading-snug">
                        {DOW[new Date(a).getUTCDay()]},{dmy(a)}
                        <br />
                        {hms(a)} - {hms(l)} (UTC)
                      </td>
                      <td className="text-center font-mono">{dmy(a + TZ)}</td>
                      <td className="text-center font-mono text-white">{hms(a + TZ)}</td>
                      <td className="text-center font-mono text-white">{hms(l + TZ)}</td>
                      <td className="text-center font-mono">{durTxt(p.durationS)}</td>
                      <td className={cx('text-center font-mono', abort ? 'text-bad' : p.maxEl >= 30 ? 'text-ok' : 'text-white')}>{p.maxEl.toFixed(2)}°</td>
                      <td className="text-center font-mono text-muted">{p.aosAz.toFixed(0)}° → {p.losAz.toFixed(0)}°</td>
                      <td className={cx('px-3 text-center', abort ? 'text-bad' : 'text-muted')}>{abort ? 'abort' : '-'}</td>
                    </tr>
                  );
                })}
              </FragmentRows>
            ))}
            {!list.length && (
              <tr><td colSpan={9} className="p-4 text-center text-muted">{t('No passes above the minimum elevation in this window.')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="border-t border-line px-3 py-1.5 font-mono text-[10px] text-muted">
        {t('AOS / LOS at the minimum elevation set on the left')} · SGP4 ·{' '}
        {satIds.map((id) => {
          const e = epochOf(id);
          const name = passes.find((p) => p.sat.noradId === id)!.sat.name;
          return e ? <span key={id} className="mr-2">{name} TLE epoch {e.toISOString().slice(0, 16).replace('T', ' ')} UTC</span> : null;
        })}
      </div>
    </div>
  );
}

function FragmentRows({ day, cols, children }: { day: string; cols: number; children: ReactNode }) {
  return (
    <>
      <tr className="bg-navy-850">
        <td colSpan={cols} className="px-3 py-1.5 font-mono text-[11px] font-semibold text-cyan-300">📅 {day}</td>
      </tr>
      {children}
    </>
  );
}
