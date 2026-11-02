// The watch runner never draws on a globe; src/lib/stac.ts imports Cesium only for map layers.
export const Cesium: any = new Proxy({}, { get: () => { throw new Error('Cesium is not available in the watch runner'); } });
export default Cesium;
