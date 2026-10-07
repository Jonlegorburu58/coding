# BWS DMS Risk Analytics: user interface

The screens for the read-only iManage risk dashboard. It is a React app
built with Vite and TypeScript. It talks only to the local analytics API on
`127.0.0.1`, which serves the built files. It reads no document contents,
stores no tokens and makes no external requests.

The interface is defined by `../../docs/dms-analytics/api-contract.yaml`.
The decisions behind this app are recorded as D201 to D212 in
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
