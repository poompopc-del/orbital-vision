// Thai district (อำเภอ) and subdistrict (ตำบล) outlines for the 7 provinces on the Cambodian border
// (Ubon Ratchathani, Si Sa Ket, Surin, Buri Ram, Sa Kaeo, Chanthaburi, Trat), drawn as optional
// layers on the watch map. Source: RTSD administrative boundaries 2022 (tha_admbnda_adm2/adm3_rtsd_20220121,
// as published on OCHA/HDX), simplified (~20–35 m) and cut to those provinces → public/admin/*.geojson.
// Administrative lines only — not the international boundary.
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

export const ADMIN_FILES: Record<AdminLevel, string> = {
  amphoe: '/admin/border-amphoe.geojson',
  tambon: '/admin/border-tambon.geojson',
};

/** Fixed per-level behaviour; colour and width are user settings (AdminLayerPrefs). */
export const ADMIN_STYLE: Record<AdminLevel, { dashed: boolean; labelMaxM: number; basePx: number }> = {
  // districts: solid line, names when the camera is below ~600 km
  amphoe: { dashed: false, labelMaxM: 6e5, basePx: 15 },
  // subdistricts: dashed line, names only when zoomed in (below ~70 km)
  tambon: { dashed: true, labelMaxM: 7e4, basePx: 13 },
};
export const ADMIN_SWATCHES = ['#fb923c', '#facc15', '#ef4444', '#ffffff', '#22d3ee', '#7dd3fc', '#f472b6', '#4ade80', '#a78bfa', '#000000'];
export type LabelSize = 's' | 'm' | 'l';
export const LABEL_SCALE: Record<LabelSize, number> = { s: 0.85, m: 1, l: 1.3 };

/** Cesium font string for a level's names at the chosen size (bold Thai font, readable on imagery). */
export const labelFont = (level: AdminLevel, size: LabelSize) =>
  `bold ${Math.round(ADMIN_STYLE[level].basePx * LABEL_SCALE[size])}px "IBM Plex Sans Thai", "Sarabun", "Tahoma", sans-serif`;

const cache = new Map<AdminLevel, Promise<AdminCollection>>();
/** Fetch a level once per page load (files are 1–4 MB). */
export function loadAdmin(level: AdminLevel): Promise<AdminCollection> {
  let p = cache.get(level);
  if (!p) {
    p = fetch(ADMIN_FILES[level]).then((r) => {
      if (!r.ok) throw new Error(`${ADMIN_FILES[level]}: HTTP ${r.status}`);
      return r.json() as Promise<AdminCollection>;
    });
    p.catch(() => cache.delete(level)); // let a later toggle retry
    cache.set(level, p);
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
