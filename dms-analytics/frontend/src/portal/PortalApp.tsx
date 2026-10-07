import { StrictMode, useState } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeQueryClient } from '../queryClient';
import { Layout, RequireData } from '../components/Layout';
import { PortfolioPage } from '../pages/PortfolioPage';
import { ControlsPage } from '../pages/ControlsPage';
import { ExceptionsPage } from '../pages/ExceptionsPage';
import { MattersPage } from '../pages/MattersPage';
import { MatterDetailPage } from '../pages/MatterDetailPage';
import { KeyDatesPage } from '../pages/KeyDatesPage';
import { LexcelPage } from '../pages/LexcelPage';
import { VariantProvider, type AppVariant } from '../lib/variant';
import { CopyCsvButton, PortalCoverage, PortalTopbar } from './chrome';
import { ImportPage } from './ImportPage';
import './portal.css';

const VARIANT: AppVariant = {
  ExportButton: CopyCsvButton,
  canPrint: false,
  topbar: <PortalTopbar />,
  coverage: <PortalCoverage />,
  appNav: { to: '/import', label: 'Import file', icon: 'upload' },
  sidenavFoot: <>Metadata only. Nothing is uploaded.<br />Data stays in this browser tab.</>,
  noData: <Navigate to="/import" replace />,
  singleSnapshot: {
    title: 'Trend needs more than one import',
    body: 'This page holds a single import, so there is only one snapshot (see "View as table"). A trend needs snapshots taken on different dates.',
  },
};

/** The portal: the dashboard over an imported export, with Import in place of Sync & settings. */
export function PortalShell() {
  return (
    <VariantProvider value={VARIANT}>
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
          <Route path="import" element={<ImportPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </VariantProvider>
  );
}

export function PortalApp() {
  const [qc] = useState(() => makeQueryClient());
  return (
    <StrictMode>
      <QueryClientProvider client={qc}>
        <HashRouter>
          <PortalShell />
        </HashRouter>
      </QueryClientProvider>
    </StrictMode>
  );
}
