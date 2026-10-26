// How boundary lines are drawn on the watch map (colour, width, dashes) — remembered in this browser.
import { create } from 'zustand';

export interface LineStyle {
  color: string;
  width: number;
  dashed: boolean;
  /** keep the boundary visible in the "imagery only" view */
  inClean: boolean;
}
export const LINE_DEFAULT: LineStyle = { color: '#facc15', width: 2.5, dashed: false, inClean: true };
export const LINE_SWATCHES = ['#facc15', '#ef4444', '#ffffff', '#22d3ee', '#f472b6', '#fb923c', '#4ade80', '#000000'];
const KEY = 'ov.monitor.lineStyle.v1';

function load(): LineStyle {
  try {
    return { ...LINE_DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return LINE_DEFAULT;
  }
}

export const useLineStyle = create<{ style: LineStyle; set: (p: Partial<LineStyle>) => void; reset: () => void }>((set) => ({
  style: load(),
  set: (p) =>
    set((s) => {
      const style = { ...s.style, ...p };
      try {
        localStorage.setItem(KEY, JSON.stringify(style));
      } catch {
        /* storage unavailable */
      }
      return { style };
    }),
  reset: () =>
    set(() => {
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
      return { style: LINE_DEFAULT };
    }),
}));
