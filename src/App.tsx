import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import Section from './components/Section';
import Home from './pages/Home';
import MissionControl from './pages/MissionControl';
import ImageryExplorer from './pages/ImageryExplorer';
import NewAcquisition from './pages/NewAcquisition';
import SatelliteCatalog from './pages/SatelliteCatalog';
import ProviderMarketplace from './pages/ProviderMarketplace';
import CoveragePlanner from './pages/CoveragePlanner';
import ImageAnalysis from './pages/ImageAnalysis';
import Orders from './pages/Orders';
import Admin from './pages/Admin';
import ImagingView from './pages/ImagingView';
import PassTracker from './pages/PassTracker';
import GisWorkspace from './pages/GisWorkspace';
import { MonitorReport, MonitorWatch } from './pages/Monitor';
import { DisasterMap, DisasterReport, DisasterSources } from './pages/Disaster';
import { refreshOrbits } from './lib/orbitLoader';
import { useLang } from './i18n';

/** Old page URLs → new section + tab (other query params are kept). */
function Moved({ to, tab }: { to: string; tab: string }) {
  const loc = useLocation();
  const p = new URLSearchParams(loc.search);
  p.set('tab', tab);
  return <Navigate to={`${to}?${p.toString()}`} replace />;
}

export default function App() {
  const lang = useLang((s) => s.lang);
  useEffect(() => {
    void refreshOrbits();
    // keep elements fresh while the page stays open (the loader only downloads when the cache is > 2 h old)
    const i = setInterval(() => void refreshOrbits(), 30 * 60e3);
    return () => clearInterval(i);
  }, []);
  return (
    <Routes key={lang}>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route
          path="track"
          element={
            <Section
              tabs={[
                { id: 'live', label: 'Live positions', hint: 'Where satellites are now (calculated orbits)', el: <MissionControl /> },
                { id: 'passes', label: 'Passes over me', hint: 'When satellites rise above your horizon', el: <PassTracker /> },
                { id: 'imaging', label: 'Imaging swaths', hint: 'Where imaging satellites can see now', el: <ImagingView /> },
                { id: 'coverage', label: 'Imaging opportunities', hint: 'When a swath may cover your area', el: <CoveragePlanner /> },
              ]}
            />
          }
        />
        <Route
          path="gis"
          element={
            <Section
              tabs={[
                { id: 'map', label: 'Analysis map', hint: 'Tasks, indices, flood, change, terrain and dams on one map', el: <GisWorkspace /> },
                { id: 'search', label: 'Search images (list)', hint: 'All archive images over the area as a list', el: <ImageryExplorer /> },
                { id: 'compare', label: 'Compare two images', hint: 'Swipe between two scenes and measure', el: <ImageAnalysis /> },
              ]}
            />
          }
        />
        <Route
          path="disaster"
          element={
            <Section
              tabs={[
                { id: 'map', label: 'Disaster map', hint: 'Floods, fire, earthquakes, storms, drought and PM2.5 from open data', el: <DisasterMap /> },
                { id: 'sources', label: 'Data sources', hint: 'Provider registry and connection health', el: <DisasterSources /> },
                { id: 'report', label: 'Situation report', hint: 'Report from the latest data', el: <DisasterReport /> },
              ]}
            />
          }
        />
        <Route
          path="monitor"
          element={
            <Section
              tabs={[
                { id: 'watch', label: 'Area watchlist', hint: 'Border, forest and disaster areas checked against new imagery', el: <MonitorWatch /> },
                { id: 'report', label: 'Monitoring report', hint: 'OPP-style report from the latest results', el: <MonitorReport /> },
              ]}
            />
          }
        />
        <Route
          path="request"
          element={
            <Section
              tabs={[
                { id: 'new', label: 'New request', el: <NewAcquisition /> },
                { id: 'list', label: 'My requests & projects', el: <Orders /> },
              ]}
            />
          }
        />
        <Route
          path="data"
          element={
            <Section
              tabs={[
                { id: 'catalog', label: 'Satellite catalogue', el: <SatelliteCatalog /> },
                { id: 'providers', label: 'Imagery providers', el: <ProviderMarketplace /> },
                { id: 'admin', label: 'Administration', el: <Admin /> },
              ]}
            />
          }
        />
        {/* old addresses */}
        <Route path="imaging" element={<Moved to="/track" tab="imaging" />} />
        <Route path="passes" element={<Moved to="/track" tab="passes" />} />
        <Route path="coverage" element={<Moved to="/track" tab="coverage" />} />
        <Route path="imagery" element={<Moved to="/gis" tab="search" />} />
        <Route path="analysis" element={<Moved to="/gis" tab="compare" />} />
        <Route path="acquire" element={<Moved to="/request" tab="new" />} />
        <Route path="orders" element={<Moved to="/request" tab="list" />} />
        <Route path="catalog" element={<Moved to="/data" tab="catalog" />} />
        <Route path="providers" element={<Moved to="/data" tab="providers" />} />
        <Route path="admin" element={<Moved to="/data" tab="admin" />} />
        <Route path="*" element={<Home />} />
      </Route>
    </Routes>
  );
}
