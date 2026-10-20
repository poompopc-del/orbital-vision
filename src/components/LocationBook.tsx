import { useEffect, useState } from 'react';
import { t } from '../i18n';
import type { Observer } from '../lib/lookangles';
import { uid } from '../lib/repo';
import { Button, Input, cx } from './ui';

/** Named observer locations the user can star and reuse (stored in this browser). */
export interface SavedLocation extends Observer {
  id: string;
  savedAt: string;
}

const KEY = 'ov.observers.v1';
export function readLocations(): SavedLocation[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeLocations(list: SavedLocation[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage blocked — list lives for this session only */
  }
}

const same = (a: Observer, b: Observer) => Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5;

export default function LocationBook({ current, onUse }: { current: Observer | null; onUse: (o: Observer) => void }) {
  const [list, setList] = useState<SavedLocation[]>(readLocations);
  const [name, setName] = useState(current?.name ?? '');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameV, setRenameV] = useState('');
  const [manual, setManual] = useState(false);
  const [mName, setMName] = useState('');
  const [mLat, setMLat] = useState('');
  const [mLon, setMLon] = useState('');
  const [mErr, setMErr] = useState('');

  useEffect(() => setName(current?.name ?? ''), [current?.name, current?.lat, current?.lon]);
  const save = (l: SavedLocation[]) => {
    setList(l);
    writeLocations(l);
  };
  const savedMatch = current ? list.find((x) => same(x, current)) : undefined;

  const star = () => {
    if (!current) return;
    const nm = name.trim() || current.name;
    if (savedMatch) {
      save(list.filter((x) => x.id !== savedMatch.id));
      return;
    }
    save([{ ...current, name: nm, id: uid(), savedAt: new Date().toISOString() }, ...list]);
    if (nm !== current.name) onUse({ ...current, name: nm });
  };

  const commitName = () => {
    if (!current) return;
    const nm = name.trim();
    if (!nm || nm === current.name) return;
    onUse({ ...current, name: nm });
    if (savedMatch) save(list.map((x) => (x.id === savedMatch.id ? { ...x, name: nm } : x)));
  };

  const addManual = () => {
    // accepts decimal degrees; "13.75, 100.5" can be pasted into the latitude box
    let la = mLat, lo = mLon;
    const both = mLat.split(/[,\s]+/).filter(Boolean);
    if (both.length === 2 && !mLon) [la, lo] = both;
    const lat = parseFloat(la), lon = parseFloat(lo);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      setMErr(t('Enter latitude −90…90 and longitude −180…180 in decimal degrees'));
      return;
    }
    setMErr('');
    const o: Observer = { name: mName.trim() || `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lat, lon, heightKm: 0 };
    onUse(o);
    save([{ ...o, id: uid(), savedAt: new Date().toISOString() }, ...list.filter((x) => !same(x, o))]);
    setMName('');
    setMLat('');
    setMLon('');
    setManual(false);
  };

  return (
    <div className="space-y-2">
      {list.length > 0 && (
        <div>
          <div className="label mb-1">★ {t('Saved locations')}</div>
          <ul className="max-h-44 space-y-1 overflow-y-auto scroll-thin">
            {list.map((l) => {
              const on = !!current && same(l, current);
              return (
                <li key={l.id} className={cx('flex items-center gap-1.5 rounded border px-2 py-1 text-xs', on ? 'border-cyan-400/60 bg-cyan-400/10' : 'border-line')}>
                  <span className="text-warn">★</span>
                  {renaming === l.id ? (
                    <Input
                      autoFocus
                      value={renameV}
                      onChange={(e) => setRenameV(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const nm = renameV.trim() || l.name;
                          save(list.map((x) => (x.id === l.id ? { ...x, name: nm } : x)));
                          if (on && current) onUse({ ...current, name: nm });
                          setRenaming(null);
                        }
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      onBlur={() => setRenaming(null)}
                      className="!py-0.5 text-xs"
                    />
                  ) : (
                    <button onClick={() => onUse({ name: l.name, lat: l.lat, lon: l.lon, heightKm: l.heightKm })} className="min-w-0 flex-1 text-left" title={t('Use this location')}>
                      <div className="truncate text-white">{l.name}</div>
                      <div className="font-mono text-[10px] text-muted">{l.lat.toFixed(5)}, {l.lon.toFixed(5)}</div>
                    </button>
                  )}
                  <button onClick={() => { setRenaming(l.id); setRenameV(l.name); }} className="text-muted hover:text-white" title={t('Rename')}>✎</button>
                  <button onClick={() => save(list.filter((x) => x.id !== l.id))} className="text-muted hover:text-bad" title={t('Remove')}>✕</button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {current && (
        <div className="rounded border border-line px-2 py-1.5">
          <div className="label mb-1">{t('Current location')}</div>
          <div className="flex items-center gap-1.5">
            <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={(e) => e.key === 'Enter' && commitName()} placeholder={t('Name this location')} className="!py-1 text-xs" />
            <Button variant={savedMatch ? 'active' : 'ghost'} onClick={star} title={savedMatch ? t('Remove from saved') : t('Star and save')}>
              {savedMatch ? '★' : '☆'}
            </Button>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-muted">{current.lat.toFixed(5)}, {current.lon.toFixed(5)}</div>
        </div>
      )}

      <div>
        <button onClick={() => setManual(!manual)} className="text-[11px] text-cyan-300 hover:underline">
          {manual ? '−' : '+'} {t('Enter coordinates')}
        </button>
        {manual && (
          <div className="mt-1 space-y-1">
            <Input value={mName} onChange={(e) => setMName(e.target.value)} placeholder={t('Name (e.g. SpOC)')} className="!py-1 text-xs" />
            <div className="grid grid-cols-2 gap-1">
              <Input value={mLat} onChange={(e) => setMLat(e.target.value)} placeholder={t('Latitude')} className="!py-1 font-mono text-xs" />
              <Input value={mLon} onChange={(e) => setMLon(e.target.value)} placeholder={t('Longitude')} className="!py-1 font-mono text-xs" />
            </div>
            {mErr && <p className="text-[11px] text-bad">{mErr}</p>}
            <Button variant="primary" className="w-full" onClick={addManual}>★ {t('Use and save')}</Button>
          </div>
        )}
      </div>
    </div>
  );
}
