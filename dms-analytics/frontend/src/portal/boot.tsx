import { createRoot } from 'react-dom/client';
import { PortalApp } from './PortalApp';
import { startPortalApi } from './shim';

export function startPortal(root: HTMLElement) {
  startPortalApi();
  createRoot(root).render(<PortalApp />);
}
