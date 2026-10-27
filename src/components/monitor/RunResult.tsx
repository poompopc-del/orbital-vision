// One change-detection result: level, narrative, quality, before/after thumbnails with the result
// overlay, class areas and the largest patches.
import { useEffect, useState } from 'react';
import { useLang } from '../../i18n';
import { confTh, getImage, hotspotKm2, levelTh, narrative, type MonitorRun } from '../../lib/monitor';
import { fmtArea, km2ToRai } from '../../lib/area';
import { useQc } from '../../lib/qcStore';
import { Badge, Notice } from '../ui';
import ResultQuality from './ResultQuality';

export function OverlayOnImage({ src, img, ov }: { src: string; img: { west: number; south: number; east: number; north: number }; ov: { west: number; south: number; east: number; north: number } }) {
  const w = img.east - img.west, h = img.north - img.south;
  return (
    <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
      <image href={src} x={ov.west - img.west} y={img.north - ov.north} width={ov.east - ov.west} height={ov.north - ov.south} preserveAspectRatio="none" />
    </svg>
  );
}

export default function RunResult({ run }: { run: MonitorRun }) {
  const lang = useLang((s) => s.lang);
  const th = lang === 'th';
  const L = (a: string, b: string) => (th ? a : b);
  const { unit } = useQc();
  const [img, setImg] = useState<{ before: string | null; after: string | null; change: string | null }>({ before: null, after: null, change: null });
  const [showChange, setShowChange] = useState(true);
  useEffect(() => {
    if (run.status !== 'ok') return setImg({ before: null, after: null, change: null });
    let dead = false;
    void Promise.all([getImage(`${run.id}:before`), getImage(`${run.id}:after`), getImage(`${run.id}:change`)]).then(([before, after, change]) => !dead && setImg({ before, after, change }));
    return () => {
      dead = true;
    };
  }, [run.id]);

  if (run.status !== 'ok' || !run.stats)
    return (
      <Notice tone="warn">
        <b>{run.status === 'error' ? L('เกิดข้อผิดพลาด', 'Error') : L('ข้อมูลไม่เพียงพอ — ไม่สรุปผลการเปลี่ยนแปลง', 'Insufficient data — no change conclusion')}</b> — {run.reason}
        <div className="mt-1 text-[10px]">{L('ไม่ได้แปลว่า “ไม่มีการเปลี่ยนแปลง” · เลือกภาพวันอื่น (จุดสีเขียว) หรือใช้เรดาร์', 'This does not mean “no change” · pick another date (green dots) or radar.')}</div>
      </Notice>
    );

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        <Badge tone={run.level === 'significant' ? 'bad' : run.level === 'minor' ? 'warn' : 'ok'}>{th ? levelTh(run.level) : run.level}</Badge>
        <Badge tone="cyan">{L('ความเชื่อมั่น', 'confidence')} {th ? confTh(run.confidence) : run.confidence}</Badge>
        <Badge>{run.B?.label ?? (run.sensor === 'sar' ? 'Sentinel-1' : 'Sentinel-2')}</Badge>
      </div>
      <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-slate-200">{narrative(run, lang, unit).map((x) => <li key={x}>{x}</li>)}</ul>
      {run.note && <p className="text-[10px] text-warn">{run.note}</p>}
      <div className="grid grid-cols-2 gap-1.5">
        <figure>
          <div className="relative aspect-square overflow-hidden rounded border border-line bg-black">{img.before && <img src={img.before} className="h-full w-full object-contain" alt="" />}</div>
          <figcaption className="mt-0.5 text-[10px] text-muted">{L('ก่อน', 'Before')} · {run.A?.datetime.slice(0, 10)}</figcaption>
        </figure>
        <figure>
          <div className="relative aspect-square overflow-hidden rounded border border-line bg-black">
            {img.after && <img src={img.after} className="absolute inset-0 h-full w-full object-contain" alt="" />}
            {showChange && img.change && run.bounds && run.overlayBounds && <OverlayOnImage src={img.change} img={run.bounds} ov={run.overlayBounds} />}
          </div>
          <figcaption className="mt-0.5 flex items-center justify-between text-[10px] text-muted">
            <span>{L('หลัง', 'After')} · {run.B?.datetime.slice(0, 10)}</span>
            <label className="flex items-center gap-1"><input type="checkbox" checked={showChange} onChange={(e) => setShowChange(e.target.checked)} />{L('ผล', 'result')}</label>
          </figcaption>
        </figure>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-300">
        {run.legend?.map((l) => <span key={l.id} className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: l.color }} />{L(l.labelTh, l.label)} {fmtArea(run.stats!.classKm2[l.id] ?? 0, unit, th)}</span>)}
      </div>
      {!!run.hotspots?.length && (
        <div className="max-h-40 overflow-y-auto rounded border border-line scroll-thin">
          <table className="w-full text-[10px]">
            <thead className="text-muted"><tr><th className="px-1 text-left">#</th><th className="text-left">lat, lon</th><th className="pr-1 text-right">{L('ตร.กม.', 'km²')}</th><th className="pr-1 text-right">{L('ไร่', 'rai')}</th></tr></thead>
            <tbody className="font-mono text-slate-200">
              {run.hotspots.slice(0, 20).map((h) => (
                <tr key={h.n} className="border-t border-white/5"><td className="px-1">{h.n}</td><td>{h.lat.toFixed(5)}, {h.lon.toFixed(5)}</td><td className="pr-1 text-right">{hotspotKm2(h).toFixed(4)}</td><td className="pr-1 text-right">{km2ToRai(hotspotKm2(h)).toFixed(2)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details className="text-[10px] text-muted">
        <summary className="cursor-pointer hover:text-white">{L('วิธีวิเคราะห์และคุณภาพผล', 'Method and quality')}</summary>
        <p className="mt-1">{run.method}</p>
        <ResultQuality run={run} unit={unit} />
      </details>
    </div>
  );
}
