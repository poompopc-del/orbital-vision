// Shared surveillance settings (quality thresholds + area unit), persisted in this browser.
import { create } from 'zustand';
import { loadAreaUnit, saveAreaUnit, type AreaUnit } from './area';
import { loadQc, saveQc, type QcSettings } from './qc';

interface S {
  qc: QcSettings;
  unit: AreaUnit;
  setQc: (p: Partial<QcSettings>) => void;
  setUnit: (u: AreaUnit) => void;
}

export const useQc = create<S>((set, get) => ({
  qc: loadQc(),
  unit: loadAreaUnit(),
  setQc: (p) => {
    const qc = { ...get().qc, ...p };
    saveQc(qc);
    set({ qc });
  },
  setUnit: (unit) => {
    saveAreaUnit(unit);
    set({ unit });
  },
}));
