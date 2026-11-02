import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { t } from '../i18n';
import { useOrbit, useWorkspace } from '../store';
import { areaKm2 } from '../lib/geo';
import { Badge } from '../components/ui';
import './home-panels.css';

/**
 * Panel pictures: sharp Esri World Imagery of one real place per mode, centred on the subject.
 * Served by /api/home-image, which caches them on the CDN (Esri renders each one on demand,
 * which is slow). A 160 px version loads first as a placeholder under the full picture.
 */
const placeImage = (id: string, w: 160 | 1600) => `/api/home-image?id=${id}&w=${w}`;

type Panel = {
  to: string;
  code: string;
  title: string;
  desc: string;
  img: string;
  loc: { lat: number; lon: number };
  imgNote: string;
  fallback: string;
  modes?: { start: string; icon: string; label: string }[];
};

const PANELS: Panel[] = [
  {
    to: '/disaster?tab=map', code: 'HAZARD', title: 'Disaster situation mode',
    desc: 'Floods, hotspots, earthquakes, heavy rain, drought and PM2.5 across Thailand from open agency data — with a situation report.',
    // Ayutthaya old city, ringed by the Chao Phraya, Pa Sak and Lopburi rivers — flood-prone (2011)
    img: 'ayutthaya', loc: { lat: 14.356, lon: 100.566 },
    imgNote: 'Ayutthaya', fallback: 'linear-gradient(160deg,#3a2a22,#1b2023 70%)',
  },
  {
    to: '/imagery?tab=flow', code: 'IMAGERY', title: 'Satellite imagery',
    desc: 'Choose an area, pick images on the timeline, then choose what to do with them.',
    // Bang Krachao: the green river loop in the middle of Bangkok
    img: 'bangkrachao', loc: { lat: 13.683, lon: 100.565 },
    imgNote: 'Bang Krachao, Bangkok', fallback: 'linear-gradient(160deg,#223a3a,#1b2023 70%)',
    modes: [
      { start: 'change', icon: '🔍', label: 'Change analysis' },
      { start: 'view', icon: '◐', label: 'Swipe / blink' },
      { start: 'flood', icon: '🌊', label: 'Flood' },
      { start: 'ndvi', icon: '🌾', label: 'Vegetation (NDVI)' },
      { start: 'ndbi', icon: '🏙', label: 'Urban growth (NDBI)' },
      { start: 'export', icon: '📷', label: 'Latest image / download' },
    ],
  },
  {
    to: '/imagery?tab=watch', code: 'WATCH', title: 'Border & area watch mode',
    desc: 'Weekly change checks along the Cambodia, Malaysia and Myanmar borders, forests and disaster areas — with an OPP-style report.',
    // Aranyaprathet – Poipet border crossing (Thailand–Cambodia)
    img: 'aranyaprathet', loc: { lat: 13.663, lon: 102.548 },
    imgNote: 'Aranyaprathet – Poipet', fallback: 'linear-gradient(160deg,#2a3a26,#1b2023 70%)',
  },
  {
    to: '/imagery?tab=advanced&task=dams', code: 'RID', title: 'Dam monitoring mode',
    desc: 'Current storage, inflow and release from the Royal Irrigation Department.',
    // Bhumibol Dam and its reservoir, Tak
    img: 'bhumibol', loc: { lat: 17.243, lon: 98.972 },
    imgNote: 'Bhumibol Dam, Tak', fallback: 'linear-gradient(160deg,#22323e,#1b2023 70%)',
  },
  {
    to: '/track?tab=passes', code: 'PASS', title: 'Satellite pass mode',
    desc: 'Pass times for NAPA, ISS or any satellite over your location.',
    // Suvarnabhumi Airport, Samut Prakan
    img: 'suvarnabhumi', loc: { lat: 13.690, lon: 100.750 },
    imgNote: 'Suvarnabhumi Airport', fallback: 'linear-gradient(160deg,#1e2226,#0f1213 70%)',
  },
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
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    if (active === null) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setActive(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const cls = ['ovp', active !== null && 's--el-active'].filter(Boolean).join(' ');

  return (
    <div className={cls}>
      <div className="ovp__top">
        <div>
          <div className="ovp__brand">Orbital Vision</div>
          <h1 className="ovp__title">{t('Select a mode')}</h1>
          <p className="ovp__sub">{t('Each mode finds suitable satellite images and runs the analysis automatically.')}</p>
        </div>
        <div className="ovp__badges">
          {status === 'ready' && <Badge tone="cyan">{sats.length} {t('satellites')} · SGP4</Badge>}
          {aoi && <Badge>{t('Last area')}: {aoi.name} · {areaKm2(aoi.geometry).toFixed(1)} km²</Badge>}
        </div>
      </div>

      <div className="ovp__stage">
        {PANELS.map((p, i) => {
          const isActive = active === i;
          const style = {
            '--i': i,
            '--img': `url("${placeImage(p.img, 1600)}"), url("${placeImage(p.img, 160)}")`,
            '--fallback': p.fallback,
          } as CSSProperties;
          return (
            <div
              key={p.code}
              className={'ovp__el' + (isActive ? ' s--active' : '')}
              style={style}
              role="button"
              tabIndex={active === null || isActive ? 0 : -1}
              aria-expanded={isActive}
              aria-label={t(p.title)}
              onClick={() => active !== i && setActive(i)}
              onKeyDown={(e) => {
                if (active === null && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  setActive(i);
                }
              }}
            >
              <div className="ovp__overflow">
                <div className="ovp__inner">
                  <div className="ovp__bg" />
                  <div className="ovp__dim" />
                  <div className="ovp__frame" />
                  <div className="ovp__preview">
                    <span className="ovp__code">MODE · {p.code}</span>
                    <h2 className="ovp__heading">{t(p.title)}</h2>
                  </div>
                  <div className="ovp__place">
                    {p.imgNote}
                    <span>{p.loc.lat.toFixed(3)}°N {p.loc.lon.toFixed(3)}°E</span>
                  </div>

                  <div className="ovp__content" aria-hidden={!isActive}>
                    <span className="ovp__code" style={{ alignSelf: 'flex-start' }}>MODE · {p.code}</span>
                    <div className="ovp__big">{t(p.title)}</div>
                    <p className="ovp__desc">{t(p.desc)}</p>
                    {p.modes && (
                      <div className="ovp__modes">
                        {p.modes.map((m) => (
                          <Link key={m.start} to={`${p.to}&start=${m.start}`} className="ovp__mode" tabIndex={isActive ? 0 : -1}>
                            {m.icon} {t(m.label)}
                          </Link>
                        ))}
                      </div>
                    )}
                    <Link to={p.to} className="ovp__open" tabIndex={isActive ? 0 : -1}>
                      {t('Open mode')} <span aria-hidden>→</span>
                    </Link>
                    <span className="ovp__credit">Esri World Imagery · {p.imgNote}</span>
                  </div>
                  <button
                    type="button"
                    className="ovp__close"
                    aria-label={t('Close')}
                    tabIndex={isActive ? 0 : -1}
                    onClick={(e) => {
                      e.stopPropagation();
                      setActive(null);
                    }}
                  />
                </div>
              </div>
              <div className="ovp__index" aria-hidden>
                <div className="ovp__index-back">{String(i + 1).padStart(2, '0')}</div>
                <div className="ovp__index-front">
                  <span>{String(i + 1).padStart(2, '0')}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="ovp__bottom">
        <div className="ovp__tools">
          <span className="label mr-1">{t('Other tools')}</span>
          {MORE.map((c) => (
            <Link key={c.to} to={c.to} className="ovp__tool">
              {c.icon} {t(c.title)}
            </Link>
          ))}
        </div>
        <p className="ovp__note">
          {t('Satellite positions are calculated from public orbital data; images come from open Copernicus Sentinel and USGS Landsat archives via Microsoft Planetary Computer. Results are estimates from satellite data, not confirmation of events on the ground.')}
        </p>
      </div>
    </div>
  );
}
