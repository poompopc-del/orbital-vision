import { useMemo, useState } from 'react';
import { t } from '../i18n';
import { Badge, Button, PageHeader, cx } from '../components/ui';
import { PROVIDERS, SENSOR_LABEL, type DataAccess, type ResolutionClass, type SensorCategory } from '../data/providers';
import { MISSIONS } from '../data/missions';
import { useOrbit } from '../store';

type Chip<T extends string> = { value: T | 'all'; label: string };

function ChipRow<T extends string>({ label, options, value, onChange }: { label: string; options: Chip<T>[]; value: T | 'all'; onChange: (v: T | 'all') => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="label w-24">{t(label)}</span>
      {options.map((o) => (
        <Button key={o.value} variant={value === o.value ? 'active' : 'ghost'} onClick={() => onChange(o.value)}>{t(o.label)}</Button>
      ))}
    </div>
  );
}

export default function ProviderMarketplace() {
  const { sats } = useOrbit();
  const [access, setAccess] = useState<DataAccess | 'all'>('all');
  const [sensor, setSensor] = useState<SensorCategory | 'all'>('all');
  const [res, setRes] = useState<ResolutionClass | 'all'>('all');
  const [acq, setAcq] = useState<'all' | 'archive' | 'tasking'>('all');
  const [cmp, setCmp] = useState<string[]>([]);

  const list = useMemo(
    () =>
      PROVIDERS.filter(
        (p) =>
          (access === 'all' || p.access === access) &&
          (sensor === 'all' || p.sensors.includes(sensor)) &&
          (res === 'all' || p.resolutionClasses.includes(res)) &&
          (acq === 'all' || (acq === 'archive' ? p.archive : p.tasking)),
      ),
    [access, sensor, res, acq],
  );

  const tracked = (pid: string) => sats.filter((s) => s.mission?.providerId === pid).length;
  const compared = PROVIDERS.filter((p) => cmp.includes(p.id));

  return (
    <div className="h-full overflow-y-auto p-4 scroll-thin">
      <PageHeader
        code={t('E · Provider Marketplace')}
        title={t('Satellite operators and data providers')}
        sub={t('Resolutions are nominal or provider-reported and depend on product, mode and viewing geometry. Prices are not invented: commercial pricing comes from the provider. Verify details on the official sites.')}
      />
      <div className="mb-4 space-y-2 rounded border border-line bg-navy-900 p-3">
        <ChipRow label={t('Data type')} value={access} onChange={setAccess} options={[{ value: 'all', label: t('All') }, { value: 'commercial', label: t('Commercial') }, { value: 'public', label: t('Public') }, { value: 'scientific', label: t('Scientific') }]} />
        <ChipRow
          label={t('Sensor')}
          value={sensor}
          onChange={setSensor}
          options={[{ value: 'all', label: t('All') }, ...(Object.keys(SENSOR_LABEL) as SensorCategory[]).filter((s) => s !== 'unknown').map((s) => ({ value: s, label: SENSOR_LABEL[s] }))]}
        />
        <ChipRow label={t('Resolution')} value={res} onChange={setRes} options={[{ value: 'all', label: t('All') }, { value: 'high', label: t('High') }, { value: 'medium', label: t('Medium') }, { value: 'wide', label: t('Wide-area') }]} />
        <ChipRow label={t('Acquisition')} value={acq} onChange={setAcq} options={[{ value: 'all', label: t('All') }, { value: 'archive', label: t('Archive imagery') }, { value: 'tasking', label: t('New acquisition') }]} />
      </div>

      {compared.length > 0 && (
        <div className="mb-4 overflow-x-auto rounded border border-cyan-400/30 bg-navy-900 scroll-thin">
          <table className="w-full min-w-[700px] text-left text-xs">
            <thead>
              <tr className="border-b border-line">
                <th className="label px-3 py-2">{t('Compare')}</th>
                {compared.map((p) => <th key={p.id} className="px-3 py-2 text-white">{p.shortName}</th>)}
              </tr>
            </thead>
            <tbody>
              {([
                ['Data type', (p) => p.access],
                ['Sensors', (p) => p.sensors.map((s) => t(SENSOR_LABEL[s])).join(', ')],
                ['Resolution', (p) => p.resolutionNote],
                ['Archive', (p) => (p.archive ? p.archiveNote : 'No')],
                ['Tasking', (p) => p.taskingNote],
                ['Ordering', (p) => p.orderingMethod],
                ['Integration', (p) => p.integrationNote],
                ['Pricing', (p) => p.pricing],
              ] as [string, (p: (typeof PROVIDERS)[number]) => string][]).map(([k, f]) => (
                <tr key={k} className="border-b border-white/5 align-top">
                  <td className="label px-3 py-1.5">{t(k)}</td>
                  {compared.map((p) => <td key={p.id} className="px-3 py-1.5 text-slate-300">{f(p)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {list.map((p) => {
          const missions = MISSIONS.filter((m) => m.providerId === p.id);
          const on = cmp.includes(p.id);
          return (
            <article key={p.id} className={cx('flex flex-col rounded border bg-navy-900 p-3', on ? 'border-cyan-400/50' : 'border-line')}>
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-cyan-400/40 font-mono text-xs text-cyan-300" title={t('Monogram — official logos come from provider brand kits')}>
                  {p.emblem}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-white">{p.name}</h3>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge tone={p.access === 'commercial' ? 'info' : 'ok'}>{t(p.access)}</Badge>
                    {p.sensors.map((s) => <Badge key={s}>{t(SENSOR_LABEL[s])}</Badge>)}
                    {p.tasking ? <Badge tone="cyan">{t('Tasking')}</Badge> : <Badge>{t('No tasking')}</Badge>}
                    <Badge tone={p.integration === 'integrated-stac' ? 'ok' : 'warn'}>{p.integration === 'integrated-stac' ? t('Archive search integrated') : t('Not integrated')}</Badge>
                  </div>
                </div>
              </div>
              <dl className="mt-3 flex-1 space-y-1.5 text-xs">
                <div><dt className="label">{t('Constellation')}</dt><dd className="text-slate-300">{p.constellation}</dd></div>
                <div><dt className="label">{t('Resolution')}</dt><dd className="text-slate-300">{p.resolutionNote}</dd></div>
                <div><dt className="label">{t('Coverage')}</dt><dd className="text-slate-300">{p.coverage}</dd></div>
                <div><dt className="label">{t('Ordering')}</dt><dd className="text-slate-300">{p.orderingMethod}</dd></div>
                <div><dt className="label">{t('Pricing')}</dt><dd className="text-slate-300">{p.pricing}</dd></div>
                <div><dt className="label">{t('Tracked here')}</dt><dd className="font-mono text-slate-300">{missions.map((m) => m.name).join(', ') || '—'} · {tracked(p.id)} {t('satellites')}</dd></div>
              </dl>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <a href={p.website} target="_blank" rel="noreferrer"><Button>{t('Website ↗')}</Button></a>
                {p.portal && <a href={p.portal} target="_blank" rel="noreferrer"><Button>{t('Ordering portal ↗')}</Button></a>}
                <Button variant={on ? 'active' : 'ghost'} onClick={() => setCmp(on ? cmp.filter((x) => x !== p.id) : [...cmp, p.id].slice(-3))}>
                  {on ? t('Comparing') : t('Compare')}
                </Button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
