import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n';
import { Link } from 'react-router-dom';
import GlobeHost from '../components/GlobeHost';
import AoiPicker from '../components/AoiPicker';
import { Badge, Button, Field, Input, Notice, Panel, Select, cx } from '../components/ui';
import { Cesium, showAoi } from '../lib/cesium';
import { useWorkspace } from '../store';
import { PROVIDERS, type Provider } from '../data/providers';
import { areaKm2 } from '../lib/geo';
import { downloadJson } from '../lib/geo';
import { isoDay } from '../lib/format';
import { logAudit, saveRequest, uid, type AcquisitionRequest } from '../lib/repo';

type Sensor = 'optical' | 'sar';

const STEPS = ['Location', 'Method', 'Configure', 'Provider', 'Submit'];

function taskingProviders(sensor: Sensor): Provider[] {
  return PROVIDERS.filter((p) => p.tasking && (sensor === 'sar' ? p.sensors.includes('sar') : p.sensors.some((s) => s === 'optical' || s === 'multispectral')));
}

export default function NewAcquisition() {
  const { aoi } = useWorkspace();
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const [step, setStep] = useState(0);
  const [sensor, setSensor] = useState<Sensor>('optical');
  const [from, setFrom] = useState(isoDay(new Date(Date.now() + 86400000)));
  const [to, setTo] = useState(isoDay(new Date(Date.now() + 15 * 86400000)));
  const [resolution, setResolution] = useState('<=0.5 m');
  const [cloud, setCloud] = useState(20);
  const [bands, setBands] = useState('RGB + NIR');
  const [offNadir, setOffNadir] = useState(25);
  const [allowNight, setAllowNight] = useState(true);
  const [sarMode, setSarMode] = useState('Spotlight');
  const [polarisation, setPolarisation] = useState('Single (provider default)');
  const [priority, setPriority] = useState('Standard');
  const [productLevel, setProductLevel] = useState('Orthorectified');
  const [budget, setBudget] = useState('');
  const [title, setTitle] = useState('');
  const [providerId, setProviderId] = useState<string>('');
  const [req, setReq] = useState<AcquisitionRequest | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (viewer) showAoi(viewer, aoi?.geometry ?? null);
  }, [viewer, aoi]);

  const candidates = useMemo(() => taskingProviders(sensor), [sensor]);
  const provider = PROVIDERS.find((p) => p.id === providerId);

  const params = () => ({
    sensor,
    window: { from, to },
    resolution,
    ...(sensor === 'optical' ? { maxCloudPct: cloud, bands, maxOffNadirDeg: offNadir } : { mode: sarMode, polarisation, allowNight }),
    priority,
    productLevel,
    budget: budget ? { amount: Number(budget), currency: 'USD' } : null,
  });

  const persist = async (status: AcquisitionRequest['status'], note: string, source: 'platform' | 'user_reported' = 'platform') => {
    const now = new Date().toISOString();
    const base: AcquisitionRequest = req ?? {
      id: uid(),
      title: title || `${sensor === 'sar' ? 'SAR' : 'Optical'} tasking · ${aoi?.name ?? 'AOI'}`,
      kind: 'new_acquisition',
      providerId: providerId || 'unassigned',
      sensor,
      aoi: aoi?.geometry ?? null,
      params: {},
      status: 'draft',
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    const next: AcquisitionRequest = {
      ...base,
      title: title || base.title,
      providerId: providerId || base.providerId,
      aoi: aoi?.geometry ?? base.aoi,
      params: params(),
      status,
      history: [...base.history, { at: now, status, source, note }],
    };
    await saveRequest(next);
    setReq(next);
    void logAudit(`request.${status}`, { id: next.id, providerId: next.providerId });
    return next;
  };

  const requestPackage = (r: AcquisitionRequest) => ({
    type: 'FeatureCollection',
    properties: {
      generator: 'ORBITAL VISION',
      notice: 'Request package prepared locally. It is NOT an order and has not been sent to or accepted by any provider.',
      requestId: r.id,
      title: r.title,
      provider: provider ? { id: provider.id, name: provider.name, website: provider.website, portal: provider.portal ?? null } : null,
      parameters: r.params,
      createdAt: r.createdAt,
    },
    features: aoi ? [{ type: 'Feature', properties: { name: aoi.name, areaKm2: Math.round(areaKm2(aoi.geometry) * 100) / 100 }, geometry: aoi.geometry }] : [],
  });

  const canNext = [!!aoi, true, true, !!providerId, true][step];

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <div className="flex w-full shrink-0 flex-col overflow-y-auto border-line bg-ink-900 p-4 scroll-thin lg:w-[520px] lg:border-r">
        <div className="mb-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400">{t('C · New Acquisition')}</div>
          <h1 className="text-base font-semibold text-white">{t('Request a new satellite acquisition')}</h1>
        </div>

        <ol className="mb-4 grid grid-cols-5 gap-1">
          {STEPS.map((s, i) => (
            <li key={s}>
              <button
                onClick={() => i <= step && setStep(i)}
                className={cx('w-full border-t-2 pt-1.5 text-left font-mono text-[10px] uppercase tracking-wider', i === step ? 'border-cyan-400 text-cyan-300' : i < step ? 'border-cyan-400/40 text-slate-300' : 'border-line text-muted')}
              >
                {i + 1} {t(s)}
              </button>
            </li>
          ))}
        </ol>

        {step === 0 && (
          <Panel title={t('Area of interest')}>
            <AoiPicker viewer={viewer} />
          </Panel>
        )}

        {step === 1 && (
          <Panel title={t('Acquisition method')}>
            <div className="space-y-2">
              <Link to="/imagery" className="block rounded border border-line p-3 hover:border-cyan-400/40">
                <div className="text-sm text-white">{t('Search existing imagery archives')}</div>
                <div className="text-xs text-muted">{t('Fastest and often free — Sentinel-1/2 and Landsat are searchable now.')}</div>
              </Link>
              <button onClick={() => setStep(2)} className="block w-full rounded border border-cyan-400/50 bg-cyan-400/5 p-3 text-left">
                <div className="text-sm text-white">{t('Request a new satellite acquisition')}</div>
                <div className="text-xs text-muted">{t('Prepare a tasking request for a commercial or agency provider.')}</div>
              </button>
              <Link to="/providers" className="block rounded border border-line p-3 hover:border-cyan-400/40">
                <div className="text-sm text-white">{t('Compare imagery providers')}</div>
                <div className="text-xs text-muted">{t('Sensors, resolution classes, ordering methods and integration status.')}</div>
              </Link>
            </div>
          </Panel>
        )}

        {step === 2 && (
          <Panel title={t('Configure request')}>
            <div className="space-y-3">
              <Field label={t('Request title')}><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('e.g. Port monitoring — weekly')} /></Field>
              <div className="grid grid-cols-2 gap-1.5">
                <Button variant={sensor === 'optical' ? 'active' : 'ghost'} onClick={() => { setSensor('optical'); setProviderId(''); }}>{t('Optical')}</Button>
                <Button variant={sensor === 'sar' ? 'active' : 'ghost'} onClick={() => { setSensor('sar'); setProviderId(''); }}>SAR</Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('Window start')}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
                <Field label={t('Window end')}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
              </div>
              <Field label={t('Preferred resolution')}>
                <Select value={resolution} onChange={(e) => setResolution(e.target.value)}>
                  {['<=0.3 m', '<=0.5 m', '<=1 m', '<=3 m', 'Any'].map((r) => <option key={r}>{r}</option>)}
                </Select>
              </Field>
              {sensor === 'optical' ? (
                <>
                  <Field label={`${t('Max cloud cover')} · ${cloud}%`}><input type="range" min={0} max={100} value={cloud} onChange={(e) => setCloud(+e.target.value)} className="w-full" /></Field>
                  <Field label={t('Spectral bands')}>
                    <Select value={bands} onChange={(e) => setBands(e.target.value)}>
                      {['Panchromatic', 'RGB', 'RGB + NIR', 'Full multispectral (provider)'].map((b) => <option key={b}>{b}</option>)}
                    </Select>
                  </Field>
                  <Field label={`${t('Max off-nadir angle')} · ${offNadir}°`} hint={t('Lower angles give better geometry but fewer opportunities')}>
                    <input type="range" min={0} max={45} value={offNadir} onChange={(e) => setOffNadir(+e.target.value)} className="w-full" />
                  </Field>
                  <Notice>{t('Optical acquisitions need daylight; night requests are not offered for this sensor type.')}</Notice>
                </>
              ) : (
                <>
                  <Field label={t('Imaging mode (provider-specific naming)')}>
                    <Select value={sarMode} onChange={(e) => setSarMode(e.target.value)}>
                      {['Spotlight', 'Stripmap', 'Scan / wide area'].map((m) => <option key={m}>{m}</option>)}
                    </Select>
                  </Field>
                  <Field label={t('Polarisation')}>
                    <Select value={polarisation} onChange={(e) => setPolarisation(e.target.value)}>
                      {['Single (provider default)', 'VV', 'HH', 'Dual (if supported)'].map((m) => <option key={m}>{m}</option>)}
                    </Select>
                  </Field>
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={allowNight} onChange={(e) => setAllowNight(e.target.checked)} /> {t('Allow night-time acquisitions (SAR images day and night)')} </label>
                </>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('Priority')}>
                  <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                    {['Standard', 'Priority', 'Urgent / rush'].map((p) => <option key={p}>{p}</option>)}
                  </Select>
                </Field>
                <Field label={t('Product level')}>
                  <Select value={productLevel} onChange={(e) => setProductLevel(e.target.value)}>
                    {(sensor === 'optical' ? ['Basic / sensor', 'Orthorectified', 'Analysis-ready'] : ['SLC', 'GRD / detected', 'Geocoded']).map((p) => <option key={p}>{p}</option>)}
                  </Select>
                </Field>
              </div>
              <Field label={t('Budget limit (USD, optional)')}><Input type="number" min={0} value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={t('No limit')} /></Field>
            </div>
          </Panel>
        )}

        {step === 3 && (
          <Panel title={t(`Providers offering ${sensor === 'sar' ? 'SAR' : 'optical'} tasking`)}>
            <div className="space-y-2">
              {candidates.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setProviderId(p.id)}
                  className={cx('block w-full rounded border p-3 text-left', providerId === p.id ? 'border-cyan-400/60 bg-cyan-400/5' : 'border-line hover:border-cyan-400/30')}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-white">{p.name}</span>
                    <Badge tone={p.integration === 'integrated-stac' ? 'ok' : 'warn'}>{p.integration === 'not-integrated' ? t('Manual submission') : t('Integrated')}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted">{p.constellation}</div>
                  <div className="mt-1 text-xs text-slate-300">{p.resolutionNote}</div>
                  <div className="mt-1 font-mono text-[10px] text-muted">{t('Price:')} {p.pricing}</div>
                </button>
              ))}
              <Notice>{t('Whether a provider can actually image this AOI in the requested window depends on their schedule, pointing limits and approval. Use the')} <Link to="/coverage" className="text-cyan-300 underline">{t('Coverage Planner')}</Link> {t('for orbital pass estimates.')} </Notice>
            </div>
          </Panel>
        )}

        {step === 4 && (
          <Panel title={t('Review & submit')}>
            <div className="space-y-3 text-xs">
              <Notice tone="warn">
                {provider?.name ?? t('This provider')} has no API integration in this platform. Nothing is sent automatically. You can save a draft,
                export a request package, and submit it through the provider's official channel.
              </Notice>
              <pre className="max-h-48 overflow-auto rounded bg-ink-950 p-2 font-mono text-[10px] text-slate-300 scroll-thin">{JSON.stringify(params(), null, 2)}</pre>
              <div className="flex flex-wrap gap-1.5">
                <Button onClick={async () => { await persist('draft', 'Draft saved'); setMsg('Draft saved to Orders & Projects.'); }}>{t('Save draft')}</Button>
                <Button
                  variant="primary"
                  onClick={async () => {
                    const r = await persist('awaiting_confirmation', 'Request package exported for manual submission');
                    downloadJson(`orbital-vision-request-${r.id.slice(0, 8)}.geojson`, requestPackage(r));
                    setMsg('Package downloaded. Status: Awaiting confirmation — submit it via the official channel, then confirm below.');
                  }}
                >{t('Export request package')} </Button>
                {provider && (
                  <a href={provider.portal ?? provider.website} target="_blank" rel="noreferrer">
                    <Button>{t('Official ordering channel ↗')}</Button>
                  </a>
                )}
              </div>
              {req?.status === 'awaiting_confirmation' && (
                <div className="rounded border border-line p-2.5">
                  <p className="mb-2 text-slate-300">{t('After you have submitted the package to the provider yourself:')}</p>
                  <Button
                    onClick={async () => {
                      await persist('submitted_to_provider', 'User reports manual submission to provider', 'user_reported');
                      setMsg('Recorded as “Submitted to provider (user-reported)”. This is not a provider confirmation.');
                    }}
                  >{t('I submitted it manually')} </Button>
                </div>
              )}
              {msg && <Notice>{msg}</Notice>}
              {req && <Link to="/orders" className="text-cyan-300 underline">{t('Track in Orders & Projects →')}</Link>}
            </div>
          </Panel>
        )}

        <div className="mt-4 flex justify-between">
          <Button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>{t('Back')}</Button>
          {step < 4 && <Button variant="primary" onClick={() => setStep(step + 1)} disabled={!canNext}>{t('Next')}</Button>}
        </div>
      </div>
      <div className="relative min-h-[300px] flex-1">
        <GlobeHost onReady={setViewer} />
      </div>
    </div>
  );
}
