import type { SensorCategory } from './providers';

// Mission metadata, matched against satellite names in public orbital element sets.
// Orbital values (altitude, inclination, period) are NOT stored here — they are derived from live TLE data.
// swathKm is only set where the swath is documented by the operator; otherwise footprints are not drawn.

export interface Mission {
  id: string;
  name: string;
  providerId: string;
  pattern: RegExp;
  sensor: SensorCategory;
  missionType: string;
  instrument: string;
  resolution: string;
  swathKm?: number;
  bands?: string;
  capabilities: string;
  archive: string;
  tasking: 'commercial' | 'agency' | 'none' | 'unknown';
  stacCollection?: string;
}

export const MISSIONS: Mission[] = [
  {
    id: 'sentinel-1', name: 'Sentinel-1', providerId: 'copernicus', pattern: /^SENTINEL-1[A-Z]\b/,
    sensor: 'sar', missionType: 'Radar Earth observation', instrument: 'C-SAR (C-band)',
    resolution: 'IW mode ~5 m × 20 m (range × azimuth); varies by mode', swathKm: 250,
    bands: 'C-band, dual polarisation (VV+VH / HH+HV)',
    capabilities: 'Day/night, all-weather imaging; interferometry (InSAR)',
    archive: 'Open archive (Copernicus)', tasking: 'none', stacCollection: 'sentinel-1-grd',
  },
  {
    id: 'sentinel-2', name: 'Sentinel-2', providerId: 'copernicus', pattern: /^SENTINEL-2[A-Z]\b/,
    sensor: 'multispectral', missionType: 'Land monitoring', instrument: 'MSI',
    resolution: '10 m (B2–B4, B8), 20 m, 60 m by band', swathKm: 290,
    bands: '13 bands, 443–2190 nm (VNIR + SWIR)',
    capabilities: 'Natural colour, false colour, vegetation indices',
    archive: 'Open archive (Copernicus)', tasking: 'none', stacCollection: 'sentinel-2-l2a',
  },
  {
    id: 'sentinel-3', name: 'Sentinel-3', providerId: 'copernicus', pattern: /^SENTINEL-3[A-Z]\b/,
    sensor: 'thermal', missionType: 'Ocean, land & atmosphere monitoring', instrument: 'OLCI, SLSTR, SRAL',
    resolution: 'OLCI 300 m; SLSTR 500 m (VIS/SWIR) / 1 km (thermal)', swathKm: 1270,
    bands: 'OLCI 21 bands; SLSTR 9 bands incl. thermal IR',
    capabilities: 'Sea/land surface temperature, ocean colour', archive: 'Open archive (Copernicus)', tasking: 'none',
  },
  {
    id: 'landsat', name: 'Landsat 8 / 9', providerId: 'usgs', pattern: /^LANDSAT [89]\b/,
    sensor: 'multispectral', missionType: 'Land monitoring', instrument: 'OLI / TIRS',
    resolution: '30 m multispectral, 15 m panchromatic, 100 m thermal', swathKm: 185,
    bands: '11 bands incl. 2 thermal (TIRS)',
    capabilities: 'Long-term land change, thermal', archive: 'Open archive (USGS)', tasking: 'none',
    stacCollection: 'landsat-c2-l2',
  },
  {
    id: 'modis', name: 'Terra / Aqua (MODIS)', providerId: 'nasa-eos', pattern: /^(TERRA|AQUA)$/,
    sensor: 'multispectral', missionType: 'Earth system science', instrument: 'MODIS',
    resolution: '250 m / 500 m / 1 km by band', swathKm: 2330, bands: '36 bands',
    capabilities: 'Daily global coverage', archive: 'NASA Earthdata', tasking: 'none',
  },
  {
    id: 'planetscope', name: 'PlanetScope', providerId: 'planet', pattern: /^FLOCK\b/,
    sensor: 'multispectral', missionType: 'Commercial daily monitoring', instrument: 'PlanetScope imager',
    resolution: '~3 m class (provider-reported)', bands: '4–8 bands (SuperDove: 8)',
    capabilities: 'Near-daily revisit', archive: 'Commercial archive', tasking: 'none',
  },
  {
    id: 'skysat', name: 'SkySat', providerId: 'planet', pattern: /^SKYSAT\b/,
    sensor: 'optical', missionType: 'Commercial high-resolution', instrument: 'SkySat imager',
    resolution: '~50 cm class orthorectified (provider-reported)', bands: 'Pan + RGB + NIR',
    capabilities: 'Tasking, video', archive: 'Commercial archive', tasking: 'commercial',
  },
  {
    id: 'pelican', name: 'Pelican', providerId: 'planet', pattern: /^PELICAN\b/,
    sensor: 'optical', missionType: 'Commercial high-resolution', instrument: 'Pelican imager',
    resolution: 'High-resolution (see provider)', capabilities: 'Next-generation tasking constellation',
    archive: 'Commercial archive', tasking: 'commercial',
  },
  {
    id: 'worldview', name: 'WorldView', providerId: 'vantor', pattern: /^(WORLDVIEW|WV LEGION|WORLDVIEW LEGION)/,
    sensor: 'optical', missionType: 'Commercial very-high-resolution', instrument: 'WorldView imagers',
    resolution: '30 cm class panchromatic at nadir (WorldView-3 / Legion); varies by satellite and off-nadir angle',
    bands: 'Pan + multispectral (WorldView-3 adds SWIR)', capabilities: 'Agile pointing, stereo',
    archive: 'Commercial archive', tasking: 'commercial',
  },
  {
    id: 'geoeye', name: 'GeoEye-1', providerId: 'vantor', pattern: /^GEOEYE/,
    sensor: 'optical', missionType: 'Commercial very-high-resolution', instrument: 'GeoEye-1 imager',
    resolution: '~40 cm class panchromatic at nadir', swathKm: 15.2, bands: 'Pan + 4 MS',
    capabilities: 'Agile pointing', archive: 'Commercial archive', tasking: 'commercial',
  },
  {
    id: 'pleiades-neo', name: 'Pléiades Neo', providerId: 'airbus', pattern: /^PLEIADES NEO/,
    sensor: 'optical', missionType: 'Commercial very-high-resolution', instrument: 'Pléiades Neo imager',
    resolution: '30 cm panchromatic (product)', swathKm: 14, bands: 'Pan + 6 MS',
    capabilities: 'Agile pointing', archive: 'Commercial archive (OneAtlas)', tasking: 'commercial',
  },
  {
    id: 'pleiades', name: 'Pléiades 1A/1B', providerId: 'airbus', pattern: /^PLEIADES 1/,
    sensor: 'optical', missionType: 'Commercial very-high-resolution', instrument: 'HiRI',
    resolution: '50 cm panchromatic (product)', swathKm: 20, bands: 'Pan + 4 MS',
    capabilities: 'Agile pointing, stereo', archive: 'Commercial archive (OneAtlas)', tasking: 'commercial',
  },
  {
    id: 'spot', name: 'SPOT 6/7', providerId: 'airbus', pattern: /^SPOT [67]\b/,
    sensor: 'optical', missionType: 'Commercial high-resolution', instrument: 'NAOMI',
    resolution: '1.5 m panchromatic (product)', swathKm: 60, bands: 'Pan + 4 MS',
    capabilities: 'Wide-area high-resolution mapping', archive: 'Commercial archive (OneAtlas)', tasking: 'commercial',
  },
  {
    id: 'blacksky', name: 'BlackSky', providerId: 'blacksky', pattern: /^BLACKSKY/,
    sensor: 'optical', missionType: 'Commercial rapid revisit', instrument: 'BlackSky imager',
    resolution: 'Gen-2 ~1 m class; Gen-3 ~35 cm class (provider-reported)',
    capabilities: 'High revisit tasking', archive: 'Commercial archive', tasking: 'commercial',
  },
  {
    id: 'newsat', name: 'NewSat (ÑuSat)', providerId: 'satellogic', pattern: /^NUSAT/,
    sensor: 'multispectral', missionType: 'Commercial high-resolution', instrument: 'Satellogic imagers',
    resolution: 'Sub-metre class (provider-reported; varies by generation)',
    capabilities: 'Multispectral; hyperspectral on some satellites', archive: 'Commercial archive', tasking: 'commercial',
  },
  {
    id: 'iceye', name: 'ICEYE', providerId: 'iceye', pattern: /^ICEYE/,
    sensor: 'sar', missionType: 'Commercial SAR', instrument: 'X-band SAR',
    resolution: 'Sub-metre to metre class depending on mode (provider-reported)', bands: 'X-band, VV',
    capabilities: 'Day/night, all-weather; persistent monitoring', archive: 'Commercial archive', tasking: 'commercial',
  },
  {
    id: 'capella', name: 'Capella', providerId: 'capella', pattern: /^CAPELLA/,
    sensor: 'sar', missionType: 'Commercial SAR', instrument: 'X-band SAR',
    resolution: 'Spotlight ~0.5 m class (provider-reported)', bands: 'X-band',
    capabilities: 'Day/night, all-weather', archive: 'Commercial archive', tasking: 'commercial',
  },
  {
    id: 'umbra', name: 'Umbra', providerId: 'umbra', pattern: /^UMBRA/,
    sensor: 'sar', missionType: 'Commercial SAR', instrument: 'X-band SAR',
    resolution: 'Very-high-resolution spotlight (provider-reported)', bands: 'X-band',
    capabilities: 'Day/night, all-weather', archive: 'Commercial archive + open data samples', tasking: 'commercial',
  },
  {
    id: 'theos-2', name: 'THEOS-2', providerId: 'gistda', pattern: /^THEOS/,
    sensor: 'optical', missionType: 'National Earth observation', instrument: 'THEOS-2 imager',
    resolution: 'Sub-metre panchromatic class (agency-reported)', capabilities: 'Thailand priority mapping',
    archive: 'Via GISTDA', tasking: 'agency',
  },
  {
    id: 'napa', name: 'NAPA (RTAF)', providerId: 'rtaf', pattern: /^NAPA/,
    sensor: 'optical', missionType: 'Military Earth observation (nanosatellite)', instrument: 'Optical imager',
    resolution: 'Not published here', capabilities: 'Airspace observation; disaster support (operator-reported)',
    archive: 'Not public', tasking: 'none',
  },
  {
    id: 'jpss', name: 'JPSS / Suomi NPP', providerId: 'noaa', pattern: /^(NOAA 2[0-9]|SUOMI NPP)/,
    sensor: 'weather', missionType: 'Polar weather', instrument: 'VIIRS, ATMS, CrIS',
    resolution: 'VIIRS 375 m / 750 m', swathKm: 3040, capabilities: 'Day/night band, fires, clouds',
    archive: 'Public (NOAA)', tasking: 'none',
  },
  {
    id: 'goes', name: 'GOES', providerId: 'noaa', pattern: /^GOES 1[6-9]/,
    sensor: 'weather', missionType: 'Geostationary weather', instrument: 'ABI, GLM',
    resolution: 'ABI 0.5–2 km by band', capabilities: 'Continuous hemispheric imaging',
    archive: 'Public (NOAA)', tasking: 'none',
  },
  {
    id: 'metop', name: 'Metop', providerId: 'eumetsat', pattern: /^METOP-[A-Z]/,
    sensor: 'weather', missionType: 'Polar weather', instrument: 'AVHRR, IASI, ASCAT',
    resolution: 'AVHRR ~1.1 km at nadir', swathKm: 2900, capabilities: 'Global weather sounding',
    archive: 'EUMETSAT Data Store', tasking: 'none',
  },
];

/** Used for satellites the user adds by NORAD ID that match no known mission. */
export const CUSTOM_MISSION: Mission = {
  id: 'custom', name: 'User-added', providerId: 'custom', pattern: /$^/,
  sensor: 'unknown', missionType: 'Unknown', instrument: 'Unknown', resolution: 'Unknown',
  capabilities: 'Orbit tracking only — no sensor metadata', archive: 'Unknown', tasking: 'unknown',
};

export const missionForName = (name: string): Mission | undefined =>
  MISSIONS.find((m) => m.pattern.test(name.toUpperCase()));
export const missionById = (id: string) => MISSIONS.find((m) => m.id === id);
