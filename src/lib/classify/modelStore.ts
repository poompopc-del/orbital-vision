// Trained models are kept in this browser (localStorage) with their metadata, and can be exported /
// imported as JSON files. Nothing here ships a pre-trained model: the app has no verified training data.
import { parseForest, serializeForest, type Forest } from './rf';

const KEY = 'ov.lc.models.v1';

export function listModels(): Forest[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(arr) ? arr.map((s: string) => parseForest(s)) : [];
  } catch {
    return [];
  }
}

export function saveModel(f: Forest): string | null {
  const all = listModels().filter((m) => m.meta.id !== f.meta.id);
  all.unshift(f);
  try {
    localStorage.setItem(KEY, JSON.stringify(all.slice(0, 8).map(serializeForest)));
    return null;
  } catch (e: any) {
    return e?.message ?? 'storage full';
  }
}

export function deleteModel(id: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(listModels().filter((m) => m.meta.id !== id).map(serializeForest)));
  } catch {
    /* ignore */
  }
}

export function downloadModel(f: Forest) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([serializeForest(f)], { type: 'application/json' }));
  a.download = `orbital-vision-model-${f.meta.sensor}-${f.meta.createdAt.slice(0, 10)}.json`;
  a.click();
}
