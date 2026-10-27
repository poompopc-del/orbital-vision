// Before/after viewing of two real scenes on a globe: swipe with a draggable handle, A only, B only,
// or blink (alternates A and B so changed spots flicker).
import { useEffect, useState, type PointerEvent as RPointerEvent, type RefObject } from 'react';
import { useLang } from '../../i18n';
import { Cesium } from '../../lib/cesium';
import { displayTemplate } from '../../lib/export';
import type { ImageryItem } from '../../lib/stac';
import { pcProvider } from '../gis/sceneLayer';
import { Button } from '../ui';

export default function SwipeView({ viewer, A, B, containerRef, onClose }: { viewer: Cesium.Viewer | null; A: ImageryItem; B: ImageryItem; containerRef: RefObject<HTMLElement>; onClose?: () => void }) {
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
      <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-md border border-line bg-ink-950/85 p-1 text-[11px] text-slate-200 backdrop-blur">
        <Button variant={show === 'split' && !blink ? 'active' : 'ghost'} onClick={() => { setBlink(false); setShow('split'); }}>{L('เลื่อนเทียบ', 'Swipe')}</Button>
        <Button variant={show === 'A' && !blink ? 'active' : 'ghost'} onClick={() => { setBlink(false); setShow('A'); }}>A {L('ก่อน', 'before')}</Button>
        <Button variant={show === 'B' && !blink ? 'active' : 'ghost'} onClick={() => { setBlink(false); setShow('B'); }}>B {L('หลัง', 'after')}</Button>
        <Button variant={blink ? 'active' : 'ghost'} onClick={() => { const on = !blink; setBlink(on); setShow(on ? 'A' : 'split'); }} title={L('สลับภาพ A/B อัตโนมัติ — สิ่งที่เปลี่ยนจะ “กะพริบ”', 'Alternate A/B automatically — changes flicker')}>⟳ {L('กะพริบ', 'Blink')}</Button>
        {onClose && <button className="px-2 text-cyan-300 hover:underline" onClick={onClose}>{L('ปิด', 'Close')}</button>}
      </div>
    </>
  );
}
