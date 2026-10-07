# Build brief: frontend (agent 3)

Build `dms-analytics/frontend/` against `api-contract.yaml` only. The
ground rules are in `agents/dms-analytics/README.md`, and your general
instructions are in `agents/dms-analytics/03-frontend-engineer.md`. The
user is the firm's **General Counsel**: the tool must read like a calm,
authoritative risk dashboard, not a developer tool.

## Stack
React 19, Vite, TypeScript (strict), React Router, TanStack Query, and
Recharts (D10). Use `openapi-typescript` to generate types from
`../../docs/dms-analytics/api-contract.yaml`, MSW for mocks, Vitest and
Testing Library, and Playwright (Chromium is pre-installed at
`/opt/pw-browsers`; don't run `playwright install`). Keep it
self-contained in its folder with its own `package.json`. Add
`dms-analytics/**` to the root `eslint.config.js` ignores, the only edit
allowed outside the folder.

## API usage
- Use same-origin relative URLs (`/api/...`). The backend serves the
  built UI. In dev, Vite proxies `/api` and `/launch` to
  `http://127.0.0.1:8765`.
- Send `credentials: 'same-origin'` and the header `X-DMS-Analytics: 1`
  on every call. Store no token anywhere.
- On `401`, show a "Session expired. Close this window and reopen the
  app" screen.
- Mock mode: `npm run dev:mock` starts MSW handlers that return
  contract-valid synthetic data (fictional names, about 400 matters),
  with enough variety for every screen and state.

## Screens

1. **Portfolio** (home):
   - A KPI row: readiness %, open matters, high-risk matters, open
     exceptions, key dates in the next 30 days.
   - A **control compliance bar list**: each control's compliance rate,
     with stacked late, missing and stale counts. Clicking one goes to
     its exceptions.
   - A **heatmap**: rows by the chosen dimension (practice area, partner,
     fee earner, office), columns by control, cells showing the compliance
     rate. Clicking a cell opens the filtered matter list.
   - A **readiness trend** line chart.
   - A coverage banner ("Based on N workspaces visible to you…") and the
     last-synced time. These are always visible.
2. **Controls**: one page per control, with its definition, basis
   ("iManage filing evidence: shows whether evidence is on file, not
   whether the step happened"), tally, breakdown and trend.
3. **Exceptions**: a filterable, sortable table (control, status,
   practice area, partner, fee earner) with an explanation column and CSV
   export.
4. **Matters**: search and filters, sorted by risk by default, with risk
   score badges. The **matter detail** page shows its profile, control
   results (status pill and plain-English explanation, with evidence
   document names and dates), a timeline of key filing events, and
   document-type counts.
5. **Key dates**: next 30, 60 or 90 days, in a table.
6. **Lexcel sampling**: choose matters per fee earner and an optional
   seed, then generate. The table is grouped by fee earner. The seed is
   shown prominently. Export as CSV, and print-friendly.
7. **Sync and settings**:
   - Sign-in state, with a "Sign in to iManage" button. Handle the
     `device_code` response by showing the code and URL clearly.
   - Start, full and reconcile sync buttons, with a live progress bar
     (poll `/api/sync/status` every 2 seconds while running) and a cancel
     button.
   - Retention days and sample size.
   - **Wipe local data**: the user must type `WIPE` to confirm.
   - Sign out.
   - **About this app**: read-only, metadata only, stored on this laptop,
     no cloud.

**Global**: a left navigation; a filter bar (practice area, partner, fee
earner, office, status, opened range) shared across portfolio screens and
kept in the URL query string; a mode badge ("Demo data" in mock mode, in
amber).

## UX and design
- A restrained, professional look. Neutral greys and one accent colour.
  Status colours must be colour-blind safe and always paired with a text
  label or icon (pass, late, missing, stale, pending, n/a, unknown).
- Light and dark themes (following the system). WCAG 2.2 AA. Fully
  keyboard navigable. Charts get titles, axis labels with units, and a
  data-table alternative ("View as table").
- Empty state: "No data yet. Run your first sync." Errors use the API's
  `message`, which is plain English.
- All DMS strings are rendered as text. Never use
  `dangerouslySetInnerHTML`. Bundle fonts locally, or use the system
  font stack. Make no external requests. Add a CSP `<meta>`:
  `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'`.

## Acceptance
- `npm run build` outputs to `dist/`. Document how to copy it into
  `../backend/src/dms_analytics/static/` (`npm run build:embed`).
- `npm test` (Vitest) is green, and covers each screen's loading, empty,
  error and data states.
- `npm run e2e` (Playwright against `dev:mock`) runs: portfolio, then a
  heatmap cell, then the matter list, then a matter detail page, then a
  Lexcel sample, then a CSV export.
- `npm run lint` and `tsc --noEmit` are clean.
- Save screenshots (in mock mode) of every main screen to
  `dms-analytics/frontend/screenshots/`.
- Record decisions as D2xx in `docs/dms-analytics/DECISIONS.md`. List
  contract gaps rather than inventing endpoints.
