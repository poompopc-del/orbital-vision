// Label kinds and pure helpers on labels (no storage) — used by labels.ts, tested in tests/labels.test.ts.
export type LabelKind = 'track' | 'clearing' | 'farm' | 'structure' | 'fire' | 'water' | 'seasonal' | 'false_alarm' | 'other';
export const LABEL_KINDS: { id: LabelKind; th: string; en: string; color: string }[] = [
  { id: 'track', th: 'ทาง/ถนนใหม่', en: 'New track / road', color: '#f43f5e' },
  { id: 'clearing', th: 'ถางป่า', en: 'Clearing', color: '#ef4444' },
  { id: 'farm', th: 'ขยายไร่/นา', en: 'Farm expansion', color: '#f59e0b' },
  { id: 'structure', th: 'สิ่งปลูกสร้าง', en: 'Structure', color: '#a855f7' },
  { id: 'fire', th: 'ไฟไหม้', en: 'Burn', color: '#fb923c' },
  { id: 'water', th: 'น้ำ', en: 'Water', color: '#38bdf8' },
  { id: 'seasonal', th: 'ตามฤดูกาล', en: 'Seasonal', color: '#84cc16' },
  { id: 'false_alarm', th: 'แจ้งผิด', en: 'False alarm', color: '#94a3b8' },
  { id: 'other', th: 'อื่นๆ', en: 'Other', color: '#e2e8f0' },
];
export const kindOf = (k: string) => LABEL_KINDS.find((x) => x.id === k) ?? LABEL_KINDS[LABEL_KINDS.length - 1];

export interface ChangeLabel {
  id: string;
  createdAt: string;
  label: LabelKind;
  note?: string;
  lon: number;
  lat: number;
  areaKm2?: number | null;
  lengthKm?: number | null;
  source: 'change' | 'trend' | 'watch';
  purpose?: string;
  aoiName?: string;
  aScene?: string;
  bScene?: string;
  aDatetime?: string;
  bDatetime?: string;
  features?: Record<string, unknown>;
  /** where it is stored */
  where?: 'cloud' | 'local';
}

const KM_LAT = 110.574;
/** Labels within `m` metres of a point, nearest first. Pure. */
export function labelsNear(lon: number, lat: number, labels: ChangeLabel[], m = 60): (ChangeLabel & { distM: number })[] {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  return labels
    .map((l) => ({ ...l, distM: Math.hypot((l.lon - lon) * kx, (l.lat - lat) * KM_LAT) * 1000 }))
    .filter((l) => l.distM <= m)
    .sort((a, b) => a.distM - b.distM);
}

/** GeoJSON FeatureCollection of the labels (points), for export / training. Pure. */
export function labelsGeoJson(labels: ChangeLabel[]) {
  return {
    type: 'FeatureCollection',
    features: labels.map((l) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
      properties: { id: l.id, label: l.label, note: l.note ?? null, created_at: l.createdAt, area_km2: l.areaKm2 ?? null, length_km: l.lengthKm ?? null, source: l.source, purpose: l.purpose ?? null, aoi_name: l.aoiName ?? null, a_scene: l.aScene ?? null, b_scene: l.bScene ?? null, a_datetime: l.aDatetime ?? null, b_datetime: l.bDatetime ?? null, ...(l.features ?? {}) },
    })),
  };
}
const q = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** CSV of the labels, one row each, features flattened as JSON. Pure. */
export function labelsCsv(labels: ChangeLabel[]) {
  const cols = ['id', 'created_at', 'label', 'note', 'lat', 'lon', 'area_km2', 'length_km', 'source', 'purpose', 'aoi_name', 'a_datetime', 'b_datetime', 'a_scene', 'b_scene', 'features'];
  const rows = labels.map((l) => [l.id, l.createdAt, l.label, l.note, l.lat, l.lon, l.areaKm2, l.lengthKm, l.source, l.purpose, l.aoiName, l.aDatetime, l.bDatetime, l.aScene, l.bScene, JSON.stringify(l.features ?? {})].map(q).join(','));
  return [cols.join(','), ...rows].join('\n');
}
