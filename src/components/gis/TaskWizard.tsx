import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import { Button, Field, Input, Notice, Select, Spinner, cx } from '../ui';
import AoiPicker from '../AoiPicker';
import { daysAgo, pickBestScene } from '../../lib/autoscene';
import { displayTemplate } from '../../lib/export';
import { flyToPolygon } from '../../lib/cesium';
import { areaKm2 } from '../../lib/geo';
import type { ImageryItem, StacCollectionId } from '../../lib/stac';
import { useWorkspace } from '../../store';
import { useGis } from './GisContext';
import { pcProvider, sceneLabel } from './sceneLayer';
import SceneDownload from './SceneDownload';

export type TaskId = 'flood' | 'vegetation' | 'urban' | 'latest' | 'dams';

export const TASKS: { id: TaskId; icon: string; title: string; desc: string }[] = [
  { id: 'flood', icon: '🌊', title: 'Flood', desc: 'Compare water before and after an event' },
  { id: 'vegetation', icon: '🌾', title: 'Vegetation (NDVI)', desc: 'How green and healthy plants are' },
  { id: 'urban', icon: '🏙', title: 'Urban growth', desc: 'Where buildings increased between two years' },
  { id: 'latest', icon: '📷', title: 'Latest image', desc: 'Clearest recent satellite picture, ready to download' },
  { id: 'dams', icon: '💧', title: 'Dams', desc: 'Reservoir storage from the Royal Irrigation Department' },
];

const addDays = (d: string, n: number) => new Date(new Date(d).getTime() + n * 86400e3).toISOString().slice(0, 10);
const minDay = (a: string, b: string) => (a < b ? a : b);
const today = () => daysAgo(0);
const YEAR = new Date().getFullYear();

type Step = { label: string; state: 'run' | 'ok' | 'bad'; detail?: string };

export default function TaskWizard({ initialTask, goTab }: { initialTask?: TaskId | null; goTab: (tab: string) => void }) {
  const g = useGis();
  const { aoi, lastResults, setLastResults } = useWorkspace();
  const [task, setTask] = useState<TaskId>(initialTask ?? 'flood');
  const [editAoi, setEditAoi] = useState(!aoi);
  const [eventDate, setEventDate] = useState(daysAgo(7));
  const [radar, setRadar] = useState(true);
  const [from, setFrom] = useState(daysAgo(60));
  const [to, setTo] = useState(today());
  const [yearA, setYearA] = useState(YEAR - 4);
  const [yearB, setYearB] = useState(new Date().getMonth() >= 1 ? YEAR : YEAR - 1);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [latest, setLatest] = useState<ImageryItem | null>(null);

  useEffect(() => {
    if (initialTask) setTask(initialTask);
  }, [initialTask]);
  useEffect(() => {
    if (!aoi) setEditAoi(true);
  }, [aoi]);

  const push = (s: Step) => setSteps((x) => [...x, s]);
  const update = (patch: Partial<Step>) => setSteps((x) => x.map((s, i) => (i === x.length - 1 ? { ...s, ...patch } : s)));
  const remember = (items: ImageryItem[]) => setLastResults([...items, ...lastResults.filter((r) => !items.some((m) => m.id === r.id))]);

  const pick = async (label: string, coll: StacCollectionId, f: string, tt: string, match?: ImageryItem | null) => {
    push({ label, state: 'run' });
    const r = await pickBestScene(aoi!.geometry, coll, f, tt, { match });
    remember(r.candidates);
    if (r.item) update({ state: 'ok', detail: `${sceneLabel(r.item)} · ${r.reason}` });
    else update({ state: 'bad', detail: `${t('No usable scene between')} ${f} – ${tt}` });
    return r.item;
  };

  const start = async () => {
    if (task === 'dams') return goTab('dams');
    if (!aoi) return;
    setBusy(true);
    setSteps([]);
    setLatest(null);
    try {
      if (g.viewer) flyToPolygon(g.viewer, aoi.geometry);
      if (task === 'flood') {
        const coll: StacCollectionId = radar ? 'sentinel-1-rtc' : 'sentinel-2-l2a';
        const after = await pick(t('Finding the image after the event'), coll, eventDate, minDay(addDays(eventDate, 12), today()));
        const before = await pick(t('Finding a comparable image before the event'), coll, addDays(eventDate, -60), addDays(eventDate, -3), after);
        if (!after) return;
        g.setSceneA(before);
        g.setSceneB(after);
        push({ label: t('Mapping water'), state: 'ok', detail: t('Results are in the Flood tab') });
        goTab('flood');
        g.runAction('flood', { pre: before, post: after, method: radar ? 'sar' : 'mndwi' });
      } else if (task === 'vegetation') {
        const s = await pick(t('Finding the clearest Sentinel-2 image'), 'sentinel-2-l2a', from, to);
        if (!s) return;
        g.setSceneA(s);
        push({ label: t('Computing NDVI'), state: 'ok', detail: t('Results are in the Spectral tab') });
        goTab('spectral');
        g.runAction('ndvi', { scene: s });
      } else if (task === 'urban') {
        const range = (y: number) => [`${y}-01-01`, minDay(`${y}-04-30`, today())] as const;
        const [bf, bt] = range(yearB);
        const [af, at] = range(yearA);
        const b = await pick(`${t('Finding the image for')} ${yearB}`, 'sentinel-2-l2a', bf, bt);
        const a = await pick(`${t('Finding the image for')} ${yearA}`, 'sentinel-2-l2a', af, at, b);
        if (!a || !b) return;
        g.setSceneA(a);
        g.setSceneB(b);
        push({ label: t('Comparing built-up index (NDBI)'), state: 'ok', detail: t('Results are in the Change tab') });
        goTab('change');
        g.runAction('change', { A: a, B: b, kind: 'ndbi' });
      } else if (task === 'latest') {
        const coll: StacCollectionId = radar ? 'sentinel-1-rtc' : 'sentinel-2-l2a';
        const s = await pick(t('Finding the clearest recent image'), coll, from, to);
        if (!s) return;
        g.setSceneA(s);
        g.putImagery('latest', `${t('Latest image')} · ${sceneLabel(s)}`, pcProvider(displayTemplate(s), s), { meta: `${s.id} · ${t('real image (rendered tiles)')}` });
        setLatest(s);
      }
    } catch (e: any) {
      push({ label: t('Error'), state: 'bad', detail: e.message });
    } finally {
      setBusy(false);
    }
  };

  const T = TASKS.find((x) => x.id === task)!;

  return (
    <div className="space-y-3">
      <div>
        <div className="label mb-1.5">{t('What do you want to do?')}</div>
        <div className="grid grid-cols-2 gap-1.5">
          {TASKS.map((x) => (
            <button
              key={x.id}
              onClick={() => { setTask(x.id); setSteps([]); setLatest(null); }}
              className={cx('rounded border p-2 text-left', task === x.id ? 'border-cyan-400/60 bg-cyan-400/10' : 'border-line hover:border-cyan-400/30')}
            >
              <div className="text-sm text-white">{x.icon} {t(x.title)}</div>
              <div className="text-[10px] leading-snug text-muted">{t(x.desc)}</div>
            </button>
          ))}
        </div>
      </div>

      {task !== 'dams' && (
        <>
          <div className="rounded border border-line p-2.5">
            <div className="label mb-1.5">1 · {t('Area')}</div>
            {aoi && !editAoi ? (
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-white">{aoi.name} · {areaKm2(aoi.geometry).toFixed(1)} km²</span>
                <Button onClick={() => setEditAoi(true)}>{t('Change area')}</Button>
              </div>
            ) : (
              <>
                <AoiPicker viewer={g.viewer} compact />
                {aoi && <Button className="mt-1.5 w-full" onClick={() => setEditAoi(false)}>{t('Use this area')}</Button>}
                <p className="mt-1 text-[10px] text-muted">{t('Tip: a rectangle of about 5–30 km gives fast, detailed results.')}</p>
              </>
            )}
          </div>

          <div className="rounded border border-line p-2.5">
            <div className="label mb-1.5">2 · {t('Time range')}</div>
            {task === 'flood' && (
              <>
                <Field label={t('Approximate date of the flood')}>
                  <Input type="date" value={eventDate} max={today()} onChange={(e) => setEventDate(e.target.value)} />
                </Field>
                <p className="mt-1 text-[10px] text-muted">{t('The system takes one image within 12 days after this date and a comparable one 3–60 days before.')}</p>
              </>
            )}
            {(task === 'vegetation' || task === 'latest') && (
              <div className="grid grid-cols-2 gap-1.5">
                <Field label={t('From')}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
                <Field label={t('To')}><Input type="date" value={to} max={today()} onChange={(e) => setTo(e.target.value)} /></Field>
              </div>
            )}
            {task === 'urban' && (
              <>
                <div className="grid grid-cols-2 gap-1.5">
                  <Field label={t('Earlier year')}>
                    <Select value={yearA} onChange={(e) => setYearA(+e.target.value)}>{Array.from({ length: YEAR - 2016 }, (_, i) => 2017 + i).map((y) => <option key={y}>{y}</option>)}</Select>
                  </Field>
                  <Field label={t('Later year')}>
                    <Select value={yearB} onChange={(e) => setYearB(+e.target.value)}>{Array.from({ length: YEAR - 2016 }, (_, i) => 2017 + i).map((y) => <option key={y}>{y}</option>)}</Select>
                  </Field>
                </div>
                <p className="mt-1 text-[10px] text-muted">{t('Uses dry-season images (January–April) from both years: fewer clouds and the same season.')}</p>
              </>
            )}
            {(task === 'flood' || task === 'latest') && (
              <div className="mt-2 grid grid-cols-2 gap-1">
                <Button variant={radar ? 'active' : 'ghost'} onClick={() => setRadar(true)}>{t('Radar (through cloud)')}</Button>
                <Button variant={!radar ? 'active' : 'ghost'} onClick={() => setRadar(false)}>{t('Optical (true colour)')}</Button>
              </div>
            )}
          </div>
        </>
      )}

      <Button variant="primary" className="w-full py-2 text-sm" onClick={start} disabled={busy || (task !== 'dams' && !aoi)}>
        {busy ? <><Spinner /> {t('Working…')}</> : `${T.icon} ${task === 'dams' ? t('Open dams') : t('Start')}`}
      </Button>
      {task !== 'dams' && !aoi && <p className="text-[11px] text-muted">{t('Choose an area first.')}</p>}

      {steps.length > 0 && (
        <ol className="space-y-1 rounded border border-line p-2">
          {steps.map((s, i) => (
            <li key={i} className="text-[11px]">
              <span className={cx('mr-1.5', s.state === 'ok' ? 'text-ok' : s.state === 'bad' ? 'text-bad' : 'text-cyan-300')}>{s.state === 'ok' ? '✓' : s.state === 'bad' ? '✕' : '…'}</span>
              <span className="text-slate-200">{s.label}</span>
              {s.detail && <div className="ml-4 text-[10px] text-muted">{s.detail}</div>}
            </li>
          ))}
        </ol>
      )}
      {steps.some((s) => s.state === 'bad') && <Notice tone="warn">{t('Try a wider date range, another data source, or a smaller area.')}</Notice>}
      {latest && <SceneDownload item={latest} />}
    </div>
  );
}
