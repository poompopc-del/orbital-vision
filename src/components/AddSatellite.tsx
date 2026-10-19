import { useState } from 'react';
import { t } from '../i18n';
import { Button, Input, Panel, Spinner } from './ui';
import { addCustom, normaliseNorad, NotFoundError, removeCustom } from '../lib/customSats';
import { remergeCustom } from '../lib/orbitLoader';
import { useOrbit, useWorkspace } from '../store';

export default function AddSatellite() {
  const { sats } = useOrbit();
  const { setSelectedSat } = useWorkspace();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const custom = sats.filter((s) => s.custom);

  const add = async () => {
    const id = normaliseNorad(q);
    if (!id) return setMsg({ tone: 'bad', text: t('Enter a numeric NORAD ID, e.g. 25544') });
    const existing = sats.find((s) => s.noradId === id);
    if (existing) {
      setSelectedSat(id);
      return setMsg({ tone: 'ok', text: `${existing.name} — ${t('already on the globe')}` });
    }
    setBusy(true);
    setMsg(null);
    try {
      const rec = await addCustom(id);
      remergeCustom();
      setSelectedSat(rec.noradId);
      setQ('');
      setMsg({ tone: 'ok', text: `${t('Added')} ${rec.name} (${rec.noradId})` });
    } catch (e: any) {
      setMsg({
        tone: 'bad',
        text: e instanceof NotFoundError ? `${id}: ${t('not found in the public catalogue (CelesTrak)')}` : `${t('Could not fetch elements')}: ${e.message}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={t('Add satellite by NORAD ID')}>
      <div className="flex gap-1.5">
        <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="25544" inputMode="numeric" />
        <Button variant="primary" onClick={add} disabled={busy}>{busy ? <Spinner /> : t('Add')}</Button>
      </div>
      {msg && <p className={`mt-1.5 text-[11px] ${msg.tone === 'ok' ? 'text-ok' : 'text-bad'}`}>{msg.text}</p>}
      {custom.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {custom.map((s) => (
            <li key={s.noradId} className="flex items-center gap-2 text-xs">
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
      )}
      <p className="mt-1.5 text-[10px] leading-snug text-muted">{t('Any satellite in the public CelesTrak catalogue. Kept in this browser.')}</p>
    </Panel>
  );
}
