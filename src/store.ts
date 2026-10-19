import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SatRecord } from './lib/orbit';
import type { Aoi } from './lib/geo';
import type { ImageryItem } from './lib/stac';

type OrbitStatus = 'idle' | 'loading' | 'ready' | 'error';

interface OrbitState {
  sats: SatRecord[];
  status: OrbitStatus;
  source: string;
  fetchedAt: Date | null;
  error: string | null;
  warnings: string[];
  setOrbit: (p: Partial<Omit<OrbitState, 'setOrbit'>>) => void;
}

// orbital data is not persisted through zustand (satrec objects aren't serialisable) — lib/tle caches the raw text
export const useOrbit = create<OrbitState>((set) => ({
  sats: [],
  status: 'idle',
  source: '',
  fetchedAt: null,
  error: null,
  warnings: [],
  setOrbit: (p) => set(p),
}));

interface WorkspaceState {
  aoi: Aoi | null;
  setAoi: (a: Aoi | null) => void;
  selectedSat: string | null;
  setSelectedSat: (id: string | null) => void;
  /** The one shared satellite selection used by every globe page. Starts empty. */
  mySats: string[];
  setMySats: (ids: string[]) => void;
  lastResults: ImageryItem[];
  setLastResults: (r: ImageryItem[]) => void;
  compare: ImageryItem[];
  toggleCompare: (i: ImageryItem) => void;
  clearCompare: () => void;
}

const slim = (i: ImageryItem): ImageryItem => ({ ...i, raw: undefined });

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      aoi: null,
      setAoi: (aoi) => set({ aoi }),
      selectedSat: null,
      setSelectedSat: (selectedSat) => set({ selectedSat }),
      mySats: [],
      setMySats: (mySats) => set({ mySats }),
      lastResults: [],
      setLastResults: (r) => set({ lastResults: r.map(slim) }),
      compare: [],
      toggleCompare: (i) => {
        const has = get().compare.some((c) => c.id === i.id);
        if (has) set({ compare: get().compare.filter((c) => c.id !== i.id) });
        else set({ compare: [...get().compare, slim(i)].slice(-2) });
      },
      clearCompare: () => set({ compare: [] }),
    }),
    {
      name: 'ov.workspace.v1',
      version: 2,
      // v2: one shared selection that starts empty (old pinned / per-page lists are dropped)
      migrate: (old: any) => {
        const { pinned, pinnedOnly, customOnly, passSats, ...rest } = old || {};
        void pinned; void pinnedOnly; void customOnly; void passSats;
        return { ...rest, mySats: [], selectedSat: null };
      },
    },
  ),
);
