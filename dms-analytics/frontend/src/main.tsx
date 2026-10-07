import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

async function boot() {
  // Mock mode only: the MSW worker is never bundled into the production build's entry path.
  if (import.meta.env.MODE === 'mock') {
    const { startMockApi } = await import('./mocks/browser');
    await startMockApi();
  }
  if (import.meta.env.MODE === 'demo') {
    const { startDemoApi } = await import('./mocks/demo');
    startDemoApi();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
