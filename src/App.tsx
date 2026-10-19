import { useEffect } from 'react';
import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
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
import { refreshOrbits } from './lib/orbitLoader';
import { useLang } from './i18n';

export default function App() {
  const lang = useLang((s) => s.lang);
  useEffect(() => {
    void refreshOrbits();
  }, []);
  return (
    <Routes key={lang}>
      <Route element={<Layout />}>
        <Route index element={<MissionControl />} />
        <Route path="imaging" element={<ImagingView />} />
        <Route path="passes" element={<PassTracker />} />
        <Route path="imagery" element={<ImageryExplorer />} />
        <Route path="acquire" element={<NewAcquisition />} />
        <Route path="catalog" element={<SatelliteCatalog />} />
        <Route path="providers" element={<ProviderMarketplace />} />
        <Route path="coverage" element={<CoveragePlanner />} />
        <Route path="analysis" element={<ImageAnalysis />} />
        <Route path="orders" element={<Orders />} />
        <Route path="admin" element={<Admin />} />
        <Route path="*" element={<MissionControl />} />
      </Route>
    </Routes>
  );
}
