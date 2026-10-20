// Automatic scene choice from a date range: searches the archive over the AOI and picks the best scene.
// Optical: full AOI coverage first, then least cloud, then most recent.
// SAR: full AOI coverage first, then most recent. A "match" scene makes the pick prefer the same
// acquisition geometry (Sentinel-1 relative orbit, Sentinel-2 MGRS tile, Landsat WRS path/row),
// which matters for before/after comparison.
import { searchArchive, STAC_COLLECTIONS, type ImageryItem, type StacCollectionId } from './stac';

const GEOMETRY_KEYS = ['sat:relative_orbit', 'sat:orbit_state', 's2:mgrs_tile', 'landsat:wrs_path', 'landsat:wrs_row'];

const sameGeometry = (a: ImageryItem, b: ImageryItem) =>
  GEOMETRY_KEYS.every((k) => {
    const va = a.raw?.properties?.[k];
    const vb = b.raw?.properties?.[k];
    return va === undefined || vb === undefined || va === vb;
  });

export interface PickResult {
  item: ImageryItem | null;
  candidates: ImageryItem[];
  reason: string;
}

export async function pickBestScene(
  aoi: GeoJSON.Polygon,
  collection: StacCollectionId,
  from: string,
  to: string,
  opts: { match?: ImageryItem | null; maxCloud?: number } = {},
): Promise<PickResult> {
  const meta = STAC_COLLECTIONS.find((c) => c.id === collection)!;
  const all = await searchArchive({ aoi, collections: [collection], from, to, maxCloud: meta.optical ? (opts.maxCloud ?? 60) : undefined, limit: 60 });
  const usable = all.filter((x) => x.source === 'planetary-computer');
  if (!usable.length) return { item: null, candidates: all, reason: 'no scenes in this date range' };
  const full = usable.filter((x) => (x.coveragePct ?? 0) >= 95);
  let pool = full.length ? full : usable.filter((x) => (x.coveragePct ?? 0) >= 50);
  if (!pool.length) pool = usable;
  if (opts.match) {
    const same = pool.filter((x) => sameGeometry(x, opts.match!));
    if (same.length) pool = same;
  }
  const sorted = [...pool].sort((a, b) => {
    const cov = Math.round((b.coveragePct ?? 0) / 5) - Math.round((a.coveragePct ?? 0) / 5);
    if (cov) return cov;
    if (meta.optical) {
      const cl = Math.round(a.cloudCover ?? 100) - Math.round(b.cloudCover ?? 100);
      if (cl) return cl;
    }
    return b.datetime.localeCompare(a.datetime);
  });
  const it = sorted[0];
  const why = [
    it.coveragePct != null ? `AOI ${Math.round(it.coveragePct)}%` : '',
    meta.optical && it.cloudCover != null ? `cloud ${it.cloudCover.toFixed(0)}%` : '',
    opts.match && sameGeometry(it, opts.match) ? 'same orbit/tile as the other scene' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return { item: it, candidates: all, reason: why };
}

export const daysAgo = (n: number) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
