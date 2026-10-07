/**
 * MSW handlers implementing api-contract.yaml with synthetic data.
 * Responses are typed with the generated contract types so they stay contract-valid.
 */
import { http, HttpResponse, delay, type JsonBodyType } from 'msw';
import type {
  ApiErrorBody,
  Breakdown,
  BreakdownRow,
  ControlTally,
  Dimension,
  ExceptionItem,
  ExceptionPage,
  Filters,
  Health,
  KeyDate,
  LexcelSample,
  MatterPage,
  MatterSummary,
  PortfolioSummary,
  Session,
  Settings,
  SignInStart,
  SyncRun,
  SyncStatus,
  Trend,
} from '../api/types';
import { MOCK_NOW, mulberry32, toDetail, toSummary, type MockMatter } from './data';
import { currentDataset as ds, setDataset } from './dataset';

export type MockScenario = 'default' | 'empty' | 'expired' | 'device' | 'syncing' | 'error';

interface MockState {
  scenario: MockScenario;
  signedIn: boolean;
  hasData: boolean;
  lastSyncAt: string | null;
  settings: Settings;
  running: (SyncRun & { startedMs: number; cancelRequested: boolean }) | null;
  last: SyncRun | null;
  runCounter: number;
  /** Simulated latency for every response (ms). */
  latency: number;
}

const syncTotal = () => ds().matters.length;
/** A mock sync takes about 8 seconds. */
const SYNC_MS = 8000;

function initialState(scenario: MockScenario = 'default'): MockState {
  const hasData = scenario !== 'empty';
  return {
    scenario,
    signedIn: scenario !== 'device' && scenario !== 'empty',
    hasData,
    lastSyncAt: hasData ? MOCK_NOW.toISOString() : null,
    settings: {
      retention_days: 30,
      sample_per_fee_earner: 2,
      controls_file: '%APPDATA%\\BWS\\DmsAnalytics\\controls.yaml',
      controls_loaded_at: MOCK_NOW.toISOString(),
    },
    running: null,
    last: hasData
      ? {
          id: 'run_041', kind: 'incremental', status: 'succeeded', started_at: '2026-10-06T20:55:00Z',
          finished_at: MOCK_NOW.toISOString(), workspaces_done: syncTotal(), workspaces_total: syncTotal(),
          documents_seen: 1203, error: null,
        }
      : null,
    runCounter: 41,
    latency: 0,
  };
}

export const mockState: MockState = initialState();

export function resetMockState(scenario: MockScenario = 'default', latency = 0) {
  setDataset(null);
  Object.assign(mockState, initialState(scenario), { latency });
  if (scenario === 'syncing') startRun('full', Date.now() - SYNC_MS * 0.42);
}

function startRun(kind: SyncRun['kind'], startedMs = Date.now()) {
  mockState.runCounter += 1;
  mockState.running = {
    id: `run_${String(mockState.runCounter).padStart(3, '0')}`,
    kind,
    status: 'running',
    started_at: new Date(startedMs).toISOString(),
    finished_at: null,
    workspaces_done: 0,
    workspaces_total: syncTotal(),
    documents_seen: 0,
    error: null,
    startedMs,
    cancelRequested: false,
  };
}

function strip(run: NonNullable<MockState['running']>): SyncRun {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { startedMs, cancelRequested, ...rest } = run;
  return rest;
}

/** Advance the simulated sync based on wall-clock time. */
function syncStatus(): SyncStatus {
  const run = mockState.running;
  if (run) {
    const frac = Math.min(1, (Date.now() - run.startedMs) / SYNC_MS);
    run.workspaces_done = Math.floor(frac * syncTotal());
    run.documents_seen = Math.floor(frac * (run.kind === 'full' ? 38410 : 1300));
    if (run.cancelRequested) {
      mockState.last = { ...strip(run), status: 'cancelled', finished_at: new Date().toISOString() };
      mockState.running = null;
    } else if (frac >= 1) {
      mockState.last = { ...strip(run), status: 'succeeded', finished_at: new Date().toISOString() };
      mockState.running = null;
      mockState.hasData = true;
      mockState.lastSyncAt = new Date().toISOString();
    }
  }
  const current = mockState.running;
  return {
    state: current ? (current.cancelRequested ? 'cancelling' : 'running') : 'idle',
    current: current ? strip(current) : null,
    last: mockState.last,
  };
}

const json = <T extends JsonBodyType>(body: T, init?: ResponseInit) => HttpResponse.json(body, init);
const err = (status: number, code: string, message: string) =>
  HttpResponse.json<ApiErrorBody>({ code, message }, { status });

async function gate(): Promise<Response | null> {
  if (mockState.latency) await delay(mockState.latency);
  if (mockState.scenario === 'expired') return err(401, 'unauthorized', 'Session expired.');
  return null;
}

type Q = URLSearchParams;

function scoped(q: Q, opts: { ignoreStatus?: boolean } = {}): MockMatter[] {
  if (!mockState.hasData) return [];
  const pa = q.get('practice_area');
  const partner = q.get('partner_id');
  const fe = q.get('fee_earner_id');
  const office = q.get('office');
  const status = opts.ignoreStatus ? 'all' : (q.get('status') ?? 'open');
  const from = q.get('opened_from');
  const to = q.get('opened_to');
  return ds().matters.filter((m) =>
    (!pa || m.practice_area === pa) &&
    (!partner || m.partner?.id === partner) &&
    (!fe || m.fee_earner?.id === fe) &&
    (!office || m.office === office) &&
    (status === 'all' || m.status === status) &&
    (!from || m.opened_at.slice(0, 10) >= from) &&
    (!to || m.opened_at.slice(0, 10) <= to),
  );
}

function tally(ms: MockMatter[], controlId: string): ControlTally {
  const t: ControlTally = { control_id: controlId, applicable: 0, pass: 0, late: 0, missing: 0, stale: 0, pending: 0,
    not_applicable: 0, unknown: 0, compliance_rate: null };
  for (const m of ms) {
    const c = m.controls.find((x) => x.control_id === controlId);
    if (!c) continue;
    t[c.status] += 1;
  }
  t.applicable = t.pass + t.late + t.missing + t.stale + t.pending;
  const den = t.pass + t.late + t.missing + t.stale;
  t.compliance_rate = den ? Math.round((1000 * t.pass) / den) / 1000 : null;
  return t;
}

function readiness(ms: MockMatter[]): number | null {
  const vals = ms.map((m) => m.risk_score).filter((x): x is number => x !== null);
  if (!vals.length) return null;
  return Math.round((10 * vals.reduce((a, r) => a + (100 - r), 0)) / vals.length) / 10;
}

function daysUntil(date: string): number {
  const now = ds().now;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.parse(`${date}T00:00:00Z`) - today) / 86_400_000);
}

function paginate<T>(items: T[], q: Q) {
  const page = Math.max(1, Number(q.get('page') ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(q.get('page_size') ?? 50) || 50));
  return { total: items.length, page, page_size: pageSize, items: items.slice((page - 1) * pageSize, page * pageSize) };
}

const pick = (q: Q, keys: string[]) =>
  Object.fromEntries(keys.flatMap((k) => (q.get(k) ? [[k, q.get(k)!]] : [])));

const cmpNullLast = (a: number | null, b: number | null, dir: 1 | -1) =>
  a === null ? 1 : b === null ? -1 : (a - b) * dir;

export const handlers = [
  http.get('/api/health', async () => json<Health>({ status: 'ok', version: '1.0.0-mock', mode: 'mock' })),

  http.get('/api/session', async () => {
    const g = await gate(); if (g) return g;
    syncStatus();
    return json<Session>({
      mode: 'mock',
      signed_in: mockState.signedIn,
      user_display_name: mockState.signedIn ? ds().userDisplayName : null,
      source_name: ds().sourceName,
      has_data: mockState.hasData,
      last_sync_at: mockState.lastSyncAt,
      coverage: mockState.hasData
        ? ds().coverage
        : { libraries: 0, workspaces_visible: 0, documents: 0 },
    });
  }),

  http.post('/api/auth/sign-in', async () => {
    const g = await gate(); if (g) return g;
    if (mockState.scenario === 'device' && !mockState.signedIn) {
      // Demonstrates the device-code flow; the next session poll shows signed in.
      setTimeout(() => { mockState.signedIn = true; }, 4000);
      return json<SignInStart>({ status: 'device_code', verification_url: 'https://imanage.example.invalid/device', user_code: 'DEMO-4821' });
    }
    mockState.signedIn = true;
    return json<SignInStart>({ status: 'signed_in', verification_url: null, user_code: null });
  }),

  http.post('/api/auth/sign-out', async () => {
    const g = await gate(); if (g) return g;
    mockState.signedIn = false;
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('/api/sync/status', async () => {
    const g = await gate(); if (g) return g;
    return json<SyncStatus>(syncStatus());
  }),

  http.post('/api/sync/start', async ({ request }) => {
    const g = await gate(); if (g) return g;
    if (!mockState.signedIn) return err(409, 'not_signed_in', 'Sign in to iManage before starting a sync.');
    if (syncStatus().state !== 'idle') return err(409, 'sync_running', 'A sync is already running. Wait for it to finish, or cancel it.');
    let kind: 'auto' | 'full' | 'reconcile' = 'auto';
    try { kind = ((await request.json()) as { kind?: typeof kind })?.kind ?? 'auto'; } catch { /* empty body */ }
    startRun(kind === 'auto' ? (mockState.hasData ? 'incremental' : 'full') : kind);
    return json<SyncStatus>(syncStatus(), { status: 202 });
  }),

  http.post('/api/sync/cancel', async () => {
    const g = await gate(); if (g) return g;
    if (!mockState.running) return err(409, 'no_sync_running', 'There is no sync running to cancel.');
    mockState.running.cancelRequested = true;
    return new HttpResponse(null, { status: 202 });
  }),

  http.get('/api/filters', async () => {
    const g = await gate(); if (g) return g;
    return json<Filters>(mockState.hasData ? ds().filters : {
      practice_areas: [], partners: [], fee_earners: [], offices: [], opened_range: { min: null, max: null },
    });
  }),

  http.get('/api/controls', async () => {
    const g = await gate(); if (g) return g;
    return json(ds().controls);
  }),

  http.get('/api/portfolio/summary', async ({ request }) => {
    const g = await gate(); if (g) return g;
    if (mockState.scenario === 'error') return err(500, 'internal', 'The analytics database could not be read. Try restarting the app.');
    const q = new URL(request.url).searchParams;
    const ms = scoped(q);
    const all = scoped(q, { ignoreStatus: true });
    const kd = (n: number) => ms.filter((m) => m.key_date && daysUntil(m.key_date) >= 0 && daysUntil(m.key_date) <= n).length;
    return json<PortfolioSummary>({
      scope: { matters: ms.length, open_matters: (q.get('status') === 'all' ? all : ms).filter((m) => m.status === 'open').length },
      readiness: readiness(ms),
      high_risk_matters: ms.filter((m) => (m.risk_score ?? 0) >= 50).length,
      exceptions_open: ms.reduce((a, m) => a + m.failing_controls.length, 0),
      upcoming_key_dates: { d30: kd(30), d60: kd(60), d90: kd(90) },
      controls: ds().controls.map((c) => tally(ms, c.id)),
      coverage_note: mockState.hasData
        ? ds().coverageNote
        : 'No workspaces have been synced yet.',
    });
  }),

  http.get('/api/portfolio/breakdown', async ({ request }) => {
    const g = await gate(); if (g) return g;
    const q = new URL(request.url).searchParams;
    const dim = q.get('dimension') as Dimension | null;
    const keyOf: Record<Dimension, (m: MockMatter) => [string, string] | null> = {
      practice_area: (m) => (m.practice_area ? [m.practice_area, m.practice_area] : null),
      partner: (m) => (m.partner ? [m.partner.id, m.partner.name] : null),
      fee_earner: (m) => (m.fee_earner ? [m.fee_earner.id, m.fee_earner.name] : null),
      office: (m) => (m.office ? [m.office, m.office] : null),
      opened_month: (m) => [m.opened_at.slice(0, 7), m.opened_at.slice(0, 7)],
    };
    if (!dim || !(dim in keyOf)) return err(400, 'invalid_request', 'Choose how to group the heatmap.');
    const groups = new Map<string, { label: string; ms: MockMatter[] }>();
    for (const m of scoped(q)) {
      const k = keyOf[dim](m);
      if (!k) continue;
      const gEntry = groups.get(k[0]) ?? { label: k[1], ms: [] };
      gEntry.ms.push(m);
      groups.set(k[0], gEntry);
    }
    const rows: BreakdownRow[] = [...groups.entries()]
      .sort((a, b) => a[1].label.localeCompare(b[1].label))
      .map(([key, { label, ms }]) => ({
        key, label, matters: ms.length, readiness: readiness(ms),
        cells: ds().controls.map((c) => {
          const t = tally(ms, c.id);
          return { control_id: c.id, applicable: t.applicable, passing: t.pass, compliance_rate: t.compliance_rate };
        }),
      }));
    return json<Breakdown>({ dimension: dim, rows });
  }),

  http.get('/api/portfolio/trend', async ({ request }) => {
    const g = await gate(); if (g) return g;
    const q = new URL(request.url).searchParams;
    const id = q.get('control_id') || 'ALL';
    const from = q.get('from');
    const to = q.get('to');
    const points = mockState.hasData
      ? ds().trend(id).filter((p) => (!from || p.taken_at.slice(0, 10) >= from) && (!to || p.taken_at.slice(0, 10) <= to))
      : [];
    return json<Trend>({ control_id: id, points });
  }),

  http.get('/api/matters', async ({ request }) => {
    const g = await gate(); if (g) return g;
    const q = new URL(request.url).searchParams;
    const text = (q.get('q') ?? '').trim().toLowerCase();
    const failing = q.get('failing_control');
    const minRisk = q.get('min_risk') ? Number(q.get('min_risk')) : null;
    const sort = q.get('sort') ?? 'risk_desc';
    let ms = scoped(q).filter((m) =>
      (!text || [m.client_code, m.client_name, m.matter_code, m.matter_name].some((s) => s.toLowerCase().includes(text))) &&
      (!failing || m.failing_controls.includes(failing)) &&
      (minRisk === null || (m.risk_score ?? 0) >= minRisk),
    );
    const by: Record<string, (a: MockMatter, b: MockMatter) => number> = {
      risk_desc: (a, b) => cmpNullLast(a.risk_score, b.risk_score, -1) || a.matter_code.localeCompare(b.matter_code),
      risk_asc: (a, b) => cmpNullLast(a.risk_score, b.risk_score, 1) || a.matter_code.localeCompare(b.matter_code),
      opened_desc: (a, b) => b.opened_at.localeCompare(a.opened_at),
      opened_asc: (a, b) => a.opened_at.localeCompare(b.opened_at),
      activity_desc: (a, b) => (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? ''),
      activity_asc: (a, b) => (a.last_activity_at ?? '').localeCompare(b.last_activity_at ?? ''),
      matter_code: (a, b) => a.matter_code.localeCompare(b.matter_code),
    };
    ms = [...ms].sort(by[sort] ?? by.risk_desc);
    const p = paginate(ms, q);
    return json<MatterPage>({ ...p, items: p.items.map(toSummary) });
  }),

  http.get('/api/matters/:id', async ({ params }) => {
    const g = await gate(); if (g) return g;
    const m = mockState.hasData ? ds().matters.find((x) => x.id === params.id) : undefined;
    if (!m) return err(404, 'not_found', 'That matter could not be found. It may no longer be visible to you.');
    return json(toDetail(m));
  }),

  http.get('/api/exceptions', async ({ request }) => {
    const g = await gate(); if (g) return g;
    const q = new URL(request.url).searchParams;
    const control = q.get('control_id');
    const status = q.get('status');
    const sort = q.get('sort') ?? 'severity_desc';
    const items: ExceptionItem[] = [];
    for (const m of scoped(q, { ignoreStatus: !ds().backendScopes })) {
      for (const c of m.controls) {
        if (c.status !== 'late' && c.status !== 'missing' && c.status !== 'stale') continue;
        if (control && c.control_id !== control) continue;
        if (status && c.status !== status) continue;
        items.push({
          matter: toSummary(m), control_id: c.control_id, status: c.status,
          severity: ds().controls.find((d) => d.id === c.control_id)?.severity ?? 1,
          days_late: c.days_late ?? null, due_at: c.due_at ?? null, explanation: c.explanation ?? '',
        });
      }
    }
    const by: Record<string, (a: ExceptionItem, b: ExceptionItem) => number> = {
      severity_desc: (a, b) => b.severity - a.severity || (b.matter.risk_score ?? 0) - (a.matter.risk_score ?? 0) || a.matter.matter_code.localeCompare(b.matter.matter_code),
      days_late_desc: (a, b) => cmpNullLast(a.days_late ?? null, b.days_late ?? null, -1),
      opened_desc: (a, b) => b.matter.opened_at.localeCompare(a.matter.opened_at),
    };
    items.sort(by[sort] ?? by.severity_desc);
    return json<ExceptionPage>(paginate(items, q));
  }),

  http.get('/api/key-dates', async ({ request }) => {
    const g = await gate(); if (g) return g;
    const n = Number(new URL(request.url).searchParams.get('within_days') ?? 30);
    const out: KeyDate[] = scoped(new URLSearchParams())
      .filter((m) => m.key_date && daysUntil(m.key_date) >= 0 && daysUntil(m.key_date) <= n)
      .map((m) => ({ matter: toSummary(m), key_date: m.key_date!, days_until: daysUntil(m.key_date!) }))
      .sort((a, b) => a.days_until - b.days_until);
    return json(out);
  }),

  http.get('/api/lexcel/sample', async ({ request }) => {
    const g = await gate(); if (g) return g;
    const q = new URL(request.url).searchParams;
    const per = Math.min(10, Math.max(1, Number(q.get('per_fee_earner') ?? 2) || 2));
    const seed = q.get('seed') ? Number(q.get('seed')) : Math.floor(Math.random() * 900000) + 100000;
    const r = mulberry32(seed);
    const pool = ds().backendScopes ? scoped(new URLSearchParams({ ...pick(q, ['practice_area', 'office']), status: 'open' }))
      : scoped(q, { ignoreStatus: true });
    const items: LexcelSample['items'] = [];
    for (const fe of ds().filters.fee_earners) {
      let candidates = pool.filter((m) => m.fee_earner?.id === fe.id);
      const chosen: MatterSummary[] = [];
      while (chosen.length < per && candidates.length) {
        const weights = candidates.map((m) => 10 + (m.risk_score ?? 0));
        let x = r() * weights.reduce((a, b) => a + b, 0);
        let idx = 0;
        for (; idx < weights.length - 1; idx++) { x -= weights[idx]!; if (x <= 0) break; }
        chosen.push(toSummary(candidates[idx]!));
        candidates = candidates.filter((_, i) => i !== idx);
      }
      if (chosen.length) items.push({ fee_earner: fe, matters: chosen });
    }
    return json<LexcelSample>({ seed, per_fee_earner: per, generated_at: new Date().toISOString(), items });
  }),

  http.get('/api/settings', async () => {
    const g = await gate(); if (g) return g;
    return json<Settings>(mockState.settings);
  }),

  http.put('/api/settings', async ({ request }) => {
    const g = await gate(); if (g) return g;
    const body = (await request.json()) as Partial<Settings>;
    if (body.retention_days !== undefined && (body.retention_days < 1 || body.retention_days > 365))
      return err(400, 'invalid_request', 'Retention must be between 1 and 365 days.');
    if (body.sample_per_fee_earner !== undefined && (body.sample_per_fee_earner < 1 || body.sample_per_fee_earner > 10))
      return err(400, 'invalid_request', 'Sample size must be between 1 and 10 matters per fee earner.');
    mockState.settings = { ...mockState.settings, ...body };
    return json<Settings>(mockState.settings);
  }),

  http.post('/api/data/wipe', async ({ request }) => {
    const g = await gate(); if (g) return g;
    let body: { confirm?: boolean } = {};
    try { body = (await request.json()) as typeof body; } catch { /* empty */ }
    if (body.confirm !== true) return err(400, 'invalid_request', 'Wipe was not confirmed.');
    mockState.hasData = false;
    mockState.lastSyncAt = null;
    mockState.last = null;
    return new HttpResponse(null, { status: 204 });
  }),
];
