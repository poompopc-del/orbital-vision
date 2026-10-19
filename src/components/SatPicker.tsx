import { useMemo, useState } from 'react';
import { t } from '../i18n';
import { Button, Input, Panel, Spinner, cx } from './ui';
import { useOrbit, useWorkspace } from '../store';
import { MISSIONS, CUSTOM_MISSION } from '../data/missions';
import { SENSOR_COLOR, SENSOR_LABEL, type SensorCategory } from '../data/providers';
import { addCustom, addCustomRecord, normaliseNorad, NotFoundError, removeCustom, searchByName } from '../lib/customSats';
import { remergeCustom } from '../lib/orbitLoader';
import type { SatRecord } from '../lib/orbit';

/**
 * One shared satellite selection ("my satellites") used by every globe page.
 * Starts empty; pick satellites one by one, by mission, or by sensor type.
 */
export default function SatPicker({ sensors, title }: { sensors?: SensorCategory[]; title?: string }) {
  const { sats } = useOrbit();
  const { mySats, setMySats, setSelectedSat } = useWorkspace();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [remote, setRemote] = useState<SatRecord[] | null>(null);
  const [showCats, setShowCats] = useState(true);

  const pool = useMemo(() => sats.filter((s) => !sensors || (s.mission && sensors.includes(s.mission.sensor))), [sats, sensors]);
  const mine = new Set(mySats);
  const selected = pool.filter((s) => mine.has(s.noradId));
  const hiddenHere = mySats.length - selected.length;

  const add = (ids: string[]) => setMySats([...new Set([...mySats, ...ids])]);
  const remove = (ids: string[]) => {
    const r = new Set(ids);
    setMySats(mySats.filter((x) => !r.has(x)));
  };
  const toggle = (s: SatRecord) => (mine.has(s.noradId) ? deselect(s) : add([s.noradId]));
  const deselect = (s: SatRecord) => {
    remove([s.noradId]);
    if (s.custom) {
      removeCustom(s.noradId);
      remergeCustom();
    }
  };

  const local = useMemo(() => {
    const k = q.trim().toUpperCase();
    if (!k) return [];
    return pool.filter((s) => s.name.includes(k) || s.noradId === k || s.mission?.name.toUpperCase().includes(k)).slice(0, 15);
  }, [q, pool]);

  const groups = useMemo(() => {
    const m = new Map<string, SatRecord[]>();
    pool.forEach((s) => {
      const id = s.mission?.id ?? 'custom';
      m.set(id, [...(m.get(id) ?? []), s]);
    });
    return [...MISSIONS, CUSTOM_MISSION]
      .filter((mi) => m.has(mi.id))
      .map((mi) => ({ mission: mi, list: m.get(mi.id)! }));
  }, [pool]);

  const sensorGroups = useMemo(() => {
    const set = new Map<SensorCategory, SatRecord[]>();
    pool.forEach((s) => {
      const k = s.mission?.sensor ?? 'unknown';
      if (k === 'unknown') return;
      set.set(k, [...(set.get(k) ?? []), s]);
    });
    return [...set.entries()];
  }, [pool]);

  const searchRemote = async () => {
    const input = q.trim();
    if (!input) return;
    setBusy(true);
    setMsg(null);
    setRemote(null);
    try {
      const id = normaliseNorad(input);
      if (id) {
        const have = sats.find((s) => s.noradId === id);
        if (have) {
          add([id]);
          setSelectedSat(id);
          setMsg({ tone: 'ok', text: `${have.name} ✓` });
          return;
        }
        const rec = await addCustom(id);
        remergeCustom();
        add([rec.noradId]);
        setSelectedSat(rec.noradId);
        setQ('');
        setMsg({ tone: 'ok', text: `${t('Added')} ${rec.name}` });
        return;
      }
      const found = await searchByName(input);
      if (!found.length) setMsg({ tone: 'bad', text: `“${input}”: ${t('not found in the public catalogue (CelesTrak)')}` });
      else setRemote(found.sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e: any) {
      if (e instanceof NotFoundError) setMsg({ tone: 'bad', text: `${input}: ${t('not found in the public catalogue (CelesTrak)')}` });
      else if (e.message === 'invalid-name') setMsg({ tone: 'bad', text: t('Use English letters, digits, spaces or - ( ) . /') });
      else setMsg({ tone: 'bad', text: `${t('Could not fetch elements')}: ${e.message}` });
    } finally {
      setBusy(false);
    }
  };

  const pickRemote = (r: SatRecord) => {
    if (!sats.some((s) => s.noradId === r.noradId)) {
      addCustomRecord(r);
      remergeCustom();
    }
    add([r.noradId]);
    setSelectedSat(r.noradId);
  };

  return (
    <Panel
      title={`${title ?? t('My satellites')} (${selected.length})`}
      right={mySats.length > 0 && <button onClick={() => setMySats([])} className="text-[11px] text-muted hover:text-bad">{t('Clear all')}</button>}
    >
      {/* search */}
      <div className="flex gap-1.5">
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setRemote(null);
            setMsg(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && !local.length && searchRemote()}
          placeholder={t('Search name or NORAD ID')}
        />
        {q && <Button onClick={() => { setQ(''); setRemote(null); }}>✕</Button>}
      </div>
      {q && (
        <div className="mt-1.5 rounded border border-line">
          {local.map((s) => (
            <button key={s.noradId} onClick={() => toggle(s)} className="flex w-full items-center gap-2 border-b border-white/5 px-2 py-1 text-left text-xs hover:bg-navy-800">
              <span className={mine.has(s.noradId) ? 'text-warn' : 'text-muted'}>{mine.has(s.noradId) ? '★' : '☆'}</span>
              <span className="min-w-0 flex-1 truncate text-slate-200">{s.name}</span>
              <span className="font-mono text-[10px] text-muted">{s.noradId}</span>
            </button>
          ))}
          {!local.length && !remote && (
            <p className="px-2 py-1.5 text-[11px] text-muted">{t('Not in the loaded list.')}</p>
          )}
          {!sensors && (
            <button onClick={searchRemote} disabled={busy} className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-cyan-300 hover:bg-navy-800">
              {busy ? <Spinner /> : '🔎'} {t('Search the whole CelesTrak catalogue for')} “{q.trim()}”
            </button>
          )}
          {remote && (
            <ul className="max-h-48 overflow-y-auto border-t border-line scroll-thin">
              {remote.slice(0, 30).map((r) => {
                const on = mine.has(r.noradId);
                return (
                  <li key={r.noradId}>
                    <button onClick={() => pickRemote(r)} className="flex w-full items-center gap-2 border-b border-white/5 px-2 py-1 text-left text-xs hover:bg-navy-800">
                      <span className={on ? 'text-warn' : 'text-cyan-300'}>{on ? '★' : '+'}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-200">{r.name}</span>
                      <span className="font-mono text-[10px] text-muted">{r.noradId}</span>
                    </button>
                  </li>
                );
              })}
              {remote.length > 30 && <li className="px-2 py-1 text-[10px] text-muted">{t('Showing the first')} 30 {t('type a more specific name')}</li>}
            </ul>
          )}
        </div>
      )}
      {msg && <p className={`mt-1.5 text-[11px] ${msg.tone === 'ok' ? 'text-ok' : 'text-bad'}`}>{msg.text}</p>}

      {/* categories */}
      <button onClick={() => setShowCats(!showCats)} className="label mt-3 flex w-full items-center justify-between">
        <span>{t('Select by category')}</span>
        <span>{showCats ? '−' : '+'}</span>
      </button>
      {showCats && (
        <div className="mt-1.5 space-y-2">
          <div className="flex flex-wrap gap-1">
            {sensorGroups.map(([k, list]) => {
              const n = list.filter((s) => mine.has(s.noradId)).length;
              const all = n === list.length;
              return (
                <button
                  key={k}
                  onClick={() => (all ? remove(list.map((s) => s.noradId)) : add(list.map((s) => s.noradId)))}
                  className={cx('flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]', all ? 'border-cyan-400/60 bg-cyan-400/10 text-white' : n ? 'border-cyan-400/30 text-slate-200' : 'border-line text-muted')}
                  title={all ? t('Remove all') : t('Add all')}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: SENSOR_COLOR[k] }} />
                  {t(SENSOR_LABEL[k])} <span className="font-mono text-[10px] text-muted">{n}/{list.length}</span>
                </button>
              );
            })}
          </div>
          <ul className="max-h-56 overflow-y-auto rounded border border-line scroll-thin">
            {groups.map(({ mission, list }) => {
              const n = list.filter((s) => mine.has(s.noradId)).length;
              return (
                <li key={mission.id}>
                  <label className="flex cursor-pointer items-center gap-2 border-b border-white/5 px-2 py-1 text-xs hover:bg-navy-800">
                    <input
                      type="checkbox"
                      checked={n === list.length}
                      ref={(el) => {
                        if (el) el.indeterminate = n > 0 && n < list.length;
                      }}
                      onChange={() => (n === list.length ? remove(list.map((s) => s.noradId)) : add(list.map((s) => s.noradId)))}
                    />
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SENSOR_COLOR[mission.sensor] }} />
                    <span className="min-w-0 flex-1 truncate text-slate-200">{mission.id === 'custom' ? t('User-added') : mission.name}</span>
                    <span className="font-mono text-[10px] text-muted">{n}/{list.length}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* selected */}
      <div className="label mt-3">{t('Selected')}</div>
      {selected.length === 0 ? (
        <p className="mt-1 text-[11px] text-muted">{t('Nothing selected yet — search above or tick a category.')}</p>
      ) : (
        <ul className="mt-1 max-h-48 overflow-y-auto scroll-thin">
          {selected.map((s) => (
            <li key={s.noradId} className="flex items-center gap-2 py-0.5 text-xs">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SENSOR_COLOR[s.mission?.sensor ?? 'unknown'] }} />
              <button onClick={() => setSelectedSat(s.noradId)} className="min-w-0 flex-1 truncate text-left text-slate-200 hover:text-white">
                {s.name}
              </button>
              <span className="font-mono text-[10px] text-muted">{s.noradId}</span>
              <button onClick={() => deselect(s)} title={t('Remove')} className="text-muted hover:text-bad">✕</button>
            </li>
          ))}
        </ul>
      )}
      {hiddenHere > 0 && sensors && <p className="mt-1 text-[10px] text-muted">+{hiddenHere} {t('selected satellites are not shown on this page (not imaging satellites)')}</p>}
    </Panel>
  );
}
