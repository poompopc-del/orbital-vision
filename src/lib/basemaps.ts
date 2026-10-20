// Basemaps and overlay layers for the GIS workspace. All sources are public tile services
// that require attribution; Cesium shows each provider's credit automatically.
import { Cesium, hasIon } from './cesium';

export type BasemapId = 'satellite' | 'hybrid' | 'street' | 'topo' | 'hillshade' | 'light' | 'dark' | 'osm';

export interface BasemapDef {
  id: BasemapId;
  label: string;
  note: string;
}

export const BASEMAPS: BasemapDef[] = [
  { id: 'satellite', label: 'Satellite', note: hasIon ? 'Bing Maps Aerial (Cesium ion)' : 'Esri World Imagery' },
  { id: 'hybrid', label: 'Hybrid', note: 'Satellite + roads + boundaries & place names (Esri reference layers)' },
  { id: 'street', label: 'Street map', note: 'Esri World Street Map' },
  { id: 'topo', label: 'Terrain map', note: 'Esri World Topographic Map' },
  { id: 'hillshade', label: 'Hill shade', note: 'Esri World Hillshade (relief only)' },
  { id: 'light', label: 'Plain (light)', note: 'Esri Light Gray Canvas — clean background for tracks' },
  { id: 'dark', label: 'Plain (dark)', note: 'Esri Dark Gray Canvas — clean background for tracks' },
  { id: 'osm', label: 'OpenStreetMap', note: '© OpenStreetMap contributors' },
];

const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services';

async function esri(path: string) {
  return Cesium.ArcGisMapServerImageryProvider.fromUrl(`${ESRI}/${path}/MapServer`);
}

async function satelliteProvider(): Promise<Cesium.ImageryProvider> {
  if (hasIon) {
    try {
      return await Cesium.IonImageryProvider.fromAssetId(2); // Bing Maps Aerial
    } catch {
      /* fall through to Esri */
    }
  }
  return esri('World_Imagery');
}

export type OverlayId = 'roads' | 'labels';

export const OVERLAYS: { id: OverlayId; label: string; note: string }[] = [
  { id: 'roads', label: 'Roads & road names', note: 'Esri World Transportation (reference)' },
  { id: 'labels', label: 'Boundaries & place names', note: 'Esri World Boundaries and Places — countries, provinces (admin-1) and places. District / sub-district boundaries are not in this source: import a GeoJSON for those.' },
];

async function overlayProvider(id: OverlayId) {
  return id === 'roads' ? esri('Reference/World_Transportation') : esri('Reference/World_Boundaries_and_Places');
}

/** Keeps track of the basemap and overlays the workspace owns on a viewer. */
export class LayerController {
  private viewer: Cesium.Viewer;
  private base: Cesium.ImageryLayer[] = [];
  private overlays = new Map<OverlayId, Cesium.ImageryLayer>();
  private token = 0;
  private autoOn = new Set<OverlayId>();

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer;
  }

  async setBasemap(id: BasemapId): Promise<void> {
    const my = ++this.token;
    const providers: Cesium.ImageryProvider[] = [];
    try {
      if (id === 'satellite' || id === 'hybrid') providers.push(await satelliteProvider());
      else if (id === 'street') providers.push(await esri('World_Street_Map'));
      else if (id === 'topo') providers.push(await esri('World_Topo_Map'));
      else if (id === 'hillshade') providers.push(await esri('Elevation/World_Hillshade'));
      else if (id === 'light') providers.push(await esri('Canvas/World_Light_Gray_Base'));
      else if (id === 'dark') providers.push(await esri('Canvas/World_Dark_Gray_Base'));
      else providers.push(new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }));
    } catch {
      providers.push(new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }));
    }
    if (my !== this.token || this.viewer.isDestroyed()) return;
    this.base.forEach((l) => this.viewer.imageryLayers.remove(l, true));
    this.base = providers.map((p, i) => this.viewer.imageryLayers.addImageryProvider(p, i));
    // hybrid = satellite with both reference overlays switched on
    if (id === 'hybrid') {
      if (!this.overlays.has('roads')) this.autoOn.add('roads');
      if (!this.overlays.has('labels')) this.autoOn.add('labels');
      await this.setOverlay('roads', true, 1, true);
      await this.setOverlay('labels', true, 1, true);
    } else if (this.autoOn.size) {
      // leaving hybrid: switch off the overlays hybrid itself turned on
      for (const o of [...this.autoOn]) await this.setOverlay(o, false, 1, true);
      this.autoOn.clear();
    }
    this.raiseOverlays();
  }

  async setOverlay(id: OverlayId, on: boolean, alpha = 1, auto = false): Promise<void> {
    if (!auto) this.autoOn.delete(id);
    const cur = this.overlays.get(id);
    if (!on) {
      if (cur) this.viewer.imageryLayers.remove(cur, true);
      this.overlays.delete(id);
      return;
    }
    if (cur) {
      cur.alpha = alpha;
      return;
    }
    try {
      const p = await overlayProvider(id);
      if (this.viewer.isDestroyed() || this.overlays.has(id)) return;
      const l = this.viewer.imageryLayers.addImageryProvider(p);
      l.alpha = alpha;
      this.overlays.set(id, l);
    } catch {
      /* overlay service unavailable — leave it off */
    }
  }

  overlayOn(id: OverlayId) {
    return this.overlays.has(id);
  }

  setOverlayAlpha(id: OverlayId, a: number) {
    const l = this.overlays.get(id);
    if (l) l.alpha = a;
  }

  /** Reference overlays stay above analysis layers so roads and names remain readable. */
  raiseOverlays() {
    this.overlays.forEach((l) => this.viewer.imageryLayers.raiseToTop(l));
  }
}
