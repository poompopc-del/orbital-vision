// Watch areas and their results, persisted in this browser. Shared by the monitor pages and the
// background new-imagery watcher.
import { create } from 'zustand';
import { deleteImages, loadAois, loadRuns, saveAois, saveRuns, type MonitorAoi, type MonitorRun } from './monitor';

interface MonState {
  aois: MonitorAoi[];
  runs: MonitorRun[];
  setAois: (f: (a: MonitorAoi[]) => MonitorAoi[]) => void;
  addRun: (r: MonitorRun) => void;
  removeRun: (id: string) => void;
}
export const useMonitor = create<MonState>((set) => ({
  aois: loadAois(),
  runs: loadRuns(),
  setAois: (f) =>
    set((s) => {
      const aois = f(s.aois);
      saveAois(aois);
      return { aois };
    }),
  addRun: (r) =>
    set((s) => {
      const runs = [r, ...s.runs];
      saveRuns(runs);
      return { runs };
    }),
  removeRun: (id) =>
    set((s) => {
      const runs = s.runs.filter((x) => x.id !== id);
      saveRuns(runs);
      void deleteImages(id);
      return { runs };
    }),
}));
