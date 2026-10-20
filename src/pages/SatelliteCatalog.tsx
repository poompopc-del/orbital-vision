import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n';
import { useSearchParams } from 'react-router-dom';
import SatDetails from '../components/SatDetails';
import { Badge, Button, Input, Notice, PageHeader, Panel, Select, Spinner, cx } from '../components/ui';
import { useOrbit } from '../store';
import { MISSIONS } from '../data/missions';
import { PROVIDERS, SENSOR_COLOR, SENSOR_LABEL, type SensorCategory } from '../data/providers';
import { fmtNum, fmtUtc } from '../lib/format';
import { refreshOrbits } from '../lib/orbitLoader';

export default function SatelliteCatalog() {
  const { sats, status, error, source, fetchedAt, warnings } = useOrbit();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [sensor, setSensor] = useState<'all' | SensorCategory>('all');
  const [prov, setProv] = useState('all');
  const [now, setNow] = useState(new Date());
  const sel = params.get('sat');

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 2000);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo(() => {
    const t = q.trim().toUpperCase();
    return sats.filter(
      (s) =>
        (sensor === 'all' || s.mission?.sensor === sensor) &&
        (prov === 'all' || s.mission?.providerId === prov) &&
        (!t || s.name.includes(t) || s.noradId.includes(t) || s.intlDesignator.includes(t)),
    );
  }, [sats, q, sensor, prov]);

  const selected = sats.find((s) => s.noradId === sel);
  const missionCounts = useMemo(() => {
    const m = new Map<string, number>();
    sats.forEach((s) => m.set(s.mission!.id, (m.get(s.mission!.id) ?? 0) + 1));
    return m;
  }, [sats]);

  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-y-auto p-4 scroll-thin">
        <PageHeader
          code={t('D · Satellite Catalog')}
          title={t('Supported missions and satellites')}
          sub={t('Orbital records come from public CelesTrak element sets matched to documented Earth-observation missions. Altitude, inclination and period are derived from those elements.')}
          right={
            <div className="flex items-center gap-2">
              {fetchedAt && <span className="font-mono text-[10px] text-muted">{source} · {fmtUtc(fetchedAt)}</span>}
              <Button onClick={() => refreshOrbits(true)}>{t('Refresh elements')}</Button>
            </div>
          }
        />
        {status === 'loading' && <div className="mb-3 flex items-center gap-2 text-xs text-muted"><Spinner /> {t('Loading orbital data…')}</div>}
        {error && <div className="mb-3"><Notice tone="bad">{t('Orbital elements')}: {error}</Notice></div>}
        {warnings.length > 0 && <div className="mb-3"><Notice tone="warn">{t('Some queries failed:')} {warnings.join('; ')}</Notice></div>}

        <Panel title={t('Missions')} className="mb-4" bodyClass="p-0">
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="label">
                <tr className="border-b border-line">
                  <th className="px-3 py-2">{t('Mission')}</th><th>{t('Operator')}</th><th>{t('Sensor')}</th><th>{t('Nominal resolution')}</th><th>{t('Swath')}</th><th>{t('Tasking')}</th><th className="pr-3 text-right">{t('Tracked')}</th>
                </tr>
              </thead>
              <tbody>
                {MISSIONS.map((m) => (
                  <tr key={m.id} className="border-b border-white/5 hover:bg-navy-800/50">
                    <td className="px-3 py-1.5 text-white">{m.name}</td>
                    <td className="text-slate-300">{PROVIDERS.find((p) => p.id === m.providerId)?.shortName}</td>
                    <td><span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: SENSOR_COLOR[m.sensor] }} />{t(SENSOR_LABEL[m.sensor])}</span></td>
                    <td className="max-w-[260px] text-slate-300">{m.resolution}</td>
                    <td className="font-mono text-[11px]">{m.swathKm ? `${m.swathKm} km` : '—'}</td>
                    <td>{m.tasking === 'commercial' ? <Badge tone="info">{t('Commercial')}</Badge> : m.tasking === 'agency' ? <Badge tone="info">{t('Agency')}</Badge> : <Badge>{t('None')}</Badge>}</td>
                    <td className="pr-3 text-right font-mono">{missionCounts.get(m.id) ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title={`${t('Satellites')} (${rows.length})`} bodyClass="p-0">
          <div className="flex flex-wrap gap-2 border-b border-line p-3">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Name, NORAD ID, designator')} className="max-w-xs" />
            <Select value={sensor} onChange={(e) => setSensor(e.target.value as any)} className="max-w-[160px]">
              <option value="all">{t('All sensors')}</option>
              {Object.entries(SENSOR_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Select value={prov} onChange={(e) => setProv(e.target.value)} className="max-w-[180px]">
              <option value="all">{t('All operators')}</option>
              {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.shortName}</option>)}
            </Select>
          </div>
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[820px] text-left text-xs">
              <thead className="label">
                <tr className="border-b border-line">
                  <th className="px-3 py-2">{t('Name')}</th><th>NORAD</th><th>{t('Intl des.')}</th><th>{t('Mission')}</th><th>{t('Orbit')}</th><th>{t('Perigee')}</th><th>{t('Incl.')}</th><th>{t('Period')}</th><th className="pr-3">{t('Epoch')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr
                    key={s.noradId}
                    onClick={() => setParams({ tab: 'catalog', sat: s.noradId })}
                    className={cx('cursor-pointer border-b border-white/5 hover:bg-navy-800/60', sel === s.noradId && 'bg-cyan-400/10')}
                  >
                    <td className="px-3 py-1.5 text-white">{s.name}</td>
                    <td className="font-mono">{s.noradId}</td>
                    <td className="font-mono text-muted">{s.intlDesignator}</td>
                    <td>{s.mission?.name}</td>
                    <td className="text-slate-300">{s.orbitType}</td>
                    <td className="font-mono">{fmtNum(s.perigeeKm, 0)} km</td>
                    <td className="font-mono">{fmtNum(s.inclinationDeg, 1)}°</td>
                    <td className="font-mono">{fmtNum(s.periodMin, 1)} m</td>
                    <td className="pr-3 font-mono text-muted">{fmtUtc(s.epoch)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
      {selected && (
        <aside className="absolute inset-y-0 right-0 z-30 w-full max-w-[360px] overflow-y-auto border-l border-line bg-navy-900 p-4 shadow-2xl scroll-thin xl:static xl:z-auto">
          <div className="mb-2 flex justify-between">
            <span className="label">{t('Satellite record')}</span>
            <button onClick={() => setParams({ tab: 'catalog' })} className="text-muted hover:text-white">✕</button>
          </div>
          <SatDetails sat={selected} at={now} />
        </aside>
      )}
    </div>
  );
}
