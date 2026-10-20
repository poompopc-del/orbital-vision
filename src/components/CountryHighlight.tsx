import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n';
import { Cesium } from '../lib/cesium';
import { ASEAN, loadCountries, type Country } from '../lib/countries';
import { Button, Input, Spinner } from './ui';

interface Pick {
  id: string;
  color: string;
}
interface Cfg {
  picks: Pick[];
  fill: number; // 0..1
  width: number;
}
const KEY = 'ov.countryHighlight.v1';
const DEFAULT: Cfg = { picks: [], fill: 0.25, width: 2 };
const COLORS = ['#facc15', '#22d3ee', '#f472b6', '#4fd18b', '#ff7a59', '#c58bff'];

function load(): Cfg {
  try {
    return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return DEFAULT;
  }
}

/** Highlights chosen countries (fill + outline) on a Cesium viewer. */
export default function CountryHighlight({ viewer, open, onClose }: { viewer: Cesium.Viewer | null; open: boolean; onClose: () => void }) {
  const [cfg, setCfg] = useState<Cfg>(load);
  const [all, setAll] = useState<Country[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(cfg));
    } catch {
      /* ignore */
    }
  }, [cfg]);

  // outlines are only downloaded once something is highlighted or the panel is opened
  useEffect(() => {
    if (all || (!open && !cfg.picks.length)) return;
    loadCountries().then(setAll, (e) => setErr(e.message));
  }, [open, cfg.picks.length, all]);

  const byId = useMemo(() => new Map((all ?? []).map((c) => [c.id, c])), [all]);
  const label = (c: Country) => (c.nameTh ? `${c.nameTh} · ${c.name}` : c.name);

  useEffect(() => {
    if (!viewer || !all || !cfg.picks.length) return;
    const ds = new Cesium.CustomDataSource('country-highlight');
    for (const p of cfg.picks) {
      const c = byId.get(p.id);
      if (!c) continue;
      const col = Cesium.Color.fromCssColorString(p.color);
      const polys = c.geometry.type === 'Polygon' ? [c.geometry.coordinates] : c.geometry.coordinates;
      for (const rings of polys) {
        const toPos = (r: GeoJSON.Position[]) => Cesium.Cartesian3.fromDegreesArray(r.flatMap(([x, y]) => [x, y]));
        if (cfg.fill > 0) {
          ds.entities.add({
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(toPos(rings[0]), rings.slice(1).map((h) => new Cesium.PolygonHierarchy(toPos(h)))),
              material: col.withAlpha(cfg.fill),
              height: 0,
            },
          });
        }
        if (cfg.width > 0) {
          for (const r of rings) {
            ds.entities.add({ polyline: { positions: toPos(r), width: cfg.width, material: col, arcType: Cesium.ArcType.NONE } });
          }
        }
      }
    }
    void viewer.dataSources.add(ds);
    viewer.scene.requestRender();
    return () => {
      if (!viewer.isDestroyed()) {
        viewer.dataSources.remove(ds, true);
        viewer.scene.requestRender();
      }
    };
  }, [viewer, all, byId, cfg]);

  const add = (ids: string[]) =>
    setCfg((o) => {
      const have = new Set(o.picks.map((p) => p.id));
      const extra = ids.filter((i) => !have.has(i)).map((id, k) => ({ id, color: COLORS[(o.picks.length + k) % COLORS.length] }));
      return { ...o, picks: [...o.picks, ...extra] };
    });

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!all || !s) return [];
    return all.filter((c) => c.name.toLowerCase().includes(s) || c.nameTh.includes(q.trim()) || c.id.toLowerCase() === s).slice(0, 8);
  }, [q, all]);

  if (!open) return null;
  return (
    <div className="w-72 rounded-md border border-line bg-ink-950/90 p-2.5 text-xs backdrop-blur">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="label">🏳 {t('Highlight countries')}</span>
        <button onClick={onClose} className="text-muted hover:text-white">✕</button>
      </div>
      {!all && !err && <div className="flex items-center gap-2 text-muted"><Spinner /> {t('Loading country outlines…')}</div>}
      {err && <p className="text-bad">{err}</p>}
      {all && (
        <>
          <div className="relative">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search a country (Thai or English)')} className="!py-1 text-xs" />
            {matches.length > 0 && (
              <ul className="absolute left-0 right-0 top-8 z-30 max-h-56 overflow-auto rounded border border-line bg-navy-850 shadow-xl scroll-thin">
                {matches.map((c) => (
                  <li key={c.id}>
                    <button onClick={() => { add([c.id]); setQ(''); }} className="block w-full px-2 py-1 text-left text-slate-200 hover:bg-navy-700">{label(c)}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <Button onClick={() => add(['THA'])}>{t('Thailand')}</Button>
            <Button onClick={() => add(ASEAN)}>ASEAN</Button>
            {cfg.picks.length > 0 && <Button variant="danger" onClick={() => setCfg({ ...cfg, picks: [] })}>{t('Clear')}</Button>}
          </div>
          {cfg.picks.length > 0 && (
            <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto scroll-thin">
              {cfg.picks.map((p) => {
                const c = byId.get(p.id);
                return (
                  <li key={p.id} className="flex items-center gap-1.5">
                    <input
                      type="color"
                      value={p.color}
                      onChange={(e) => setCfg({ ...cfg, picks: cfg.picks.map((x) => (x.id === p.id ? { ...x, color: e.target.value } : x)) })}
                      className="h-5 w-7 cursor-pointer rounded border border-line bg-transparent p-0"
                    />
                    <span className="min-w-0 flex-1 truncate text-slate-200">{c ? label(c) : p.id}</span>
                    <button onClick={() => setCfg({ ...cfg, picks: cfg.picks.filter((x) => x.id !== p.id) })} className="text-muted hover:text-bad">✕</button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] text-muted">{t('Fill')} {Math.round(cfg.fill * 100)}%</span>
              <input type="range" min={0} max={0.8} step={0.05} value={cfg.fill} onChange={(e) => setCfg({ ...cfg, fill: +e.target.value })} className="w-full" />
            </label>
            <label className="block">
              <span className="text-[10px] text-muted">{t('Outline')} {cfg.width}px</span>
              <input type="range" min={0} max={6} step={1} value={cfg.width} onChange={(e) => setCfg({ ...cfg, width: +e.target.value })} className="w-full" />
            </label>
          </div>
          <p className="mt-1 text-[10px] text-muted">{t('Borders: Natural Earth 1:50m (public domain), generalised — not for legal boundary use.')}</p>
        </>
      )}
    </div>
  );
}
