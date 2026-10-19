import { useEffect, useRef } from 'react';
import { createViewer, type ViewerOptions, Cesium } from '../lib/cesium';

/** Mounts a Cesium viewer and hands it to the parent. Destroys it on unmount. */
export default function GlobeHost({ onReady, options, className }: { onReady: (v: Cesium.Viewer | null) => void; options?: ViewerOptions; className?: string }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const v = createViewer(el.current, options);
    onReady(v);
    return () => {
      onReady(null);
      if (!v.isDestroyed()) v.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={el} className={className ?? 'absolute inset-0'} />;
}
