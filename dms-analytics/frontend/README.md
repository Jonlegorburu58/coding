# BWS DMS Risk Analytics: user interface

The screens for the read-only iManage risk dashboard. It is a React app
built with Vite and TypeScript. It talks only to the local analytics API on
`127.0.0.1`, which serves the built files. It reads no document contents,
stores no tokens and makes no external requests.

The interface is defined by `../../docs/dms-analytics/api-contract.yaml`.
The decisions behind this app are recorded as D201 to D219 in
`../../docs/dms-analytics/DECISIONS.md`.

## Screens

| Screen | Route | What it shows |
|--------|-------|---------------|
| Portfolio | `/` | Readiness, open matters, high-risk matters, open exceptions and key dates in the next 30 days. A control compliance bar list (select a row to see its exceptions), a heatmap by practice area, partner, fee earner or office (select a cell to see the failing matters), and the readiness trend |
| Controls | `/controls`, `/controls/:id` | Each control's definition, basis, result counts, compliance breakdown and trend |
| Exceptions | `/exceptions` | Late, missing and stale results with plain-English explanations. Can be filtered and exported |
| Matters | `/matters`, `/matters/:id` | Search, filters and risk badges, sorted by risk. The detail page shows the profile, control results with the evidence documents, a filing timeline and document types |
| Key dates | `/key-dates` | Key dates in the next 30, 60 or 90 days |
| Lexcel sampling | `/lexcel` | A seeded, reproducible file-review sample grouped by fee earner. It can be printed or exported |
| Sync & settings | `/settings` | Sign-in (including the device-code flow), sync start, full sync and access check with live progress and a cancel button, retention and sample size, wiping local data (you must type `WIPE`), sign-out and an "About this app" panel |

Every screen shows the coverage banner, the last-synced time and, in mock
mode, the "Demo data" badge. The filter bar keeps its
state in the URL. Every chart has a "View as table" option, and every
table or chart can be exported as CSV.

## Prerequisites

Node 20 or later, and npm. Run `npm install` once in this folder.

## Run against the mock (no backend, no firm data)

```bash
npm run dev:mock        # http://127.0.0.1:5174
```

This starts Mock Service Worker (MSW) handlers (`src/mocks/`) inside the
browser. They return synthetic data that matches the contract: about 412
fictional matters with names such as "Partner Alpha" and "Rowan Sample
Holdings DAC". Add `?mock=<scenario>` to the first URL to see a particular
state:

| Scenario | Shows |
|----------|-------|
| `empty` | First run: not signed in, with "No data yet. Run your first sync." |
| `syncing` | A full sync in progress, with a progress bar and cancel button |
| `device` | The device-code sign-in flow |
| `expired` | Every call returns `401`, so the "Session expired" screen appears |
| `error` | The portfolio summary returns a server error |

The mock is used only by `dev:mock` and `build:mock`. The production
build (`npm run build`) contains neither MSW nor the synthetic data.

## Portal (export & upload)

The portal is a single HTML file that runs the 11 controls on a file you
export from iManage Work yourself. It needs no backend, no installation
and no network connection. It is described in D213 to D219.

```bash
npm run build:portal    # type-checks, then writes dist-portal/index.html (about 1.6 MB)
npm run e2e:portal      # builds it, then runs the file:// smoke test (Playwright)
npm run parity:fixture  # regenerates the engine parity fixture from the Python engine
```

### 1. Export from iManage Work (web)

Menu names vary between iManage versions and library configurations.

1. Run a document search that covers the matters you want to review, for
   example by client, by matter or by a date range.
2. Show the columns you need. At least these: **Name** (or Description),
   **Number**, **Version**, **Class**, **Subclass**, **Created**,
   **Edited**, **Client** and **Matter**. Add **Workspace**, **Author** and
   **Operator** if you have them.
3. Select the results (Select all), then choose **Export** and save the file
   as Excel (.xlsx) or CSV. Export may sit under **More** or the **…** menu.
4. Optional: export a matter or workspace list with client, matter, matter
   name, practice area, partner, responsible fee earner, office, status, open
   and close dates, matter type and key date. Without it, opening dates come
   from the earliest document, every matter counts as open, profile fields
   show "Unassigned" and CD1 is Unknown.

The export contains only what your own iManage access rights let you see.

### 2. Open the portal locally

Copy `dist-portal/index.html` to your laptop and double-click it. It opens in
Edge from `file://`. Drop the export on **Document list** (and optionally the
matter list), or select **Load sample export** to try it with an invented
firm. Then:

1. **Match columns.** Columns are suggested from the header names and can be
   corrected. The date format is detected; day first (31/01/2026) is the
   default. A preview of 5 rows and a count of unreadable dates show what will
   be read.
2. **Document types.** Assign each class (and class + subclass) to a control
   document type, add name rules (for example, a name containing "attendance
   note"), and adjust the thresholds.
3. **Run.** The dashboard (Portfolio, Controls, Exceptions, Matters, Key
   dates, Lexcel sampling) opens on your data.

The same file can also be hosted as a private page. It needs no service
worker, downloads, `confirm()`, printing or external requests.

### Privacy model

- The file is read inside the browser tab. Nothing is uploaded or sent
  anywhere. The page's Content Security Policy blocks every connection
  (`connect-src 'none'`), and its in-page API refuses any request that is
  not its own.
- Imported rows are held in memory only. Closing or reloading the tab, or
  selecting **Clear data**, discards them. They are never written to
  localStorage, sessionStorage or IndexedDB.
- Only the settings are remembered in the browser: column mapping,
  document-type mapping and thresholds. Use **Copy settings** and **Paste
  settings** to share them with a colleague. They contain no rows.
- All imported text is shown as plain text. Exports are **Copy as CSV**
  (clipboard), with the same protection against spreadsheet formula
  injection as the app's CSV export.
- Results show filing evidence in the export, not whether a step happened.
  An export can also lack things that the API sync provides: workspace
  creation dates and profile fields (unless you add a matter list), every
  document version, folder-level filing, documents you cannot see, and
  trends, because each import is a single snapshot.

## Run against the local backend

1. Start the backend (see `../backend/README.md`). It listens on
   `http://127.0.0.1:8765`.
2. Run `npm run dev` in this folder. The UI is at
   `http://127.0.0.1:5173`, and Vite forwards `/api` and `/launch` to
   the backend.
3. Get a launch URL from the backend and replace its host with
   `127.0.0.1:5173`, for example
   `http://127.0.0.1:5173/launch?code=…`. The backend sets the session
   cookie through the proxy and redirects you to the UI.

Every request is a same-origin `/api/...` call with
`credentials: 'same-origin'` and the header `X-DMS-Analytics: 1`. The
session is an `HttpOnly` cookie that this code never sees. A `401`
response shows "Session expired. Close this window and reopen the app."

## Build and install on the laptop

```bash
npm run build           # type-checks, then writes dist/
npm run build:embed     # build + copy dist/ into ../backend/src/dms_analytics/static/
```

`build:embed` replaces the backend's `static/` folder with the new build.
The backend's PyInstaller step then bundles it into `dms-analytics.exe`.
That executable is the only thing installed on the laptop (IT deploys it
through Intune), so you never install the UI separately. You open the
app from the Start menu, and the launcher opens your browser at the
one-time launch URL.

## Quality checks

```bash
npm run typecheck       # tsc --noEmit (strict)
npm run lint            # ESLint, also bans dangerouslySetInnerHTML/innerHTML and browser storage
npm test                # Vitest + Testing Library: every screen's loading, empty, error and data states
npm run e2e             # Playwright journey against dev:mock
npm run e2e:csp         # Playwright: the built bundle runs under the strict CSP with no external requests
npm run screenshots     # Regenerates screenshots/ (mock mode, light and dark)
npm run gen:api         # Regenerates src/api/schema.d.ts from the contract
```

Playwright uses the Chromium already installed under `/opt/pw-browsers`,
or wherever `PLAYWRIGHT_BROWSERS_PATH` points. `@playwright/test` is
pinned to 1.56 to match that browser build.

## Security notes

- **CSP.** `index.html` sets
  `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'`
  in every build. The Vite dev server alone relaxes it to allow inline
  scripts for hot reload.
- **No external assets.** The app uses the system font stack and inline
  SVG icons, with no CDN, web font, analytics or error-reporting service.
- **DMS text is untrusted.** Every DMS string is rendered as React text.
  CSV export puts an apostrophe in front of any cell that a spreadsheet
  would treat as a formula.
- **Nothing is cached outside memory.** The app writes nothing to
  `localStorage`, `sessionStorage` or IndexedDB. Sign-out, wipe and
  session expiry clear the in-memory query cache.
- **You choose where CSV files go.** Edge and Chrome show a native "Save
  as" dialog. Other browsers use their own download prompt.
