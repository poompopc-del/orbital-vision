// Labelling detected changes: a chip per result row (shows an earlier label at that place, or 🏷),
// an editor to choose what the spot is, and a panel with the label database (counts, export, map).
import { useContext, useEffect, useRef, useState } from 'react';
import { useLang } from '../../i18n';
import { Cesium } from '../../lib/cesium';
import { cachedLabels, deleteLabel, kindOf, LABEL_KINDS, labelsCsv, labelsGeoJson, labelsNear, labelStore, loadLabels, onLabels, saveLabel, type ChangeLabel, type LabelKind } from '../../lib/labels';
import { GisCtx } from '../gis/GisContext';
import { Button, cx } from '../ui';

const useL = () => {
  const lang = useLang((s) => s.lang);
  return (th: string, en: string) => (lang === 'th' ? th : en);
};

export function useLabels() {
  const [labels, setLabels] = useState<ChangeLabel[]>(cachedLabels());
  useEffect(() => {
    void loadLabels().then((r) => setLabels(r.labels));
    return onLabels(() => setLabels(cachedLabels()));
  }, []);
  return labels;
}

/** What is being labelled: one detection with its context. */
export type LabelTarget = Omit<ChangeLabel, 'id' | 'createdAt' | 'label' | 'note' | 'where'> & { ref: string };

export function LabelChip({ t, labels, onOpen, active }: { t: LabelTarget; labels: ChangeLabel[]; onOpen: () => void; active?: boolean }) {
  const L = useL();
  const near = labelsNear(t.lon, t.lat, labels)[0];
  if (near) {
    const k = kindOf(near.label);
    return (
      <button onClick={onOpen} className={cx('whitespace-nowrap rounded px-1 font-sans text-[9px]', active && 'ring-1 ring-cyan-400')} style={{ background: `${k.color}33`, color: k.color }} title={L(`ติดป้ายไว้แล้ว${near.distM > 5 ? ` (ห่าง ${Math.round(near.distM)} ม.)` : ''} · คลิกเพื่อแก้`, `Labelled${near.distM > 5 ? ` (${Math.round(near.distM)} m away)` : ''} · click to change`)}>
        {L(k.th, k.en)}
      </button>
    );
  }
  return (
    <button onClick={onOpen} className={cx('rounded border border-line px-1 font-sans text-[9px] text-muted hover:border-cyan-400/60 hover:text-white', active && 'border-cyan-400 text-white')} title={L('ติดป้ายว่าจุดนี้คืออะไร', 'Label what this spot is')}>
      🏷
    </button>
  );
}

export function LabelEditor({ t, labels, onDone }: { t: LabelTarget; labels: ChangeLabel[]; onDone: () => void }) {
  const L = useL();
  const prev = labelsNear(t.lon, t.lat, labels, 15)[0];
  const [kind, setKind] = useState<LabelKind | null>(prev?.label ?? null);
  const [note, setNote] = useState(prev?.note ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!kind) return;
    setBusy(true);
    const { ref: _r, ...rest } = t;
    await saveLabel({ ...rest, id: prev?.id, label: kind, note: note.trim() || undefined });
    setBusy(false);
    onDone();
  };
  return (
    <div className="space-y-1.5 rounded border border-cyan-400/50 bg-cyan-400/5 p-1.5 text-[10px]">
      <div className="font-semibold text-white">{L('จุดนี้คืออะไร?', 'What is this spot?')} <span className="font-mono font-normal text-muted">{t.lat.toFixed(5)}, {t.lon.toFixed(5)}</span></div>
      <div className="flex flex-wrap gap-1">
        {LABEL_KINDS.map((k) => (
          <button key={k.id} onClick={() => setKind(k.id)} className={cx('rounded border px-1.5 py-0.5', kind === k.id ? 'text-white' : 'border-line text-slate-300 hover:text-white')} style={kind === k.id ? { borderColor: k.color, background: `${k.color}33` } : undefined}>
            {L(k.th, k.en)}
          </button>
        ))}
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={L('หมายเหตุ (ไม่บังคับ) เช่น เห็นรถแทรกเตอร์ในภาพละเอียดสูง', 'Note (optional)')} className="w-full rounded border border-line bg-ink-950 px-1.5 py-0.5 text-[10px]" />
      <div className="flex items-center gap-1">
        <Button variant="primary" disabled={!kind || busy} onClick={() => void save()} className="!py-0.5 text-[10px]">{L('บันทึกป้าย', 'Save label')}</Button>
        {prev && <Button disabled={busy} onClick={() => void deleteLabel(prev.id).then(onDone)} className="!py-0.5 text-[10px]">{L('ลบป้าย', 'Remove')}</Button>}
        <Button disabled={busy} onClick={onDone} className="!py-0.5 text-[10px]">{L('ยกเลิก', 'Cancel')}</Button>
        <span className="ml-auto text-[9px] text-muted">{labelStore() === 'on' ? L('เก็บในฐานข้อมูล (Supabase)', 'Saved to the database (Supabase)') : L('เก็บในเบราว์เซอร์นี้ · ล็อกอินเพื่อเก็บในฐานข้อมูล', 'Saved in this browser · sign in to save to the database')}</span>
      </div>
    </div>
  );
}

const download = (name: string, text: string, type: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/** The label database: counts by kind, export, show on the map. */
export function LabelsPanel() {
  const L = useL();
  const gNow = useContext(GisCtx);
  const gRef = useRef(gNow);
  gRef.current = gNow;
  const hasG = !!gNow;
  const labels = useLabels();
  const [onMap, setOnMap] = useState(false);
  useEffect(() => {
    const g = gRef.current;
    if (!g) return;
    if (!onMap || !labels.length) { g.removeLayer('labels'); return; }
    const ds = new Cesium.CustomDataSource('labels');
    for (const l of labels) {
      const k = kindOf(l.label);
      ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(l.lon, l.lat),
        point: { pixelSize: 8, color: Cesium.Color.fromCssColorString(k.color), outlineColor: Cesium.Color.BLACK, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: L(k.th, k.en), font: '11px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(9, 0), horizontalOrigin: Cesium.HorizontalOrigin.LEFT, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 60_000), disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
    }
    g.putDataSource('labels', L('ป้ายกำกับที่ติดไว้', 'Labels'), ds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasG, onMap, labels]);
  const counts = LABEL_KINDS.map((k) => ({ ...k, n: labels.filter((l) => l.label === k.id).length })).filter((k) => k.n);
  const stamp = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-1 text-[11px]">
      <div className="text-[10px] text-muted">
        {L(`ติดป้ายไว้ ${labels.length} จุด`, `${labels.length} labelled spots`)} · {labelStore() === 'on' ? L('ในฐานข้อมูล (Supabase)', 'in the database (Supabase)') : L('ในเบราว์เซอร์นี้ (ล็อกอินเพื่อเก็บในฐานข้อมูล)', 'in this browser (sign in to use the database)')}
      </div>
      {counts.length > 0 && (
        <div className="flex flex-wrap gap-x-2 text-[10px]">
          {counts.map((k) => <span key={k.id} className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full" style={{ background: k.color }} />{L(k.th, k.en)} {k.n}</span>)}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        <Button disabled={!labels.length} onClick={() => setOnMap(!onMap)} variant={onMap ? 'active' : 'ghost'}>{onMap ? L('ซ่อนบนแผนที่', 'Hide on map') : L('แสดงบนแผนที่', 'Show on map')}</Button>
        <Button disabled={!labels.length} onClick={() => download(`labels-${stamp}.geojson`, JSON.stringify(labelsGeoJson(labels), null, 1), 'application/geo+json')}>GeoJSON</Button>
        <Button disabled={!labels.length} onClick={() => download(`labels-${stamp}.csv`, labelsCsv(labels), 'text/csv')}>CSV</Button>
      </div>
      <p className="text-[9px] text-muted">{L('ติดป้ายได้จากตารางจุดในผล “ตรวจจับการเปลี่ยนแปลง” และ “แนวโน้มหลายภาพ” (ปุ่ม 🏷) · ป้ายเหล่านี้คือข้อมูลฝึกโมเดลในอนาคต', 'Label spots from the tables of “Change detection” and “Multi-scene trend” (🏷) · these are the training data for a later model')}</p>
    </div>
  );
}
