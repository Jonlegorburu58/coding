/**
 * Portal build only: answers the dashboard's `/api/*` calls inside the page by
 * patching `fetch`, using the same handlers as the mock (src/mocks/handlers.ts)
 * over the imported dataset. Every other request is refused without touching
 * the network, so imported data cannot leave the tab (D216).
 */
import { getResponse } from 'msw';
import type { ControlDef } from '../api/types';
import { CATALOGUE, CONTROL_IDS, SEVERITY_DEFAULTS, THRESHOLD_DEFAULTS, describe } from './engine';
import { handlers, mockState, resetMockState } from '../mocks/handlers';
import { setDataset, type MockDataset } from '../mocks/dataset';
import type { PortalDataset } from './build';

/** Never contacted: requests are rewritten to this origin only so handler paths match on any host (file://, sandboxed frames). */
const LOCAL_ORIGIN = 'http://portal.invalid';

export function emptyDataset(): MockDataset {
  const controls: ControlDef[] = CONTROL_IDS.map((id) => ({
    id, name: CATALOGUE[id][0], category: CATALOGUE[id][1], description: describe(id, THRESHOLD_DEFAULTS),
    severity: SEVERITY_DEFAULTS[id], basis: 'imanage_filing', configured: false,
  }));
  return {
    matters: [], controls,
    filters: { practice_areas: [], partners: [], fee_earners: [], offices: [], opened_range: { min: null, max: null } },
    now: new Date(), coverage: { libraries: 0, workspaces_visible: 0, documents: 0 },
    coverageNote: 'No file has been imported yet.', sourceName: 'No file imported', userDisplayName: 'You',
    trend: () => [], backendScopes: true,
  };
}

/** Serve an imported dataset, or nothing (`null`). */
export function applyImport(ds: PortalDataset | null) {
  setDataset(ds ?? emptyDataset());
  mockState.hasData = Boolean(ds);
  mockState.lastSyncAt = ds ? ds.importedAt : null;
  mockState.last = null;
}

/** The path of an `/api/` request, or null. Tolerates Windows file URLs (file:///C:/api/...). */
export function apiPath(input: RequestInfo | URL): string | null {
  let u: URL;
  try {
    const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    u = new URL(raw, window.location.href);
  } catch {
    return null;
  }
  const path = u.pathname.replace(/^\/[A-Za-z]:(?=\/)/, '');
  return path.startsWith('/api/') ? path + u.search : null;
}

let installed = false;

export function startPortalApi() {
  resetMockState('default', 0);
  applyImport(null);
  mockState.signedIn = true;
  if (installed) return;
  installed = true;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = apiPath(input);
    if (path === null) throw new TypeError('Network access is switched off in the portal: data stays in this tab.');
    const src = input instanceof Request ? input : null;
    const request = new Request(LOCAL_ORIGIN + path, {
      method: init?.method ?? src?.method ?? 'GET',
      headers: init?.headers ?? src?.headers,
      body: init?.body ?? null,
      signal: init?.signal ?? src?.signal ?? null,
    });
    const response = await getResponse(handlers, request, { baseUrl: `${LOCAL_ORIGIN}/` });
    return response ?? Response.json({ code: 'not_found', message: 'That information is not available in the portal.' }, { status: 404 });
  };
}
