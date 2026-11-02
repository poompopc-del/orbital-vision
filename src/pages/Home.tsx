import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { t, useLang } from '../i18n';
import { useOrbit, useWorkspace } from '../store';
import { areaKm2 } from '../lib/geo';
import './home-hero.css';

/** Whole-world Blue Marble from NASA GIBS (public domain), wrapped on the CSS globe. */
const EARTH =
  'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1' +
  '&LAYERS=BlueMarble_NextGeneration&STYLES=&SRS=EPSG:4326&BBOX=-180,-90,180,90&WIDTH=2048&HEIGHT=1024&FORMAT=image/jpeg';

const MODES: { to: string; title: string; desc: string; sub?: { start: string; label: string }[] }[] = [
  {
    to: '/imagery?tab=flow', title: 'Satellite imagery',
    desc: 'Choose an area, pick images on the timeline, then choose what to do with them.',
    sub: [
      { start: 'change', label: 'Change analysis' },
      { start: 'flood', label: 'Flood' },
      { start: 'ndvi', label: 'Vegetation (NDVI)' },
      { start: 'export', label: 'Latest image / download' },
    ],
  },
  { to: '/disaster?tab=map', title: 'Disaster situation mode', desc: 'Floods, hotspots, earthquakes, heavy rain, drought and PM2.5 across Thailand from open agency data — with a situation report.' },
  { to: '/imagery?tab=watch', title: 'Border & area watch mode', desc: 'Weekly change checks along the Cambodia, Malaysia and Myanmar borders, forests and disaster areas — with an OPP-style report.' },
  { to: '/imagery?tab=advanced&task=dams', title: 'Dam monitoring mode', desc: 'Current storage, inflow and release from the Royal Irrigation Department.' },
  { to: '/track?tab=passes', title: 'Satellite pass mode', desc: 'Pass times for NAPA, ISS or any satellite over your location.' },
];

const MORE = [
  { to: '/track?tab=live', icon: '🌍', title: 'Live satellite positions' },
  { to: '/track?tab=imaging', icon: '📡', title: 'Imaging swaths now' },
  { to: '/request?tab=new', icon: '📋', title: 'Request a new image' },
  { to: '/data?tab=catalog', icon: '📚', title: 'Satellite catalogue' },
];

function useUtc() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now.toISOString().slice(11, 19);
}

/** Small line-art satellite: body, dish and two solar wings. */
function SatelliteIcon() {
  return (
    <svg viewBox="0 0 88 52" aria-hidden>
      <g stroke="#cfefff" strokeWidth="1" fill="none">
        <rect x="2" y="16" width="28" height="20" rx="1.5" fill="rgba(34,90,160,.55)" />
        <path d="M2 23h28M2 29h28M9 16v20M16 16v20M23 16v20" strokeOpacity=".55" />
        <rect x="58" y="16" width="28" height="20" rx="1.5" fill="rgba(34,90,160,.55)" />
        <path d="M58 23h28M58 29h28M65 16v20M72 16v20M79 16v20" strokeOpacity=".55" />
        <path d="M30 26h6M52 26h6" />
        <rect x="36" y="17" width="16" height="18" rx="2.5" fill="#e8f4ff" stroke="#9fdcf5" />
        <path d="M44 17v-6" />
        <path d="M37 9c3 4 11 4 14 0" fill="#e8f4ff" stroke="#9fdcf5" />
        <circle cx="44" cy="26" r="2.2" fill="#22d3ee" stroke="none" />
      </g>
    </svg>
  );
}

export default function Home() {
  const { sats, status } = useOrbit();
  const { aoi } = useWorkspace();
  const lang = useLang((s) => s.lang);
  const L = (th: string, en: string) => (lang === 'th' ? th : en);
  const utc = useUtc();

  return (
    <div className="ovh">
      <div className="ovh__stars" aria-hidden />

      <section className="ovh__hero">
        <div className="ovh__copy">
          <div className="ovh__eyebrow ovh__fade">Orbital Vision</div>
          <h1 className="ovh__h1">
            <span className="ovh__line"><span>{L('มองเห็นทุก', 'See every')}</span></span>
            <span className="ovh__line"><span><b>{L('การเปลี่ยนแปลง', 'change')}</b></span></span>
            <span className="ovh__line"><span>{L('จากอวกาศ', 'from orbit')}</span></span>
          </h1>
          <p className="ovh__lead ovh__fade" style={{ animationDelay: '0.45s' }}>
            {t('Each mode finds suitable satellite images and runs the analysis automatically.')}
          </p>
          <div className="ovh__ctas ovh__fade" style={{ animationDelay: '0.6s' }}>
            <Link to="/imagery?tab=flow" className="ovh__btn ovh__btn--primary">
              {L('เริ่มวิเคราะห์ภาพ', 'Start an analysis')} <span aria-hidden>→</span>
            </Link>
            <Link to="/track?tab=live" className="ovh__btn ovh__btn--ghost">
              {t('Live satellite positions')}
            </Link>
          </div>
          <div className="ovh__telemetry ovh__fade" style={{ animationDelay: '0.75s' }}>
            <div className="ovh__tm">
              <b className="ovh__live">{status === 'ready' ? sats.length.toLocaleString('en-US') : '—'}</b>
              <span>{L('ดาวเทียมที่ติดตาม (SGP4)', 'satellites tracked (SGP4)')}</span>
            </div>
            <div className="ovh__tm">
              <b>{utc}</b>
              <span>UTC</span>
            </div>
            {aoi && (
              <div className="ovh__tm">
                <b>{areaKm2(aoi.geometry).toFixed(1)} km²</b>
                <span>{t('Last area')}: {aoi.name}</span>
              </div>
            )}
          </div>
        </div>

        <div className="ovh__scene" aria-hidden>
          <div className="ovh__world">
            <div className="ovh__atmo" />
            <div className="ovh__globe" style={{ '--tex': `url("${EARTH}")` } as CSSProperties} />
            <div className="ovh__orbit">
              <div className="ovh__ring" />
              <div className="ovh__ring ovh__ring--2" />
              <div className="ovh__arm">
                <div className="ovh__sat"><SatelliteIcon /></div>
              </div>
            </div>
          </div>
          <div className="ovh__hud ovh__hud--a">
            {L('วงโคจรต่ำ', 'Low Earth orbit')}
            <b>~500–800 km</b>
          </div>
          <div className="ovh__hud ovh__hud--b">
            Sentinel-1 · Sentinel-2 · Landsat
            <b>{L('ภาพเปิดฟรี', 'open imagery')}</b>
          </div>
        </div>
      </section>

      <nav className="ovh__modes" aria-label={t('Select a mode')}>
        {MODES.map((m, i) => (
          <div key={m.to} className="ovh__card" style={{ '--i': i } as CSSProperties}>
            <span className="ovh__num">{String(i + 1).padStart(2, '0')} /</span>
            <h3>{t(m.title)}</h3>
            <p>{t(m.desc)}</p>
            {m.sub && (
              <div className="ovh__sub">
                {m.sub.map((s) => (
                  <Link key={s.start} to={`${m.to}&start=${s.start}`}>{t(s.label)}</Link>
                ))}
              </div>
            )}
            <Link to={m.to} className="ovh__go">{t('Open mode')} →</Link>
          </div>
        ))}
      </nav>

      <footer className="ovh__foot">
        <div className="ovh__tools">
          <span className="label mr-1">{t('Other tools')}</span>
          {MORE.map((c) => (
            <Link key={c.to} to={c.to} className="ovh__tool">{c.icon} {t(c.title)}</Link>
          ))}
        </div>
        <p className="ovh__note">
          {t('Satellite positions are calculated from public orbital data; images come from open Copernicus Sentinel and USGS Landsat archives via Microsoft Planetary Computer. Results are estimates from satellite data, not confirmation of events on the ground.')}
          {' '}Earth: NASA GIBS Blue Marble.
        </p>
      </footer>
    </div>
  );
}
