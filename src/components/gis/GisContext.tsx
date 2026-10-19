import { createContext, useContext } from 'react';
import type { Cesium } from '../../lib/cesium';
import type { LayerController } from '../../lib/basemaps';
import type { ImageryItem } from '../../lib/stac';

export interface LegendSpec {
  ramp?: string; // CSS gradient
  range?: [number, number];
  unit?: string;
  items?: { color: string; label: string }[];
  note?: string;
}

export interface LayerEntry {
  id: string;
  name: string;
  group: 'analysis' | 'vector' | 'terrain';
  layer?: Cesium.ImageryLayer;
  dataSource?: Cesium.DataSource;
  show: boolean;
  alpha: number;
  legend?: LegendSpec;
  meta?: string; // date / source line shown in the layer list and report
}

export type MapTool = 'pan' | 'query' | 'elevation' | 'pour' | 'measure-line' | 'measure-area';

export interface ReportSection {
  id: string;
  title: string;
  lines: string[];
}

export interface GisApi {
  viewer: Cesium.Viewer | null;
  controller: LayerController | null;
  layers: LayerEntry[];
  /** Add or replace an imagery layer (from a provider) under a stable id. */
  putImagery: (id: string, name: string, provider: Cesium.ImageryProvider, opts?: { alpha?: number; legend?: LegendSpec; meta?: string }) => Cesium.ImageryLayer | null;
  putDataSource: (id: string, name: string, ds: Cesium.DataSource, opts?: { legend?: LegendSpec; meta?: string }) => void;
  removeLayer: (id: string) => void;
  setLayer: (id: string, patch: Partial<Pick<LayerEntry, 'show' | 'alpha'>>) => void;
  moveLayer: (id: string, dir: 1 | -1) => void;
  tool: MapTool;
  setTool: (t: MapTool) => void;
  /** Subscribe to map clicks while `tool` is active; returns an unsubscribe function. */
  onMapClick: (tool: MapTool, fn: (lon: number, lat: number) => void) => () => void;
  sceneA: ImageryItem | null;
  sceneB: ImageryItem | null;
  setSceneA: (i: ImageryItem | null) => void;
  setSceneB: (i: ImageryItem | null) => void;
  report: ReportSection[];
  putReport: (s: ReportSection) => void;
}

export const GisCtx = createContext<GisApi | null>(null);

export function useGis(): GisApi {
  const c = useContext(GisCtx);
  if (!c) throw new Error('useGis outside GisWorkspace');
  return c;
}
