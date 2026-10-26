// Quality block shown with every surveillance result: the AOI split into change / no change /
// not checkable, each scene's cloud figures, the comparison quality score with its factors, and the
// classification confidence — kept apart so one is not mistaken for the other.
import { useLang } from '../../i18n';
import { fmtArea, type AreaUnit } from '../../lib/area';
import { confTh, type MonitorRun } from '../../lib/monitor';

const useL = () => {
  const lang = useLang((s) => s.lang);
  return (th: string, en: string) => (lang === 'th' ? th : en);
};
const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : 0);
const dt = (s?: string | null) => (s ? `${s.slice(0, 10)} ${s.slice(11, 16)}Z` : '—');

export const STATE_STYLE = {
  change: { color: '#ef4444', th: 'ตรวจพบการเปลี่ยนแปลง', en: 'Detected change' },
  none: { color: '#4fd18b', th: 'ไม่พบการเปลี่ยนแปลงเกินเกณฑ์', en: 'No significant change detected' },
  cloud: { color: '#e5e7eb', th: 'เมฆ', en: 'Cloud' },
  shadow: { color: '#7c5cd6', th: 'เงาเมฆ', en: 'Cloud shadow' },
  nodata: { color: '#6b7280', th: 'ไม่มีข้อมูล', en: 'No data' },
};
const hatch = (c: string) => `repeating-linear-gradient(45deg, ${c} 0 3px, transparent 3px 6px)`;

export default function ResultQuality({ run, unit }: { run: MonitorRun; unit: AreaUnit }) {
  const L = useL();
  const lang = useLang((s) => s.lang);
  const th = lang === 'th';
  const s = run.stats;
  if (!s) return null;
  const A = (km2: number) => fmtArea(km2, unit, th);
  const change = s.changeKm2 ?? s.interestKm2;
  const noChange = s.noChangeKm2 ?? Math.max(0, s.validKm2 - change);
  const cloud = s.cloudKm2, shadow = s.shadowKm2, miss = s.missingKm2 ?? (cloud == null ? s.noDataKm2 : undefined);
  const seg = [
    { k: 'change' as const, v: change, h: false },
    { k: 'none' as const, v: noChange, h: false },
    { k: 'cloud' as const, v: cloud ?? 0, h: true },
    { k: 'shadow' as const, v: shadow ?? 0, h: true },
    { k: 'nodata' as const, v: miss ?? 0, h: true },
  ];
  const q = run.quality;
  return (
    <div className="space-y-1.5 rounded border border-line bg-ink-950/40 p-2 text-[10px] text-slate-200">
      <div className="font-semibold text-cyan-300">{L('สถานะพื้นที่ใน AOI', 'AOI breakdown')}</div>
      <div className="flex h-3 w-full overflow-hidden rounded border border-white/10">
        {seg.map((x) => x.v > 0 && <div key={x.k} title={`${th ? STATE_STYLE[x.k].th : STATE_STYLE[x.k].en}: ${A(x.v)}`} style={{ width: `${pct(x.v, s.aoiKm2)}%`, background: x.h ? hatch(STATE_STYLE[x.k].color) : STATE_STYLE[x.k].color }} />)}
      </div>
      <table className="w-full">
        <tbody>
          <tr><td className="text-muted">{L('พื้นที่ AOI ทั้งหมด', 'Whole AOI')}</td><td className="text-right font-mono">{A(s.aoiKm2)}</td><td className="w-10 text-right font-mono">100%</td></tr>
          <tr><td className="text-muted">{L('มีข้อมูลใช้วิเคราะห์ได้', 'Analysable')}</td><td className="text-right font-mono">{A(s.validKm2)}</td><td className="text-right font-mono">{pct(s.validKm2, s.aoiKm2).toFixed(0)}%</td></tr>
          {seg.map((x) => (x.k !== 'cloud' && x.k !== 'shadow' && x.k !== 'nodata') || x.v > 0 || cloud != null ? (
            <tr key={x.k}>
              <td><i className="mr-1 inline-block h-2.5 w-2.5 align-middle" style={{ background: x.h ? hatch(STATE_STYLE[x.k].color) : STATE_STYLE[x.k].color, border: '1px solid rgba(255,255,255,.3)' }} />{th ? STATE_STYLE[x.k].th : STATE_STYLE[x.k].en}</td>
              <td className="text-right font-mono">{A(x.v)}</td>
              <td className="text-right font-mono">{pct(x.v, s.aoiKm2).toFixed(1)}%</td>
            </tr>
          ) : null)}
          {cloud == null && <tr><td className="text-muted">{L('เมฆ/เงาเมฆ/ไม่มีข้อมูล (รวม — ผลรุ่นเก่า)', 'Cloud/shadow/no data (combined, older run)')}</td><td className="text-right font-mono">{A(s.noDataKm2)}</td><td className="text-right font-mono">{pct(s.noDataKm2, s.aoiKm2).toFixed(1)}%</td></tr>}
        </tbody>
      </table>
      <p className="text-muted">{L('พื้นที่ที่มีเมฆหรือไม่มีข้อมูลไม่ถูกนับเป็นการเปลี่ยนแปลง และไม่ถูกสรุปว่า “ไม่เปลี่ยนแปลง” · แต่ละพิกเซลอยู่ได้สถานะเดียว จึงไม่นับซ้ำ', 'Cloud / no-data areas are neither counted as change nor as “no change” · each pixel has one state, so nothing is double-counted')}</p>

      <div className="pt-1 font-semibold text-cyan-300">{L('ภาพที่ใช้', 'Scenes used')}</div>
      <table className="w-full">
        <thead className="text-muted"><tr><td /><td>{L('ถ่ายภาพ', 'Acquired')}</td><td className="text-right">{L('เมฆรวม', 'Scene ☁')}</td><td className="text-right">{L('เมฆ/เงาใน AOI', 'AOI ☁/shadow')}</td></tr></thead>
        <tbody className="font-mono">
          {(['A', 'B'] as const).map((k) => {
            const m = run[k];
            if (!m) return null;
            return (
              <tr key={k}>
                <td className="font-sans">{k === 'A' ? L('ก่อน', 'Before') : L('หลัง', 'After')}</td>
                <td title={`${L('ประมวลผล', 'processed')} ${dt(m.processed)} · ${L('เข้าคลัง', 'catalogued')} ${dt(m.ingested)}`}>{dt(m.datetime)}</td>
                <td className="text-right">{m.cloud != null ? `${m.cloud.toFixed(1)}%` : '—'}</td>
                <td className="text-right">{m.aoiCloudPct != null ? `${m.aoiCloudPct.toFixed(1)}% / ${(m.aoiShadowPct ?? 0).toFixed(1)}%` : run.sensor === 'sar' ? L('เรดาร์', 'radar') : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-muted">{run.A?.label} · {run.A?.gsd}{run.B && run.B.collection !== run.A?.collection ? ` / ${run.B.label} · ${run.B.gsd}` : ''} · {L('วันที่คือวันถ่ายภาพจริง (ชี้ที่วันที่เพื่อดูวันประมวลผล/เข้าคลัง)', 'dates are acquisition times (hover for processing/catalogue dates)')}</p>

      {q && (
        <>
          <div className="flex items-center justify-between pt-1">
            <span className="font-semibold text-cyan-300">{L('คุณภาพการเปรียบเทียบ', 'Comparison quality')}</span>
            <span className={q.grade === 'good' ? 'text-ok' : q.grade === 'fair' ? 'text-warn' : 'text-bad'}><b className="font-mono">{q.score}</b>/100</span>
          </div>
          <table className="w-full">
            <tbody>
              {q.factors.map((f) => (
                <tr key={f.key}><td>{f.label}</td><td className="text-muted">{f.detail}</td><td className="text-right font-mono">{f.points}/{f.max}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="flex items-center justify-between pt-1">
        <span className="font-semibold text-cyan-300">{L('ความเชื่อมั่นของการจำแนก', 'Classification confidence')}</span>
        <span>{th ? confTh(run.confidence) : run.confidence ?? '—'}</span>
      </div>
      {!!run.confidenceNotes?.length && <ul className="list-disc pl-4 text-muted">{run.confidenceNotes.map((x) => <li key={x}>{x}</li>)}</ul>}
      {run.qc && <p className="text-muted">{L('เกณฑ์ที่ใช้', 'Thresholds')}: {L('เมฆใน AOI', 'AOI')} ≤ {run.qc.maxAoiCloud}% · {L('วิเคราะห์ได้', 'analysable')} ≥ {run.qc.minValidPct}% · ≤ {run.qc.maxGsdM} ม.{run.mode === 'manual' ? ` · ${L('เลือกภาพเอง', 'manual pick')}` : ''}</p>}
    </div>
  );
}
