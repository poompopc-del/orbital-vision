import { useOrbit } from '../store';
import { cachedOrbitalData, loadOrbitalData } from './tle';
import { mergeCustom, refreshStaleCustom } from './customSats';

export async function refreshOrbits(force = false) {
  const set = useOrbit.getState().setOrbit;
  const cached = cachedOrbitalData();
  if (cached && !force && useOrbit.getState().sats.length === 0) {
    // show cached elements immediately, refresh in background if stale
    set({ sats: mergeCustom(cached.sats), status: 'ready', source: cached.source, fetchedAt: cached.fetchedAt });
  } else if (useOrbit.getState().sats.length === 0) {
    set({ status: 'loading' });
  }
  try {
    const r = await loadOrbitalData(force);
    await refreshStaleCustom();
    set({ sats: mergeCustom(r.sats), status: 'ready', source: r.source, fetchedAt: r.fetchedAt, warnings: r.warnings, error: null });
  } catch (e: any) {
    if (useOrbit.getState().sats.length) set({ error: e.message });
    else set({ status: 'error', error: e.message });
  }
}

/** Rebuild the in-memory list after custom satellites change (no network). */
export function remergeCustom() {
  const st = useOrbit.getState();
  const base = st.sats.filter((s) => !s.custom);
  st.setOrbit({ sats: mergeCustom(base), status: base.length || st.status !== 'error' ? 'ready' : st.status });
}
