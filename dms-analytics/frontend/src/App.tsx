import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, HashRouter, Navigate, Route, Routes } from 'react-router';

// The demo build is hosted at an arbitrary path, so it routes by hash.
const Router = import.meta.env.MODE === 'demo' ? HashRouter : BrowserRouter;
import { QueryClientProvider, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { onSessionExpired } from './api/client';
import { makeQueryClient } from './queryClient';
import { Layout, RequireData } from './components/Layout';
import { SessionExpired } from './components/States';
import { PortfolioPage } from './pages/PortfolioPage';
import { ControlsPage } from './pages/ControlsPage';
import { ExceptionsPage } from './pages/ExceptionsPage';
import { MattersPage } from './pages/MattersPage';
import { MatterDetailPage } from './pages/MatterDetailPage';
import { KeyDatesPage } from './pages/KeyDatesPage';
import { LexcelPage } from './pages/LexcelPage';
import { SettingsPage } from './pages/SettingsPage';

/** Routes plus the global "session expired" gate. */
export function AppShell() {
  const [expired, setExpired] = useState(false);
  const qc = useQueryClient();
  useEffect(
    () =>
      onSessionExpired(() => {
        setExpired(true);
        qc.clear();
      }),
    [qc],
  );
  if (expired) return <SessionExpired />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<RequireData><PortfolioPage /></RequireData>} />
        <Route path="controls" element={<RequireData><ControlsPage /></RequireData>} />
        <Route path="controls/:controlId" element={<RequireData><ControlsPage /></RequireData>} />
        <Route path="exceptions" element={<RequireData><ExceptionsPage /></RequireData>} />
        <Route path="matters" element={<RequireData><MattersPage /></RequireData>} />
        <Route path="matters/:matterId" element={<RequireData><MatterDetailPage /></RequireData>} />
        <Route path="key-dates" element={<RequireData><KeyDatesPage /></RequireData>} />
        <Route path="lexcel" element={<RequireData><LexcelPage /></RequireData>} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function Providers({ children, client }: { children: ReactNode; client?: QueryClient }) {
  const [qc] = useState(() => client ?? makeQueryClient());
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

export function App() {
  return (
    <Providers>
      <Router>
        <AppShell />
      </Router>
    </Providers>
  );
}
