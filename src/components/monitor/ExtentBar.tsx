// Map extent controls for surveillance mode: whole-Thailand overview (default), regional border
// focus toward one neighbour, or the watch areas. Borders are drawn from Natural Earth with their
// source and limits stated; the share of the view outside Thailand is measured and shown.
import { useEffect, useState } from 'react';
import { useLang } from '../../i18n';
import { Cesium } from '../../lib/cesium';
import { loadCountries } from '../../lib/countries';
import { borderLines, NEIGHBOURS, type Neighbour } from '../../lib/border';
import { clearBoundary, getBoundary, importBoundary, onBoundaryChange, type CustomBoundary } from '../../lib/boundary';
import { bboxOfCoords, bboxOfGeometry, borderFocusRect, outsideShare, overviewRect, roughCentre, THAILAND_BBOX_FALLBACK, type BBox4 } from '../../lib/extent';
import { cx } from '../ui';

const useL = () => {
  const lang = useLang((s) => s.lang);
  return (th: string, en: string) => (lang === 'th' ? th : en);
};

export type ExtentMode = 'overview' | 'border' | 'custom';

export default function ExtentBar({
  viewer, customRect, onLines, nb, onNb, shift, onShift, tileCount,
}: {
  viewer: Cesium.Viewer | null;
  customRect: BBox4 | null;
  onLines: (l: [number, number][][]) => void;
  nb: Neighbour;
  onNb: (n: Neighbour) => void;
  shift: number;
  onShift: (v: number) => void;
  tileCount: number;
}) {
  const L = useL();
  const [mode, setMode] = useState<ExtentMode>('overview');
  const share = 0.5; // camera frames the border line centred; the slider moves the watch boxes
  const [measured, setMeasured] = useState<number | null>(null);
  const [thBox, setThBox] = useState<BBox4>(THAILAND_BBOX_FALLBACK);
  const [srcOk, setSrcOk] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState<CustomBoundary | null>(null);
  const [impBusy, setImpBusy] = useState(false);
  const [impErr, setImpErr] = useState('');
  useEffect(() => {
    const load = () => void getBoundary().then(setCustom);
    load();
    return onBoundaryChange(load);
  }, []);
  const doImport = async (f: File) => {
    setImpBusy(true);
    setImpErr('');
    try {
      await importBoundary(f.name, await f.text());
      void apply(mode);
    } catch (e: any) {
      setImpErr(e?.message ?? String(e));
    } finally {
      setImpBusy(false);
    }
  };
  const landLines = (b: CustomBoundary | null) => (b ? ['KHM', 'LAO', 'MMR', 'MYS'].flatMap((k) => b.lines[k] ?? []) : []);

  useEffect(() => {
    loadCountries()
      .then((cs) => {
        const th = cs.find((c) => c.id === 'THA');
        if (th) setThBox(bboxOfGeometry(th.geometry));
        setSrcOk(true);
      })
      .catch(() => setSrcOk(false));
  }, []);

  const fly = (r: BBox4, instant = false) => {
    if (!viewer) return;
    const rect = Cesium.Rectangle.fromDegrees(...r);
    if (instant) viewer.camera.setView({ destination: rect });
    else viewer.camera.flyTo({ destination: rect, duration: 1.2 });
  };
  const measure = async (r: BBox4) => {
    const cs = await loadCountries().catch(() => null);
    const th = cs?.find((c) => c.id === 'THA');
    setMeasured(th ? outsideShare(r, th.geometry) : null);
  };

  const apply = async (m: ExtentMode = mode, instant = false) => {
    if (m === 'overview') {
      onLines(landLines(await getBoundary()));
      const r = overviewRect(thBox);
      fly(r, instant);
      void measure(r);
    } else if (m === 'border') {
      const lines = await borderLines(nb).catch(() => [] as [number, number][][]);
      onLines(lines);
      const cs = await loadCountries().catch(() => null);
      const n = cs?.find((c) => c.id === nb);
      const th = cs?.find((c) => c.id === 'THA');
      if (!lines.length || !n || !th) return;
      const r = borderFocusRect(bboxOfCoords(lines.flat()), roughCentre(n.geometry), roughCentre(th.geometry), share);
      fly(r);
      void measure(r);
      onNb(nb);
    } else if (customRect) {
      onLines([]);
      fly(customRect);
      void measure(customRect);
    }
  };

  // default: whole Thailand on first load
  useEffect(() => {
    if (viewer) void apply('overview', true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, thBox.join(',')]);
  const setNb = (n: Neighbour) => {
    onNb(n);
  };
  useEffect(() => {
    if (mode === 'border') void apply('border');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nb]);

  return (
    <div className="pointer-events-auto absolute right-3 top-3 z-10 w-[268px] rounded-md border border-line bg-ink-950/90 p-2 text-[11px] text-slate-200 backdrop-blur">
      <div className="flex items-center gap-1">
        {([['overview', L('ภาพรวมประเทศไทย', 'Thailand overview')], ['border', L('เน้นชายแดน', 'Border focus')], ['custom', L('พื้นที่เฝ้าระวัง', 'Custom AOI')]] as const).map(([k, t]) => (
          <button key={k} disabled={k === 'custom' && !customRect} onClick={() => { setMode(k); void apply(k); }} className={cx('flex-1 rounded border px-1 py-1 disabled:opacity-40', mode === k ? 'border-cyan-400 bg-cyan-400/15 text-white' : 'border-line hover:border-cyan-400/40')}>{t}</button>
        ))}
      </div>
      <div className="mt-1 flex items-center gap-1">
        <button onClick={() => void apply()} className="flex-1 rounded border border-line px-1 py-1 hover:border-cyan-400/40">↺ {L('กลับมุมมองเฝ้าระวัง', 'Reset to surveillance extent')}</button>
        <button onClick={() => setOpen(!open)} className="rounded border border-line px-2 py-1 hover:border-cyan-400/40" title={L('ตั้งค่า', 'Settings')}>{open ? '▴' : '▾'}</button>
      </div>
      {(open || mode === 'border') && (
        <div className="mt-1.5 space-y-1.5 border-t border-line pt-1.5">
          {mode === 'border' && (
            <>
              <div className="flex items-center gap-1">
                <span className="text-muted">{L('ชายแดนไทย–', 'Thailand–')}</span>
                <select value={nb} onChange={(e) => setNb(e.target.value as Neighbour)} className="flex-1 rounded border border-line bg-ink-950 px-1 py-0.5">
                  {NEIGHBOURS.map((n) => <option key={n.id} value={n.id}>{L(n.th, n.en)}</option>)}
                </select>
              </div>
              <div>
                <div className="font-semibold">{L('ย้ายกรอบเฝ้าระวังเข้าหา', 'Move the watch boxes toward')}</div>
                <div className="flex justify-between text-muted"><span>◀ {L('ฝั่งไทย', 'Thailand')}</span><span>{L(`ฝั่ง${NEIGHBOURS.find((x) => x.id === nb)?.th ?? ''}`, NEIGHBOURS.find((x) => x.id === nb)?.en ?? '')} ▶</span></div>
                <input type="range" min={-1} max={1} step={0.1} value={shift} onChange={(e) => onShift(+e.target.value)} className="w-full" />
                <div className="flex justify-between text-[10px] text-muted"><button className="hover:text-white" onClick={() => onShift(-1)}>{L('ฝั่งไทยทั้งกรอบ', 'all Thai side')}</button><button className="hover:text-white" onClick={() => onShift(0)}>{L('คร่อมแนว', 'straddle')}</button><button className="hover:text-white" onClick={() => onShift(1)}>{L('ฝั่งเพื่อนบ้านทั้งกรอบ', 'all neighbour side')}</button></div>
                <p className="text-[10px] text-muted">{tileCount ? L(`${tileCount} กรอบตามแนว (ยังไม่บันทึก) — ครอบเส้นแบ่งเขตครบทุกช่วง · เลือกและเพิ่มเข้ารายการในแผง “+ ตามแนวชายแดน”`, `${tileCount} boxes along the line (not saved) — pick and add them in “+ Along border”`) : L('กำลังสร้างกรอบตามแนว…', 'Building boxes…')}</p>
              </div>
            </>
          )}
          {measured != null && (
            <p>{L('พื้นที่นอกประเทศไทยในกรอบภาพนี้ (วัดจริง)', 'Share of this view outside Thailand (measured)')}: <b className="font-mono">{Math.round(measured * 100)}%</b></p>
          )}
          <p className="text-[10px] leading-relaxed text-muted">
            {L(
              'ตัวเลขนี้คือสัดส่วนของภาพบนจอเท่านั้น ไม่ใช่ความแม่นยำหรือพื้นที่ที่ระบบตรวจแล้ว · แผนที่ไม่ถูกบิดหรือยืดเพื่อให้ได้สัดส่วน',
              'This is the share of the screen only — not accuracy or area checked · the map is never stretched to reach a share',
            )}
          </p>
          <div className="rounded border border-line p-1.5 text-[10px] leading-relaxed">
            {custom ? (
              <>
                <div className="text-ok">✓ {L('ใช้เส้นเขตแดนจากไฟล์ที่นำเข้าเป็นหลัก', 'Using the imported boundary file')}</div>
                <div className="text-slate-300">{custom.name} · {L('นำเข้า', 'imported')} {custom.importedAt.slice(0, 10)}</div>
                <div className="text-muted">{NEIGHBOURS.map((n) => `${L(n.th, n.en)} ${Math.round(custom.lengthKm[n.id] ?? 0).toLocaleString()} ${L('กม.', 'km')}`).join(' · ')}</div>
                <div className="text-muted">{L('เก็บไว้ในเบราว์เซอร์นี้เท่านั้น ไม่ได้อัปโหลดขึ้นเว็บ · ประเทศที่ไม่มีในไฟล์จะใช้ Natural Earth แทน', 'Kept in this browser only, never uploaded · neighbours missing from the file fall back to Natural Earth')}</div>
                <button className="mt-0.5 text-bad hover:underline" onClick={() => void clearBoundary().then(() => apply(mode))}>{L('เลิกใช้ไฟล์นี้ (กลับไปใช้ Natural Earth)', 'Stop using this file')}</button>
              </>
            ) : (
              <div className="text-muted">{L('เส้นเขตแดน: Natural Earth 1:50m (สาธารณสมบัติ) เป็นเส้นโดยประมาณ ไม่ใช่เส้นตามกฎหมาย/MOU และบางช่วงยังเป็นพื้นที่พิพาท', 'Boundary: Natural Earth 1:50m (public domain), approximate — not the legal/MOU line; some stretches are disputed')}</div>
            )}
            {srcOk === false && <div className="text-warn">{L('โหลดเส้นขอบประเทศไม่ได้ ใช้กรอบประเทศไทยสำรอง', 'outlines unavailable — fallback extent used')}</div>}
            <label className={cx('mt-1 inline-block cursor-pointer rounded border border-line px-2 py-0.5 hover:border-cyan-400/50', impBusy && 'opacity-50')}>
              {impBusy ? L('กำลังนำเข้า…', 'Importing…') : custom ? L('นำเข้าไฟล์ใหม่แทน', 'Replace file') : L('นำเข้าเส้นเขตแดน (GeoJSON)', 'Import boundary (GeoJSON)')}
              <input type="file" accept=".geojson,.json,application/geo+json,application/json" className="hidden" disabled={impBusy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void doImport(f); }} />
            </label>
            {impErr && <div className="text-bad">{impErr}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
