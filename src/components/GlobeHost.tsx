import { useEffect, useRef, useState } from 'react';
import { createViewer, type ViewerOptions, Cesium } from '../lib/cesium';
import CoordPopup from './CoordPopup';

/** Mounts a Cesium viewer and hands it to the parent. Destroys it on unmount.
 *  Right-clicking the map shows that spot's coordinates. */
export default function GlobeHost({ onReady, options, className }: { onReady: (v: Cesium.Viewer | null) => void; options?: ViewerOptions; className?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  useEffect(() => {
    if (!el.current) return;
    const v = createViewer(el.current, options);
    setViewer(v);
    onReady(v);
    return () => {
      setViewer(null);
      onReady(null);
      if (!v.isDestroyed()) v.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={className ?? 'absolute inset-0'}>
      <div ref={el} className="absolute inset-0" />
      <CoordPopup viewer={viewer} />
    </div>
  );
}
