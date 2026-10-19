import { useEffect, useMemo, useState } from 'react';
import { t } from '../../i18n';
import { Badge, Button, Input, KV, Notice, Select, Spinner } from '../ui';
import { Cesium } from '../../lib/cesium';
import { loadDams, mcmPerDayToM3s, storagePct, type DamStatus, type DamsResult } from '../../lib/dams';
import { fmtNum } from '../../lib/format';
import { useGis } from './GisContext';

const pctColor = (p: number | null) =>
  p == null ? '#8b98ab' : p < 30 ? '#f2665a' : p < 50 ? '#f5b84b' : p <= 80 ? '#4fd18b' : p <= 100 ? '#4f8dff' : '#c58bff';

export const DAM_LEGEND = [
  { color: '#f2665a', label: '< 30 %' },
  { color: '#f5b84b', label: '30–50 %' },
  { color: '#4fd18b', label: '50–80 %' },
  { color: '#4f8dff', label: '80–100 %' },
  { color: '#c58bff', label: '> 100 %' },
  { color: '#8b98ab', label: 'no data' },
];

function freshness(reportDate: string | null): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  if (!reportDate) return { label: 'Report date unknown', tone: 'warn' };
  const d = new Date(reportDate);
  if (Number.isNaN(d.getTime())) return { label: `Report date: ${reportDate}`, tone: 'warn' };
  const days = (Date.now() - d.getTime()) / 86400e3;
  return days <= 2 ? { label: 'Current', tone: 'ok' } : { label: `Stale (${Math.floor(days)} days old)`, tone: 'warn' };
}

export default function DamsPanel() {
  const g = useGis();
  const [res, setRes] = useState<DamsResult | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('all');
  const [pctMin, setPctMin] = useState(0);
  const [pctMax, setPctMax] = useState(200);
  const [sel, setSel] = useState<DamStatus | null>(null);

  const load = async () => {
    setBusy(true);
    setErr('');
    try {
      setRes(await loadDams());
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const groups = useMemo(() => [...new Set((res?.dams ?? []).map((d) => d.group).filter(Boolean))], [res]);
  const shown = useMemo(
    () =>
      (res?.dams ?? []).filter((d) => {
        const p = storagePct(d);
        if (q && !d.name.includes(q) && !d.name.toLowerCase().includes(q.toLowerCase())) return false;
        if (group !== 'all' && d.group !== group) return false;
        if (p != null && (p < pctMin || p > pctMax)) return false;
        return true;
      }),
    [res, q, group, pctMin, pctMax],
  );

  // pins
  useEffect(() => {
    const v = g.viewer;
    if (!v) return;
    const ds = new Cesium.CustomDataSource('dams');
    shown.forEach((d) => {
      if (d.lat == null || d.lon == null) return;
      const p = storagePct(d);
      ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(d.lon, d.lat),
        point: { pixelSize: 11, color: Cesium.Color.fromCssColorString(pctColor(p)), outlineColor: Cesium.Color.WHITE, outlineWidth: 2, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: {
          text: `${d.name}${p != null ? ` ${p.toFixed(0)}%` : ''}`,
          font: '11px Inter, sans-serif',
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#0b1524').withAlpha(0.8),
          pixelOffset: new Cesium.Cartesian2(0, -16),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1.5e6),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: { damId: d.id },
      });
    });
    g.putDataSource('dams', t('Dams & reservoirs (RID)'), ds, {
      meta: res ? `RID public API · report ${res.reportDate ?? '—'} · locations: OpenStreetMap` : undefined,
      legend: { items: DAM_LEGEND.map((x) => ({ ...x, label: t(x.label) })), note: t('Storage % of capacity as reported by the Royal Irrigation Department.') },
    });
    const h = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    h.setInputAction((e: any) => {
      const id = v.scene.pick(e.position)?.id?.properties?.damId?.getValue?.();
      if (id) setSel(shown.find((d) => d.id === id) ?? null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return () => h.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.viewer, shown]);

  const fr = freshness(res?.reportDate ?? null);
  const noPin = shown.filter((d) => d.lat == null).length;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-300">{t('Royal Irrigation Department — public reservoir API')}</span>
        <Button onClick={load} disabled={busy}>{busy ? <Spinner /> : t('Refresh')}</Button>
      </div>
      {err && (
        <Notice tone="bad">
          {t('Data unavailable')}: {err}
        </Notice>
      )}
      {res && (
        <div className="flex flex-wrap gap-1">
          <Badge tone={fr.tone}>{t(fr.label)}</Badge>
          <Badge>{t('Report')}: {res.reportDate ?? '—'}</Badge>
          <Badge>{res.dams.length} {t('reservoirs')}</Badge>
        </div>
      )}
      {res && <p className="text-[10px] leading-snug text-muted">{t('Locations')}: {res.locationsNote}{noPin ? ` · ${noPin} ${t('without a matched location')}` : ''}</p>}

      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search dam name')} />
      <div className="grid grid-cols-2 gap-1.5">
        <Select value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="all">{t('All regions / groups')}</option>
          {groups.map((x) => <option key={x}>{x}</option>)}
        </Select>
        <div className="flex items-center gap-1 text-[11px] text-muted">
          <Input type="number" value={pctMin} onChange={(e) => setPctMin(+e.target.value)} className="px-1" />–
          <Input type="number" value={pctMax} onChange={(e) => setPctMax(+e.target.value)} className="px-1" />%
        </div>
      </div>

      <ul className="max-h-56 overflow-y-auto rounded border border-line scroll-thin">
        {shown.map((d) => {
          const p = storagePct(d);
          return (
            <li key={d.id}>
              <button
                onClick={() => {
                  setSel(d);
                  if (d.lat != null && d.lon != null) g.viewer?.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(d.lon, d.lat, 60000), duration: 1.2 });
                }}
                className="flex w-full items-center gap-2 border-b border-white/5 px-2 py-1 text-left text-xs hover:bg-navy-800"
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: pctColor(p) }} />
                <span className="min-w-0 flex-1 truncate text-slate-200">{d.name}</span>
                {d.lat == null && <span className="text-[10px] text-muted" title={t('No location matched')}>⌀</span>}
                <span className="font-mono text-[10px] text-slate-300">{p != null ? `${p.toFixed(0)}%` : '—'}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {sel && (
        <div className="rounded border border-cyan-400/30 bg-navy-900 p-2.5">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-semibold text-white">{sel.name}</span>
            <button onClick={() => setSel(null)} className="text-muted hover:text-white">✕</button>
          </div>
          {(() => {
            const p = storagePct(sel);
            return (
              <div className="mb-2">
                <div className="h-2.5 overflow-hidden rounded bg-ink-950">
                  <div className="h-full" style={{ width: `${Math.min(100, p ?? 0)}%`, background: pctColor(p) }} />
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-slate-200">{p != null ? `${p.toFixed(1)} %` : t('Data unavailable')}</div>
              </div>
            );
          })()}
          <dl>
            <KV k={t('Agency / owner')} v={sel.owner || '—'} />
            <KV k={t('Region / group')} v={sel.group || '—'} />
            <KV k={t('Maximum capacity')} v={sel.capacity != null ? `${fmtNum(sel.capacity, 2)} ${t('million m³')}` : '—'} mono />
            <KV k={t('Normal storage')} v={sel.normalStorage != null ? `${fmtNum(sel.normalStorage, 2)} ${t('million m³')}` : '—'} mono />
            <KV k={t('Current storage')} v={sel.volume != null ? `${fmtNum(sel.volume, 2)} ${t('million m³')}` : '—'} mono />
            <KV k={t('Storage %')} v={storagePct(sel) != null ? `${storagePct(sel)!.toFixed(1)} % ${sel.percent != null ? '(RID)' : t('(current ÷ maximum × 100)')}` : '—'} mono />
            <KV k={t('Inflow')} v={sel.inflow != null ? `${fmtNum(sel.inflow, 2)} ${t('million m³/day')} ≈ ${fmtNum(mcmPerDayToM3s(sel.inflow), 0)} m³/s` : '—'} mono />
            <KV k={t('Release (outflow)')} v={sel.outflow != null ? `${fmtNum(sel.outflow, 2)} ${t('million m³/day')} ≈ ${fmtNum(mcmPerDayToM3s(sel.outflow), 0)} m³/s` : '—'} mono />
            <KV k={t('Data date')} v={res?.reportDate ?? '—'} mono />
            <KV k={t('Location')} v={sel.lat != null ? `${sel.lat.toFixed(4)}, ${sel.lon!.toFixed(4)} · ${sel.locationSource}` : t('No location matched in OpenStreetMap')} />
          </dl>
          <p className="mt-1.5 text-[10px] leading-snug text-muted">
            {t('Water level and daily/weekly/monthly history are not provided by this public API, so no trend chart is shown. Flow units as reported by RID (million m³ per day).')}
          </p>
        </div>
      )}
    </div>
  );
}
