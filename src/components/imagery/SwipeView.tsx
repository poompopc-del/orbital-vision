// Before/after viewing of two real scenes on a globe: swipe with a draggable handle, A only, B only,
// or blink (alternates A and B so changed spots flicker).
// When a change-detection result is on the map (layers change-result / change-outline / change-spots
// of the page's layer host), it is drawn OVER both images, with its own controls: on/off, fill or
// outline, opacity, numbered spots and ◀ ▶ to fly from spot to spot.
import { useEffect, useState, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from 'react';
import { useLang } from '../../i18n';
import { Cesium } from '../../lib/cesium';
import { displayTemplate, encodeGeoTiff, renderScene, safeName, saveBlob, savePng, summarySheet, withOverlay, type GeoCanvas } from '../../lib/export';
import type { ImageryItem } from '../../lib/stac';
import { pcProvider } from '../gis/sceneLayer';
import type { GisApi } from '../gis/GisContext';
import { Button, Spinner, cx } from '../ui';

/** which result layers of the host to draw over the images (default: the two-scene change result) */
export interface SwipeOverlay { result: string; outline?: string; spots?: string }
const CHANGE_IDS: SwipeOverlay = { result: 'change-result', outline: 'change-outline', spots: 'change-spots' };

export default function SwipeView({ viewer, A, B, containerRef, onClose, g, ids = CHANGE_IDS, focus, extra }: {
  viewer: Cesium.Viewer | null; A: ImageryItem; B: ImageryItem; containerRef: RefObject<HTMLElement>; onClose?: () => void; g?: GisApi | null;
  ids?: SwipeOverlay;
  /** fly here when it changes (e.g. the piece picked in a list) */
  focus?: { lon: number; lat: number; heightM?: number; key: string } | null;
  /** extra controls in the result bar (e.g. ◀ ▶ between trend pieces) */
  extra?: ReactNode;
}) {
  const lang = useLang((s) => s.lang);
  const L = (th: string, en: string) => (lang === 'th' ? th : en);
  const [split, setSplit] = useState(0.5);
  const [show, setShow] = useState<'split' | 'A' | 'B'>('split');
  const [blink, setBlink] = useState(false);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const la = viewer.imageryLayers.addImageryProvider(pcProvider(displayTemplate(A), A));
    const lb = viewer.imageryLayers.addImageryProvider(pcProvider(displayTemplate(B), B));
    la.splitDirection = Cesium.SplitDirection.LEFT;
    lb.splitDirection = Cesium.SplitDirection.RIGHT;
    viewer.scene.requestRender();
    return () => {
      if (!viewer.isDestroyed()) {
        viewer.imageryLayers.remove(la, true);
        viewer.imageryLayers.remove(lb, true);
        viewer.scene.splitPosition = 0.5;
      }
    };
  }, [viewer, A.id, B.id]);
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    viewer.scene.splitPosition = show === 'A' ? 1 : show === 'B' ? 0 : split;
    viewer.scene.requestRender();
  }, [viewer, split, show]);
  useEffect(() => {
    if (!blink) return;
    const t = setInterval(() => setShow((v) => (v === 'A' ? 'B' : 'A')), 900);
    return () => clearInterval(t);
  }, [blink]);

  // ---- change result over the images
  const res = g?.layers.find((l) => l.id === ids.result);
  const outl = ids.outline ? g?.layers.find((l) => l.id === ids.outline) : undefined;
  const spots = ids.spots ? g?.layers.find((l) => l.id === ids.spots) : undefined;
  const [resultOn, setResultOn] = useState(true);
  const [style, setStyle] = useState<'fill' | 'outline'>('fill');
  const [spotsOn, setSpotsOn] = useState(true);
  const [spotIdx, setSpotIdx] = useState(-1);
  // above A and B (they were just added on top), on both sides of the split
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    for (const l of [res?.layer, outl?.layer]) {
      if (!l || !viewer.imageryLayers.contains(l)) continue;
      viewer.imageryLayers.raiseToTop(l);
      l.splitDirection = Cesium.SplitDirection.NONE;
    }
    viewer.scene.requestRender();
  }, [viewer, A.id, B.id, res?.layer, outl?.layer]);
  useEffect(() => {
    if (!g) return;
    if (res) g.setLayer(ids.result, { show: resultOn && (style === 'fill' || !outl) });
    if (outl && ids.outline) g.setLayer(ids.outline, { show: resultOn && style === 'outline' });
    viewer?.scene.requestRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultOn, style, !!res, !!outl]);
  useEffect(() => {
    if (g && spots && ids.spots) g.setLayer(ids.spots, { show: spotsOn });
    viewer?.scene.requestRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotsOn, !!spots]);
  const spotList = spots?.dataSource?.entities.values ?? [];
  const spotInfo = (i: number) => {
    const e = spotList[i];
    const now = Cesium.JulianDate.now();
    const pos = e?.position?.getValue(now);
    const pr = e?.properties?.getValue(now) ?? {};
    return pos ? { pos, n: pr.n as number, lengthKm: pr.lengthKm as number | null, km2: pr.km2 as number } : null;
  };
  const goSpot = (i: number) => {
    if (!viewer || viewer.isDestroyed() || !spotList.length) return;
    const k = ((i % spotList.length) + spotList.length) % spotList.length;
    const s = spotInfo(k);
    if (!s) return;
    const c = Cesium.Cartographic.fromCartesian(s.pos);
    // frame the whole line (or ~1.5 km around a patch)
    const h = Math.max(1500, (s.lengthKm ?? 0.6) * 1600);
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, h), duration: 0.9 });
    setSpotIdx(k);
    if (!spotsOn) setSpotsOn(true);
  };
  useEffect(() => {
    if (!focus || !viewer || viewer.isDestroyed()) return;
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(focus.lon, focus.lat, focus.heightM ?? 1500), duration: 0.9 });
  }, [viewer, focus?.key]);
  // ---- download the two images (what is on screen), optionally with the highlight burnt in
  const [dlOpen, setDlOpen] = useState(false);
  const [dlFmt, setDlFmt] = useState<'png' | 'tif'>('png');
  const [dlMark, setDlMark] = useState(true);
  const [dlBusy, setDlBusy] = useState('');
  const viewBox = (): GeoJSON.Polygon | null => {
    if (!viewer || viewer.isDestroyed()) return null;
    const r = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
    if (!r) return null;
    const d = (v: number) => Cesium.Math.toDegrees(v);
    const [w, so, e, n] = [d(r.west), d(r.south), d(r.east), d(r.north)];
    if (!(e > w && n > so) || e - w > 2 || n - so > 2) return null; // whole globe in view: zoom in first
    return { type: 'Polygon', coordinates: [[[w, so], [e, so], [e, n], [w, n], [w, so]]] };
  };
  const overlayOf = () => {
    const ent = style === 'outline' && outl ? outl : res;
    const prov = ent?.layer?.imageryProvider as (Cesium.SingleTileImageryProvider & { url?: string }) | undefined;
    if (!prov?.url || !prov.rectangle) return null;
    const r = prov.rectangle, d = Cesium.Math.toDegrees;
    return { url: prov.url, b: { west: d(r.west), south: d(r.south), east: d(r.east), north: d(r.north) } };
  };
  const download = async (which: 'A' | 'B' | 'AB') => {
    const box = viewBox();
    if (!box) { setDlBusy(L('ซูมเข้าให้เห็นพื้นที่ก่อน (มุมมองกว้างเกิน)', 'Zoom in to the area first (view too wide)')); setTimeout(() => setDlBusy(''), 2500); return; }
    const ov = dlMark && res ? overlayOf() : null;
    const one = async (it: ImageryItem, k: string): Promise<GeoCanvas> => {
      const img = await renderScene(it, box, { onProgress: (a, n) => setDlBusy(`${L('ภาพ', 'Image')} ${k} ${a}/${n}`) });
      return ov ? withOverlay(img, ov.url, ov.b) : img;
    };
    const name = (it: ImageryItem, k: string) => `${k}_${it.datetime.slice(0, 10)}_${safeName(String(it.collection))}${ov ? '_highlight' : ''}`;
    try {
      if (which === 'AB') {
        const [ia, ib] = [await one(A, 'A'), await one(B, 'B')];
        setDlBusy(L('รวมเป็นแผ่นเดียว…', 'Making the sheet…'));
        const c = box.coordinates[0];
        const sheet = await summarySheet(
          `${L('เทียบ', 'Compare')} ${A.datetime.slice(0, 10)} → ${B.datetime.slice(0, 10)}`,
          [{ img: ia, caption: `A · ${L('ก่อน', 'before')} · ${A.datetime.slice(0, 10)}` }, { img: ib, caption: `B · ${L('หลัง', 'after')} · ${B.datetime.slice(0, 10)}` }],
          [],
          [`${c[0][1].toFixed(5)}, ${c[0][0].toFixed(5)} → ${c[2][1].toFixed(5)}, ${c[2][0].toFixed(5)} (WGS84)`, `${A.collectionLabel ?? A.collection} · ${B.collectionLabel ?? B.collection}${ov ? ` · ${L('ไฮไลต์ = ส่วนที่ตรวจพบการเปลี่ยนแปลง', 'highlight = detected change')}` : ''}`],
        );
        saveBlob(sheet, `compare_${A.datetime.slice(0, 10)}_${B.datetime.slice(0, 10)}${ov ? '_highlight' : ''}.png`);
      } else {
        const it = which === 'A' ? A : B;
        const g2 = await one(it, which);
        if (dlFmt === 'tif') saveBlob(encodeGeoTiff(g2), `${name(it, which)}.tif`);
        else await savePng(g2, `${name(it, which)}.png`);
      }
      setDlBusy('');
    } catch (e: any) {
      setDlBusy(`${L('ดาวน์โหลดไม่สำเร็จ', 'Download failed')}: ${e?.message ?? e}`);
      setTimeout(() => setDlBusy(''), 4000);
    }
  };

  const cur = spotIdx >= 0 && spotIdx < spotList.length ? spotInfo(spotIdx) : null;

  const drag = (e: RPointerEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setShow('split');
    setBlink(false);
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      setSplit(Math.min(0.995, Math.max(0.005, (ev.clientX - r.left) / r.width)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const shadow = 'pointer-events-none absolute z-10 font-mono text-[11px] font-semibold text-white [text-shadow:0_0_4px_#000,0_0_2px_#000]';
  return (
    <>
      {show === 'split' && (
        <>
          <div className="pointer-events-none absolute inset-y-0 z-10 w-px bg-white/90 shadow-[0_0_3px_rgba(0,0,0,.8)]" style={{ left: `${split * 100}%` }} />
          <div
            onPointerDown={drag}
            className="absolute top-1/2 z-20 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none select-none items-center justify-center rounded-full border-2 border-white bg-ink-950/70 text-[11px] font-bold text-white shadow-lg"
            style={{ left: `${split * 100}%` }}
            title={L('ลากเพื่อเลื่อนเทียบ', 'Drag to compare')}
          >
            ◀▶
          </div>
          <div className={`${shadow} top-14 -translate-x-full pr-2`} style={{ left: `${split * 100}%` }}>A {A.datetime.slice(0, 10)}</div>
          <div className={`${shadow} top-14 pl-2`} style={{ left: `${split * 100}%` }}>B {B.datetime.slice(0, 10)}</div>
        </>
      )}
      {show !== 'split' && (
        <div className="pointer-events-none absolute left-1/2 top-14 z-10 -translate-x-1/2 rounded bg-ink-950/70 px-2 py-0.5 font-mono text-sm font-semibold text-white">
          {show === 'A' ? `A · ${L('ก่อน', 'before')} · ${A.datetime.slice(0, 10)}` : `B · ${L('หลัง', 'after')} · ${B.datetime.slice(0, 10)}`}
        </div>
      )}
      {(res || spots || extra) && (
        <div className="absolute bottom-14 left-1/2 z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-md border border-line bg-ink-950/85 px-2 py-1 text-[11px] text-slate-200">
          {res && (
            <>
              <label className="flex items-center gap-1" title={L('ผลตรวจจับการเปลี่ยนแปลง ซ้อนบนทั้งภาพ A และ B', 'Change result, drawn over both A and B')}>
                <input type="checkbox" checked={resultOn} onChange={(e) => setResultOn(e.target.checked)} />
                {L('ผลตรวจจับ', 'Change result')}
              </label>
              {outl && (
                <span className={cx('flex overflow-hidden rounded border border-line', !resultOn && 'opacity-40')}>
                  {(['fill', 'outline'] as const).map((k) => (
                    <button key={k} disabled={!resultOn} onClick={() => setStyle(k)} className={cx('px-1.5 py-0.5', style === k ? 'bg-cyan-400/20 text-white' : 'text-muted hover:text-white')}>
                      {k === 'fill' ? L('เติมสี', 'Fill') : L('เส้นขอบ', 'Outline')}
                    </button>
                  ))}
                </span>
              )}
              {/* always laid out (hidden when not used) so the bar does not jump when switching fill / outline */}
              <label className={cx('flex items-center gap-1 text-[10px] text-muted', !(style === 'fill' && resultOn) && 'invisible')}>
                {L('ทึบ', 'Opacity')}
                <input type="range" min={0.15} max={1} step={0.05} value={res.alpha} onChange={(e) => g?.setLayer(ids.result, { alpha: +e.target.value })} className="h-1 w-16" />
              </label>
            </>
          )}
          {spots && spotList.length > 0 && (
            <>
              {res && <span className="h-4 w-px bg-line" />}
              <label className="flex items-center gap-1"><input type="checkbox" checked={spotsOn} onChange={(e) => setSpotsOn(e.target.checked)} />{L('หมายเลขจุด', 'Spot numbers')}</label>
              <span className="flex items-center gap-1 whitespace-nowrap">
              <button className="rounded border border-line px-1.5 hover:border-cyan-400/60" onClick={() => goSpot(spotIdx - 1)} title={L('จุดก่อนหน้า', 'Previous spot')}>◀</button>
              <span className="min-w-[7rem] text-center font-mono text-[10px]">
                {cur
                  ? `${L('จุด', 'spot')} ${cur.n}/${spotList.length}${cur.lengthKm != null ? ` · ${L('แนว', 'line')} ${cur.lengthKm.toFixed(2)} ${L('กม.', 'km')}` : ` · ${(cur.km2 * 625).toFixed(1)} ${L('ไร่', 'rai')}`}`
                  : L(`${spotList.length} จุด · กด ▶ เพื่อไล่ดู`, `${spotList.length} spots · ▶ to step`)}
              </span>
              <button className="rounded border border-line px-1.5 hover:border-cyan-400/60" onClick={() => goSpot(spotIdx + 1)} title={L('จุดถัดไป', 'Next spot')}>▶</button>
              </span>
            </>
          )}
          {extra && <>{(res || spots) && <span className="h-4 w-px bg-line" />}{extra}</>}
        </div>
      )}
      <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-md border border-line bg-ink-950/85 p-1 text-[11px] text-slate-200">
        <Button variant={show === 'split' && !blink ? 'active' : 'ghost'} onClick={() => { setBlink(false); setShow('split'); }}>{L('เลื่อนเทียบ', 'Swipe')}</Button>
        <Button variant={show === 'A' && !blink ? 'active' : 'ghost'} onClick={() => { setBlink(false); setShow('A'); }}>A {L('ก่อน', 'before')}</Button>
        <Button variant={show === 'B' && !blink ? 'active' : 'ghost'} onClick={() => { setBlink(false); setShow('B'); }}>B {L('หลัง', 'after')}</Button>
        <Button variant={blink ? 'active' : 'ghost'} onClick={() => { const on = !blink; setBlink(on); setShow(on ? 'A' : 'split'); }} title={L('สลับภาพ A/B อัตโนมัติ ให้จุดที่เปลี่ยน “กะพริบ” เห็นชัด', 'Alternate A/B automatically so changes flicker')}>⟳ {L('กะพริบ', 'Blink')}</Button>
        <span className="relative">
          <Button variant={dlOpen ? 'active' : 'ghost'} onClick={() => setDlOpen(!dlOpen)} title={L('ดาวน์โหลดภาพ A / B ตามที่เห็นบนจอ', 'Download images A / B as seen on screen')}>⬇ {L('ดาวน์โหลด', 'Download')}</Button>
          {dlOpen && (
            <div className="absolute bottom-full right-0 mb-1 w-64 space-y-1.5 rounded-md border border-line bg-ink-950/95 p-2 text-[11px]">
              <div className="text-[10px] text-muted">{L('ตัดตามพื้นที่ที่เห็นบนจอตอนนี้ (ซูม/เลื่อนก่อนกด)', 'Cut to what is on screen now (zoom / pan first)')}</div>
              <div className="flex items-center gap-2">
                <span className="flex overflow-hidden rounded border border-line">
                  {(['png', 'tif'] as const).map((f) => (
                    <button key={f} onClick={() => setDlFmt(f)} className={cx('px-1.5 py-0.5', dlFmt === f ? 'bg-cyan-400/20 text-white' : 'text-muted hover:text-white')}>{f === 'png' ? 'PNG' : 'GeoTIFF'}</button>
                  ))}
                </span>
                {res && <label className="flex items-center gap-1"><input type="checkbox" checked={dlMark} onChange={(e) => setDlMark(e.target.checked)} />{L('ใส่ไฮไลต์', 'With highlight')}</label>}
              </div>
              <div className="flex flex-wrap gap-1">
                <Button disabled={!!dlBusy} onClick={() => void download('A')}>A {A.datetime.slice(0, 10)}</Button>
                <Button disabled={!!dlBusy} onClick={() => void download('B')}>B {B.datetime.slice(0, 10)}</Button>
                <Button disabled={!!dlBusy} onClick={() => void download('AB')} title={L('ภาพ A และ B วางคู่กันในไฟล์ PNG เดียว พร้อมวันที่และพิกัด', 'A and B side by side in one PNG, with dates and coordinates')}>A | B {L('คู่กัน', 'side by side')}</Button>
              </div>
              {dlBusy && <div className="flex items-center gap-1.5 text-cyan-300">{!dlBusy.startsWith(L('ดาวน์โหลดไม่', 'Download f')) && !dlBusy.startsWith(L('ซูม', 'Zoom')) && <Spinner />}{dlBusy}</div>}
              {res && dlMark && <div className="text-[9px] text-muted">{L(`ไฮไลต์แบบ${style === 'outline' && outl ? 'เส้นขอบ' : 'เติมสี'}ตามที่เลือกบนแถบ`, `${style === 'outline' && outl ? 'Outline' : 'Fill'} highlight, as chosen on the bar`)}</div>}
            </div>
          )}
        </span>
        {onClose && <button className="px-2 text-cyan-300 hover:underline" onClick={onClose}>{L('ปิด', 'Close')}</button>}
      </div>
    </>
  );
}
