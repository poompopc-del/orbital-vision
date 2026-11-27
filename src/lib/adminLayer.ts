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

export const ADMIN_STYLE: Record<AdminLevel, { color: string; width: number; dashed: boolean; labelMaxM: number; font: string }> = {
  // districts: solid orange, names when the camera is below ~600 km
  amphoe: { color: '#fb923c', width: 1.8, dashed: false, labelMaxM: 6e5, font: '12px "IBM Plex Sans Thai", "IBM Plex Sans", sans-serif' },
  // subdistricts: thin dashed light blue, names only when zoomed in (below ~70 km)
  tambon: { color: '#7dd3fc', width: 1.2, dashed: true, labelMaxM: 7e4, font: '11px "IBM Plex Sans Thai", "IBM Plex Sans", sans-serif' },
};

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
}
export const ADMIN_DEFAULT: AdminLayerPrefs = { amphoe: false, tambon: false, labels: true };
const KEY = 'ov.monitor.adminLayers.v1';

function load(): AdminLayerPrefs {
  try {
    return { ...ADMIN_DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return ADMIN_DEFAULT;
  }
}

/** Which admin layers are switched on — remembered in this browser. */
export const useAdminLayers = create<{ prefs: AdminLayerPrefs; set: (p: Partial<AdminLayerPrefs>) => void }>((set) => ({
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
