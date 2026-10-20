import { Link } from 'react-router-dom';
import { t } from '../i18n';
import { useOrbit, useWorkspace } from '../store';
import { areaKm2 } from '../lib/geo';
import { Badge } from '../components/ui';

const MAIN = [
  { to: '/gis?task=flood', code: 'FLOOD', icon: '🌊', title: 'Flood mode', desc: 'Pick an area and the flood date — radar images before and after are found for you and water is mapped.' },
  { to: '/gis?task=vegetation', code: 'NDVI', icon: '🌾', title: 'Vegetation mode', desc: 'NDVI from the clearest recent Sentinel-2 image of your area, with statistics.' },
  { to: '/gis?task=urban', code: 'NDBI', icon: '🏙', title: 'Urban growth mode', desc: 'Compare built-up areas (NDBI) between two years.' },
  { to: '/gis?task=latest', code: 'IMAGE', icon: '📷', title: 'Latest imagery mode', desc: 'Find the clearest recent image of an area and download it (GeoTIFF / PNG).' },
  { to: '/gis?task=dams', code: 'RID', icon: '💧', title: 'Dam monitoring mode', desc: 'Current storage, inflow and release from the Royal Irrigation Department.' },
  { to: '/track?tab=passes', code: 'PASS', icon: '🛰', title: 'Satellite pass mode', desc: 'Pass times for NAPA, ISS or any satellite over your location.' },
];

const MORE = [
  { to: '/track?tab=live', icon: '🌍', title: 'Live satellite positions' },
  { to: '/track?tab=imaging', icon: '📡', title: 'Imaging swaths now' },
  { to: '/request?tab=new', icon: '📋', title: 'Request a new image' },
  { to: '/data?tab=catalog', icon: '📚', title: 'Satellite catalogue' },
];

export default function Home() {
  const { sats, status } = useOrbit();
  const { aoi } = useWorkspace();
  return (
    <div className="h-full overflow-y-auto scroll-thin">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-cyan-400">ORBITAL VISION</div>
        <h1 className="mt-1 text-2xl font-semibold text-white">{t('Select a mode')}</h1>
        <p className="mt-1 text-sm text-muted">{t('Each mode finds suitable satellite images and runs the analysis automatically.')}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {status === 'ready' && <Badge tone="cyan">{sats.length} {t('satellites')} · SGP4</Badge>}
          {aoi && <Badge>{t('Last area')}: {aoi.name} · {areaKm2(aoi.geometry).toFixed(1)} km²</Badge>}
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {MAIN.map((c) => (
            <Link
              key={c.to}
              to={c.to}
              className="group flex flex-col rounded-lg border border-line bg-navy-900 p-4 transition hover:border-cyan-400/50 hover:bg-navy-850"
            >
              <span className="flex items-start justify-between">
                <span className="text-3xl">{c.icon}</span>
                <span className="rounded border border-cyan-400/30 px-1.5 py-0.5 font-mono text-[9px] tracking-[0.2em] text-cyan-300">MODE · {c.code}</span>
              </span>
              <span className="mt-2 text-base font-semibold text-white">{t(c.title)}</span>
              <span className="mt-1 flex-1 text-xs leading-relaxed text-muted">{t(c.desc)}</span>
              <span className="mt-3 text-xs text-cyan-300 group-hover:underline">{t('Open mode')} →</span>
            </Link>
          ))}
        </div>

        <div className="mt-8">
          <div className="label mb-2">{t('Other tools')}</div>
          <div className="flex flex-wrap gap-2">
            {MORE.map((c) => (
              <Link key={c.to} to={c.to} className="rounded border border-line px-3 py-2 text-xs text-slate-200 hover:border-cyan-400/50 hover:text-white">
                {c.icon} {t(c.title)}
              </Link>
            ))}
          </div>
        </div>

        <p className="mt-8 text-[11px] leading-relaxed text-muted">
          {t('Satellite positions are calculated from public orbital data; images come from open Copernicus Sentinel and USGS Landsat archives via Microsoft Planetary Computer. Results are estimates from satellite data, not confirmation of events on the ground.')}
        </p>
      </div>
    </div>
  );
}
