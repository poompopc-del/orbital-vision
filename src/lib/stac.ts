// Archive search against the public Earth Search STAC API (Element 84, AWS open data).
// Returns genuine catalogue records — nothing here is synthesised.
import { bumpQuota } from './quotas';
import { aoiCoveragePct } from './geo';

export const STAC_API = 'https://earth-search.aws.element84.com/v1';

export const STAC_COLLECTIONS = [
  { id: 'sentinel-2-l2a', label: 'Sentinel-2 L2A', providerId: 'copernicus', missionId: 'sentinel-2', sensor: 'multispectral', gsd: '10 m', optical: true, level: 'L2A surface reflectance' },
  { id: 'landsat-c2-l2', label: 'Landsat C2 L2', providerId: 'usgs', missionId: 'landsat', sensor: 'multispectral', gsd: '30 m', optical: true, level: 'Collection 2 Level-2' },
  { id: 'sentinel-1-grd', label: 'Sentinel-1 GRD', providerId: 'copernicus', missionId: 'sentinel-1', sensor: 'sar', gsd: '~10 m pixel (IW GRD)', optical: false, level: 'Level-1 GRD' },
] as const;

export type StacCollectionId = (typeof STAC_COLLECTIONS)[number]['id'];

export interface ImageryItem {
  id: string;
  collection: StacCollectionId;
  collectionLabel: string;
  providerId: string;
  platform: string;
  datetime: string;
  cloudCover: number | null;
  viewAngle: number | null;
  sunElevation: number | null;
  gsd: string;
  level: string;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  bbox: [number, number, number, number];
  thumbnail: string | null;
  coveragePct: number | null;
  assets: Record<string, { href: string; type?: string; title?: string }>;
  selfHref: string | null;
  raw: any;
}

export interface StacQuery {
  aoi: GeoJSON.Polygon;
  collections: StacCollectionId[];
  from: string; // yyyy-mm-dd
  to: string;
  maxCloud?: number;
  limit?: number;
}

function toItem(f: any, aoi: GeoJSON.Polygon): ImageryItem {
  const meta = STAC_COLLECTIONS.find((c) => c.id === f.collection) ?? STAC_COLLECTIONS[0];
  const p = f.properties || {};
  const thumb = f.assets?.thumbnail?.href || f.assets?.preview?.href || null;
  const self = (f.links || []).find((l: any) => l.rel === 'self')?.href ?? null;
  return {
    id: f.id,
    collection: meta.id,
    collectionLabel: meta.label,
    providerId: meta.providerId,
    platform: p.platform || p.constellation || meta.label,
    datetime: p.datetime,
    cloudCover: typeof p['eo:cloud_cover'] === 'number' ? p['eo:cloud_cover'] : null,
    viewAngle: typeof p['view:off_nadir'] === 'number' ? p['view:off_nadir'] : null,
    sunElevation: typeof p['view:sun_elevation'] === 'number' ? p['view:sun_elevation'] : null,
    gsd: typeof p.gsd === 'number' ? `${p.gsd} m` : meta.gsd,
    level: p['processing:level'] || meta.level,
    geometry: f.geometry,
    bbox: f.bbox,
    thumbnail: thumb && /^https?:/.test(thumb) ? thumb : null,
    coveragePct: aoiCoveragePct(aoi, f.geometry),
    assets: f.assets || {},
    selfHref: self,
    raw: f,
  };
}

export async function searchArchive(q: StacQuery): Promise<ImageryItem[]> {
  const out: ImageryItem[] = [];
  // query each collection separately so per-collection filters (cloud cover) apply correctly
  await Promise.all(
    q.collections.map(async (cid) => {
      const meta = STAC_COLLECTIONS.find((c) => c.id === cid)!;
      const body: any = {
        collections: [cid],
        intersects: q.aoi,
        datetime: `${q.from}T00:00:00Z/${q.to}T23:59:59Z`,
        limit: q.limit ?? 40,
        sortby: [{ field: 'properties.datetime', direction: 'desc' }],
      };
      if (meta.optical && q.maxCloud != null) body.query = { 'eo:cloud_cover': { lte: q.maxCloud } };
      bumpQuota('stac');
      let r = await fetch(`${STAC_API}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok && body.sortby) {
        delete body.sortby;
        r = await fetch(`${STAC_API}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      }
      if (!r.ok) throw new Error(`${meta.label}: STAC search failed (HTTP ${r.status})`);
      const j = await r.json();
      for (const f of j.features || []) out.push(toItem(f, q.aoi));
    }),
  );
  return out.sort((a, b) => b.datetime.localeCompare(a.datetime));
}
