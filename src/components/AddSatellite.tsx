import { useState } from 'react';
import { t } from '../i18n';
import { Button, Input, Panel, Spinner } from './ui';
import { addCustom, addCustomRecord, normaliseNorad, NotFoundError, removeCustom, searchByName } from '../lib/customSats';
import { remergeCustom } from '../lib/orbitLoader';
import { useOrbit, useWorkspace } from '../store';
import type { SatRecord } from '../lib/orbit';

const MAX_SHOWN = 30;

export default function AddSatellite() {
  const { sats } = useOrbit();
  const { setSelectedSat, customOnly, setCustomOnly, pinned, togglePin } = useWorkspace();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [hits, setHits] = useState<SatRecord[] | null>(null);
  const custom = sats.filter((s) => s.custom);
  const onGlobe = new Set(sats.map((s) => s.noradId));

  const finishAdd = (rec: SatRecord) => {
    remergeCustom();
    setSelectedSat(rec.noradId);
    setMsg({ tone: 'ok', text: `${t('Added')} ${rec.name} (${rec.noradId})` });
  };

  const submit = async () => {
    const input = q.trim();
    if (!input) return;
    setMsg(null);
    setHits(null);
    const id = normaliseNorad(input);
    setBusy(true);
    try {
      if (id) {
        const existing = sats.find((s) => s.noradId === id);
        if (existing) {
          setSelectedSat(id);
          setMsg({ tone: 'ok', text: `${existing.name} — ${t('already on the globe')}` });
          return;
        }
        const rec = await addCustom(id);
        setQ('');
        finishAdd(rec);
        return;
      }
      const found = await searchByName(input);
      if (!found.length) {
        setMsg({ tone: 'bad', text: `“${input}”: ${t('not found in the public catalogue (CelesTrak)')}` });
        return;
      }
      if (found.length === 1) {
        const rec = found[0];
        if (onGlobe.has(rec.noradId)) {
          setSelectedSat(rec.noradId);
          setMsg({ tone: 'ok', text: `${rec.name} — ${t('already on the globe')}` });
        } else finishAdd(addCustomRecord(rec));
        setQ('');
        return;
      }
      setHits(found.sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e: any) {
      if (e instanceof NotFoundError) setMsg({ tone: 'bad', text: `${input}: ${t('not found in the public catalogue (CelesTrak)')}` });
      else if (e.message === 'invalid-name') setMsg({ tone: 'bad', text: t('Use English letters, digits, spaces or - ( ) . /') });
      else setMsg({ tone: 'bad', text: `${t('Could not fetch elements')}: ${e.message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={t('Add satellite by name or NORAD ID')} right={<span className="font-mono text-[10px] text-muted">{custom.length} {t('added')}</span>}>
      <div className="flex gap-1.5">
        <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder={t('e.g. ISS, THEOS, 25544')} />
        <Button variant="primary" onClick={submit} disabled={busy}>{busy ? <Spinner /> : t('Search')}</Button>
      </div>
      {msg && <p className={`mt-1.5 text-[11px] ${msg.tone === 'ok' ? 'text-ok' : 'text-bad'}`}>{msg.text}</p>}

      {hits && (
        <div className="mt-2 rounded border border-line">
          <div className="flex items-center justify-between border-b border-line px-2 py-1">
            <span className="label">{hits.length} {t('matches')}</span>
            <button onClick={() => setHits(null)} className="text-muted hover:text-white">✕</button>
          </div>
          <ul className="max-h-56 overflow-y-auto scroll-thin">
            {hits.slice(0, MAX_SHOWN).map((h) => {
              const has = onGlobe.has(h.noradId);
              return (
                <li key={h.noradId}>
                  <button
                    onClick={() => {
                      if (has) setSelectedSat(h.noradId);
                      else finishAdd(addCustomRecord(h));
                    }}
                    className="flex w-full items-center gap-2 border-b border-white/5 px-2 py-1 text-left text-xs hover:bg-navy-800"
                  >
                    <span className="min-w-0 flex-1 truncate text-slate-200">{h.name}</span>
                    <span className="font-mono text-[10px] text-muted">{h.noradId}</span>
                    <span className={`text-[10px] ${has ? 'text-ok' : 'text-cyan-300'}`}>{has ? '✓' : '+'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {hits.length > MAX_SHOWN && (
            <p className="px-2 py-1 text-[10px] text-muted">{t('Showing the first')} {MAX_SHOWN} — {t('type a more specific name')}</p>
          )}
        </div>
      )}

      {custom.length > 0 && (
        <div className="mt-3 rounded border border-line">
          <div className="flex items-center justify-between border-b border-line px-2 py-1.5">
            <span className="label">{t('My added satellites')}</span>
            <span className="font-mono text-[10px] text-muted">{custom.length}</span>
          </div>
          <label className="flex items-center gap-2 border-b border-white/5 px-2 py-1.5 text-xs text-slate-300">
            <input type="checkbox" checked={customOnly} onChange={(e) => setCustomOnly(e.target.checked)} />
            {t('Show only added satellites on the globe')}
          </label>
        <ul className="max-h-48 overflow-y-auto px-2 py-1 scroll-thin">
          {custom.map((s) => (
            <li key={s.noradId} className="flex items-center gap-2 py-0.5 text-xs">
              <button
                title={pinned.includes(s.noradId) ? t('Unpin') : t('Pin to my view')}
                onClick={() => togglePin(s.noradId)}
                className={pinned.includes(s.noradId) ? 'text-warn' : 'text-muted hover:text-warn'}
              >
                {pinned.includes(s.noradId) ? '★' : '☆'}
              </button>
              <button onClick={() => setSelectedSat(s.noradId)} className="min-w-0 flex-1 truncate text-left text-slate-200 hover:text-white">
                {s.name}
              </button>
              <span className="font-mono text-[10px] text-muted">{s.noradId}</span>
              <button
                title={t('Remove')}
                onClick={() => {
                  removeCustom(s.noradId);
                  remergeCustom();
                  if (useWorkspace.getState().selectedSat === s.noradId) setSelectedSat(null);
                }}
                className="text-muted hover:text-bad"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        </div>
      )}
      <p className="mt-1.5 text-[10px] leading-snug text-muted">{t('Any satellite in the public CelesTrak catalogue. Kept in this browser.')}</p>
    </Panel>
  );
}
