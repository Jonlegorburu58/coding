import { setupWorker } from 'msw/browser';
import { handlers, resetMockState, type MockScenario } from './handlers';

const SCENARIOS: MockScenario[] = ['default', 'empty', 'expired', 'device', 'syncing', 'error'];

/** Starts the mock API in the browser. `?mock=<scenario>` picks a demo state (mock mode only). */
export async function startMockApi() {
  const requested = new URLSearchParams(window.location.search).get('mock') as MockScenario | null;
  resetMockState(requested && SCENARIOS.includes(requested) ? requested : 'default', 150);
  const worker = setupWorker(...handlers);
  await worker.start({
    quiet: true,
    serviceWorker: { url: '/mockServiceWorker.js' },
    onUnhandledRequest: (req, print) => {
      if (new URL(req.url).pathname.startsWith('/api/')) print.warning();
    },
  });
}
