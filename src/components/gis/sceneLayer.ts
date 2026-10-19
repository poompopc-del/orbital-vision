import { Cesium } from '../../lib/cesium';
import type { ImageryItem } from '../../lib/stac';

/** Imagery provider for a Planetary Computer tile template, clipped to the scene footprint. */
export function pcProvider(url: string, item: ImageryItem) {
  const [w, s, e, n] = item.bbox;
  return new Cesium.UrlTemplateImageryProvider({
    url,
    rectangle: Cesium.Rectangle.fromDegrees(w, s, e, n),
    minimumLevel: 0,
    maximumLevel: 18,
    credit: new Cesium.Credit(`${item.collectionLabel} ${item.datetime.slice(0, 10)} · Microsoft Planetary Computer`),
  });
}

/** Single image draped over a lat/lon rectangle (analysis results computed in the browser). */
export async function imageProvider(url: string, west: number, south: number, east: number, north: number) {
  return Cesium.SingleTileImageryProvider.fromUrl(url, { rectangle: Cesium.Rectangle.fromDegrees(west, south, east, north) });
}

export function sceneLabel(i: ImageryItem | null) {
  return i ? `${i.collectionLabel} · ${i.datetime.slice(0, 10)}${i.cloudCover != null ? ` · ☁ ${i.cloudCover.toFixed(0)}%` : ''}` : '—';
}
