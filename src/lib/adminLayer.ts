// Thai district (อำเภอ) and subdistrict (ตำบล) outlines for the whole country, drawn as optional
// layers on the watch map. Source: RTSD administrative boundaries 2022 (tha_admbnda_adm2/adm3_rtsd_20220121,
// as published on OCHA/HDX), simplified (~25–35 m) and split per province →
// public/admin/{amphoe,tambon}/<province pcode>.json plus public/admin/provinces.json (index with bboxes),
// so the map loads only the provinces in view. Administrative lines only — not the international boundary.
import { create } from 'zustand';

export type AdminLevel = 'amphoe' | 'tambon';

export interface AdminProps {
  name_th: string;
  name_en: string;
  pcode: string;
  province_th: string;
  province_en: string;
  amphoe_th?: string;
  amphoe_en?: string;
  /** a point inside the polygon, for the name label */
  lp: [number, number];
}
export type AdminCollection = GeoJSON.FeatureCollection<GeoJSON.MultiPolygon, AdminProps>;

/** Fixed per-level behaviour; colour and width are user settings (AdminLayerPrefs). */
export const ADMIN_STYLE: Record<AdminLevel, { dashed: boolean; labelMaxM: number; basePx: number; maxSpanDeg: number }> = {
  // districts: solid line, names when the camera is below ~600 km
  amphoe: { dashed: false, labelMaxM: 6e5, basePx: 15, maxSpanDeg: 99 }, // any zoom (whole country ≈ 9 MB)
  // subdistricts: dashed line, names only when zoomed in (below ~70 km)
  tambon: { dashed: true, labelMaxM: 7e4, basePx: 13, maxSpanDeg: 3 }, // only when the view is under ~330 km
};
export const ADMIN_SWATCHES = ['#fb923c', '#facc15', '#ef4444', '#ffffff', '#22d3ee', '#7dd3fc', '#f472b6', '#4ade80', '#a78bfa', '#000000'];
export type LabelSize = 's' | 'm' | 'l';
export const LABEL_SCALE: Record<LabelSize, number> = { s: 0.85, m: 1, l: 1.3 };

/** Cesium font string for a level's names at the chosen size (bold Thai font, readable on imagery). */
export const labelFont = (level: AdminLevel, size: LabelSize) =>
  `bold ${Math.round(ADMIN_STYLE[level].basePx * LABEL_SCALE[size])}px "IBM Plex Sans Thai", "Sarabun", "Tahoma", sans-serif`;

export interface ProvinceIndex {
  pcode: string;
  th: string;
  en: string;
  /** w s e n */
  bbox: [number, number, number, number];
  amphoe: number;
  tambon: number;
}

let indexP: Promise<ProvinceIndex[]> | null = null;
/** The 77 provinces with their bounding boxes (small file, fetched once). */
export function loadProvinceIndex(): Promise<ProvinceIndex[]> {
  if (!indexP) {
    indexP = fetch('/admin/provinces.json').then((r) => {
      if (!r.ok) throw new Error(`/admin/provinces.json: HTTP ${r.status}`);
      return r.json() as Promise<ProvinceIndex[]>;
    });
    indexP.catch(() => (indexP = null));
  }
  return indexP;
}

const cache = new Map<string, Promise<AdminCollection>>();
/** One province's districts or subdistricts (fetched once per page load). */
export function loadAdmin(level: AdminLevel, pcode: string): Promise<AdminCollection> {
  const key = `${level}/${pcode}`;
  let p = cache.get(key);
  if (!p) {
    p = fetch(`/admin/${key}.json`).then((r) => {
      if (!r.ok) throw new Error(`/admin/${key}.json: HTTP ${r.status}`);
      return r.json() as Promise<AdminCollection>;
    });
    p.catch(() => cache.delete(key)); // let a later view change retry
    cache.set(key, p);
  }
  return p;
}

export interface AdminLayerPrefs {
  amphoe: boolean;
  tambon: boolean;
  /** draw the names as well as the lines */
  labels: boolean;
  amphoeColor: string;
  tambonColor: string;
  amphoeWidth: number;
  tambonWidth: number;
  labelSize: LabelSize;
  /** dark box behind each name (easiest to read on bright imagery) */
  labelBox: boolean;
}
export const ADMIN_DEFAULT: AdminLayerPrefs = {
  amphoe: false, tambon: false, labels: true,
  amphoeColor: '#fb923c', tambonColor: '#7dd3fc', amphoeWidth: 2.5, tambonWidth: 1.5,
  labelSize: 'm', labelBox: true,
};
const KEY = 'ov.monitor.adminLayers.v1';

function load(): AdminLayerPrefs {
  try {
    return { ...ADMIN_DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return ADMIN_DEFAULT;
  }
}

/** Which admin layers are switched on — remembered in this browser. */
export const useAdminLayers = create<{ prefs: AdminLayerPrefs; set: (p: Partial<AdminLayerPrefs>) => void; resetStyle: () => void }>((set, get) => ({
  resetStyle: () => {
    const { amphoe, tambon, labels } = get().prefs;
    get().set({ ...ADMIN_DEFAULT, amphoe, tambon, labels });
  },
  prefs: load(),
  set: (p) =>
    set((s) => {
      const prefs = { ...s.prefs, ...p };
      try {
        localStorage.setItem(KEY, JSON.stringify(prefs));
      } catch {
        /* storage unavailable */
      }
      return { prefs };
    }),
}));
