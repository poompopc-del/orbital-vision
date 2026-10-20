import { useState } from 'react';
import { t } from '../../i18n';
import { Button, Input, Notice, Select, Spinner, cx } from '../ui';
import { daysAgo, pickBestScene } from '../../lib/autoscene';
import type { StacCollectionId } from '../../lib/stac';
import { useWorkspace } from '../../store';
import { useGis } from './GisContext';
import { sceneLabel } from './sceneLayer';
import SceneDownload from './SceneDownload';

export const DATA_CHOICES: { id: StacCollectionId; label: string; note: string }[] = [
  { id: 'sentinel-2-l2a', label: 'Sentinel-2 (optical 10 m)', note: 'Natural colour & indices; blocked by cloud' },
  { id: 'sentinel-1-rtc', label: 'Sentinel-1 (radar 10 m)', note: 'Sees through cloud and at night; for water/flood' },
  { id: 'landsat-c2-l2', label: 'Landsat 8/9 (optical 30 m)', note: 'Longer archive, coarser' },
];

/**
 * Scene A ("before") and B ("after") chosen from date ranges — the system picks the best scene.
 * Manual choice from the search results is still available.
 */
export default function AutoScenes() {
  const g = useGis();
  const { aoi, lastResults, setLastResults } = useWorkspace();
  const [coll, setColl] = useState<StacCollectionId>('sentinel-2-l2a');
  const [aFrom, setAFrom] = useState(daysAgo(120));
  const [aTo, setATo] = useState(daysAgo(60));
  const [bFrom, setBFrom] = useState(daysAgo(45));
  const [bTo, setBTo] = useState(daysAgo(0));
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'bad'; text: string } | null>(null);
  const [dl, setDl] = useState<'A' | 'B' | null>(null);
  const pc = lastResults.filter((r) => r.source === 'planetary-computer');

  const find = async () => {
    if (!aoi) return setMsg({ tone: 'bad', text: t('Draw or choose an area (AOI) first.') });
    setBusy(true);
    setMsg(null);
    try {
      const b = await pickBestScene(aoi.geometry, coll, bFrom, bTo);
      const a = await pickBestScene(aoi.geometry, coll, aFrom, aTo, { match: b.item });
      const merged = [...a.candidates, ...b.candidates];
      setLastResults([...merged, ...lastResults.filter((r) => !merged.some((m) => m.id === r.id))]);
      g.setSceneA(a.item);
      g.setSceneB(b.item);
      const miss = [!a.item && t('before'), !b.item && t('after')].filter(Boolean).join(', ');
      setMsg(miss ? { tone: 'bad', text: `${t('No usable scene for')}: ${miss}. ${t('Widen the date range or choose another data source.')}` } : { tone: 'info', text: `A: ${a.reason} · B: ${b.reason}` });
    } catch (e: any) {
      setMsg({ tone: 'bad', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const row = (w: 'A' | 'B') => {
    const sc = w === 'A' ? g.sceneA : g.sceneB;
    return (
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className={cx('w-12 shrink-0 font-semibold', w === 'A' ? 'text-slate-300' : 'text-cyan-300')}>{w === 'A' ? t('Before') : t('After')}</span>
        {manual ? (
          <Select value={sc?.id ?? ''} onChange={(e) => (w === 'A' ? g.setSceneA : g.setSceneB)(pc.find((r) => r.id === e.target.value) ?? null)} className="py-1 text-[11px]">
            <option value="">{t('choose scene')}</option>
            {pc.map((r) => <option key={r.id} value={r.id}>{sceneLabel(r)}</option>)}
          </Select>
        ) : (
          <span className={cx('min-w-0 flex-1 truncate', sc ? 'text-white' : 'text-muted')}>{sc ? sceneLabel(sc) : '—'}</span>
        )}
        {sc && <button title={t('Download image')} onClick={() => setDl(dl === w ? null : w)} className="text-muted hover:text-cyan-300">⬇</button>}
      </div>
    );
  };

  return (
    <div className="space-y-1.5">
      <Select value={coll} onChange={(e) => setColl(e.target.value as StacCollectionId)} className="py-1 text-[11px]" title={t(DATA_CHOICES.find((d) => d.id === coll)!.note)}>
        {DATA_CHOICES.map((d) => <option key={d.id} value={d.id}>{t(d.label)}</option>)}
      </Select>
      <div className="grid grid-cols-[48px_1fr_1fr] items-center gap-1 text-[11px]">
        <span className="text-slate-300">{t('Before')}</span>
        <Input type="date" value={aFrom} onChange={(e) => setAFrom(e.target.value)} className="px-1 py-1 text-[11px]" />
        <Input type="date" value={aTo} onChange={(e) => setATo(e.target.value)} className="px-1 py-1 text-[11px]" />
        <span className="text-cyan-300">{t('After')}</span>
        <Input type="date" value={bFrom} onChange={(e) => setBFrom(e.target.value)} className="px-1 py-1 text-[11px]" />
        <Input type="date" value={bTo} onChange={(e) => setBTo(e.target.value)} className="px-1 py-1 text-[11px]" />
      </div>
      <div className="flex gap-1.5">
        <Button variant="primary" className="flex-1" onClick={find} disabled={busy}>
          {busy ? <><Spinner /> {t('Finding the best scenes…')}</> : `✨ ${t('Find the best images automatically')}`}
        </Button>
        <Button variant={manual ? 'active' : 'ghost'} onClick={() => setManual(!manual)} title={t('Choose scenes yourself from search results')}>{t('Manual')}</Button>
      </div>
      {row('A')}
      {row('B')}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {dl && (dl === 'A' ? g.sceneA : g.sceneB) && <SceneDownload item={(dl === 'A' ? g.sceneA : g.sceneB)!} />}
    </div>
  );
}
