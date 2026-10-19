import { confidenceForAge, elementAgeDays, propagateSubPoint, type SatRecord } from '../lib/orbit';
import { t } from '../i18n';
import { SENSOR_LABEL } from '../data/providers';
import { fmtLatLon, fmtNum, fmtUtc } from '../lib/format';
import { Badge, KV } from './ui';

export default function SatDetails({ sat, at, showTle = true }: { sat: SatRecord; at: Date; showTle?: boolean }) {
  const m = sat.mission;
  const p = sat.provider;
  const pos = propagateSubPoint(sat, at);
  const age = elementAgeDays(sat, at);
  const conf = confidenceForAge(age);
  const tasking = m?.tasking === 'commercial' ? t('Commercial tasking via provider') : m?.tasking === 'agency' ? t('Requests via agency') : m?.tasking === 'unknown' ? t('Unknown') : t('No user tasking');
  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold text-white">{sat.name}</div>
        <div className="text-xs text-muted">{p?.name ?? t('Unknown operator')}</div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {m && <Badge tone="cyan">{t(SENSOR_LABEL[m.sensor])}</Badge>}
          {p && <Badge>{t(p.access)}</Badge>}
          <Badge tone={conf.tone}>{conf.label}</Badge>
        </div>
      </div>

      <div>
        <div className="label mb-1">{t('Propagated position')}</div>
        <dl>
          <KV k={t('Sub-satellite point')} v={pos ? fmtLatLon(pos.lat, pos.lon) : t('Propagation failed')} mono />
          <KV k={t('Altitude')} v={pos ? `${fmtNum(pos.heightKm, 1)} km` : '—'} mono />
          <KV k={t('At (sim time)')} v={fmtUtc(at)} mono />
        </dl>
        <p className="mt-1 text-[10px] leading-snug text-muted">{t('PROPAGATED ORBIT (SGP4 from public elements) — not live telemetry. Says nothing about sensor pointing, imaging activity or availability.')} </p>
      </div>

      <div>
        <div className="label mb-1">{t('Orbit')}</div>
        <dl>
          <KV k="NORAD ID" v={sat.noradId} mono />
          <KV k={t('Intl designator')} v={sat.intlDesignator || '—'} mono />
          <KV k={t('Orbit type')} v={sat.orbitType} />
          <KV k={t('Perigee / apogee')} v={`${fmtNum(sat.perigeeKm, 0)} / ${fmtNum(sat.apogeeKm, 0)} km`} mono />
          <KV k={t('Inclination')} v={`${fmtNum(sat.inclinationDeg, 2)}°`} mono />
          <KV k={t('Period')} v={`${fmtNum(sat.periodMin, 1)} min`} mono />
          <KV k={t('Element epoch')} v={fmtUtc(sat.epoch)} mono />
        </dl>
      </div>

      {m && (
        <div>
          <div className="label mb-1">{t('Mission & sensor')}</div>
          <dl>
            <KV k={t('Mission')} v={m.name} />
            <KV k={t('Mission type')} v={m.missionType} />
            <KV k={t('Instrument')} v={m.instrument} />
            <KV k={t('Nominal resolution')} v={m.resolution} />
            <KV k={t('Swath')} v={m.swathKm ? `${m.swathKm} km (documented)` : t('Not documented here')} />
            <KV k={t('Spectral bands')} v={m.bands} />
            <KV k={t('Capabilities')} v={m.capabilities} />
            <KV k={t('Historical imagery')} v={m.archive} />
            <KV k={t('Tasking')} v={tasking} />
            <KV k={t('Integration')} v={p?.integration === 'integrated-stac' ? t('Archive search (public STAC)') : t('Not integrated — manual / official portal')} />
          </dl>
        </div>
      )}

      {showTle && (
        <div>
          <div className="label mb-1">{t('Element set (TLE)')}</div>
          <pre className="overflow-x-auto rounded bg-ink-950 p-2 font-mono text-[10px] leading-relaxed text-slate-300 scroll-thin">
            {sat.tle1}
            {'\n'}
            {sat.tle2}
          </pre>
        </div>
      )}
    </div>
  );
}
