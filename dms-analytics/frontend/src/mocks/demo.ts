import { getResponse } from 'msw';
import { handlers, resetMockState } from './handlers';

/**
 * Demo build only: answers `/api/*` calls in-page by patching `fetch`, for hosts
 * where service workers are unavailable (e.g. a sandboxed preview frame).
 * Never part of the production build.
 */
export function startDemoApi() {
  resetMockState('default', 150);
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), window.location.href), init);
    if (new URL(request.url).pathname.startsWith('/api/')) {
      const response = await getResponse(handlers, request);
      if (response) return response;
    }
    return realFetch(input, init);
  };
}
