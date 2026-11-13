import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Simple from './pages/Simple';
import { useLang } from './i18n';

/** One page: pick a target → before / after images → swipe in a band combination → change highlight → download. */
export default function App() {
  useEffect(() => useLang.getState().setLang('th'), []);
  return (
    <Routes>
      <Route index element={<Simple />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
