# Decision records

Short records: decision, alternatives considered, reason. Builders append
new records (D100+ for the backend, D200+ for the frontend) rather than
silently deviating from the design.

**D1: Use the official iManage Work REST API with delegated OAuth.**
Alternatives: direct database access, scraping, an IT export. The API is
supported, it respects the user's permissions and ethical walls, and IT can
audit it. An IT export remains the fallback, and the adapter layer allows
it.

**D2: Metadata only in phase 1. No document content and no AI.**
Alternative: reading content for classification and summaries. Metadata is
enough for evidence-on-file controls, it carries far less confidentiality
and GDPR risk, it gets IT approval faster, and it removes the risk of
prompt injection from document text. Content or AI features would need
their own approval and design.

**D3: A single local process. Python backend serves a static React UI in
the default browser.**
Alternatives: Electron, Tauri. On an IT-managed Windows laptop, one
PyInstaller bundle is the easiest thing for IT to package and approve.
There's no extra runtime (Electron) and no Rust or WebView toolchain
(Tauri). Edge is already present.

**D4: A DuckDB store, encrypted with a key held in Windows Credential
Manager.**
Alternatives: SQLite plus SQLCipher (needs native builds on Windows), or
relying on BitLocker alone. DuckDB is fast for portfolio aggregations, and
version 1.4 or later supports database encryption at `ATTACH`. If the
backend agent finds the encryption unusable, the fallback is BitLocker
plus the profile folder's ACLs. That fallback must be recorded here as
D1xx and called out in `IT-SETUP.md`.

**D5: Local API authentication uses a launch code, then an `HttpOnly`
`SameSite=Strict` cookie, plus a custom header, plus a `Host` check.**
Alternative: a bearer token in `localStorage`. A token in `localStorage`
can be read by any script. The cookie, header and Host combination defeats
CSRF and DNS-rebinding attacks from other web pages, without CORS.

**D6: Packaging with PyInstaller (a one-folder build), deployed by IT
through Intune.**
Alternative: a Python install on the laptop. The user can't install
software, and a self-contained bundle gives IT one artefact to scan and
sign.

**D7: Controls are defined in a configuration file (`controls.yaml`), not
in code.**
Alternative: hard-coding BWS's document classes. Class lists, thresholds
and field mappings are firm-specific and will be tuned by the risk team.
The engine stays generic.

**D8: Every result carries an evidence basis and the coverage is always
shown.**
This prevents over-reading: "missing on file" is not the same as "did not
happen", and "your visible workspaces" is not the same as "the whole firm".

**D9: Mock-first development.** Both builders work only against
`MockDmsAdapter` or contract mocks. No firm data enters the repository,
CI, or any agent's context.

**D10: The frontend uses React, Vite, TypeScript and Recharts, with an API
client typed from the contract.**
Recharts is mature, has no network dependencies, and is accessible enough
with the labels we specify. The frontend builder may record a different
choice as D2xx.

## Frontend (agent 3)

**D201: Recharts only for the line charts. The bar list and heatmap are
semantic HTML.**
Alternatives: Recharts for everything, or a heatmap library. Recharts has
no heatmap. Each heatmap cell and each control row must be a real
keyboard-focusable link or button that opens a filtered list. An HTML
`<table>` of buttons and a list of links do this natively, for screen
readers too. Recharts (D10) draws the trend lines, with its accessibility
layer turned on. Every chart has a "View as table" twin.

**D202: Colour scheme.** The UI uses neutral greys and one blue accent
(`#1c5cab` for light text, `#86b6ef` for dark text). Statuses use a fixed
palette: pass green, late amber, stale orange and missing red. Pending,
N/A and unknown are grey. Each status always comes with an icon and a
label. The stacked bars are ordered pass, late, missing, stale, which
keeps amber away from orange. The `dataviz` validator was run on that
order: worst adjacent colour-blind ΔE 11.3, and worst normal-vision ΔE
15.7, both passing. The lightness-band check flags amber, which is
expected for a status colour. The relief for that is the legend, the
labels, the tooltips and the table view. The heatmap uses a
seven-bin, single-hue blue scale. A stronger colour means lower
compliance, so problems stand out. In dark mode the scale's anchor flips.
Each cell's text colour is chosen for contrast of at least 4.5:1. Every
text token meets WCAG AA. Light and dark mode follow the system setting.

**D203: DMS text is plain text only.** There is no
`dangerouslySetInnerHTML` and no `innerHTML`; ESLint and a Vitest
source-scan enforce this. CSV export puts an apostrophe in front of any
cell starting with `= + - @`, tab or CR, which blocks formula injection
in Excel.

**D204: No browser storage.** All state is either in memory (TanStack
Query) or in the URL. Filters, the page number and the Lexcel window are
kept in the query string. The cache is cleared on sign-out, wipe and
`401`. ESLint bans `localStorage` and `sessionStorage`.

**D205: CSP and the dev server.** `index.html` ships the strict CSP from
the brief, plus `object-src 'none'`, `base-uri 'self'` and
`form-action 'self'`. Only `vite serve` relaxes `script-src` and
`connect-src` (for the React Refresh preamble and HMR websocket).
`npm run e2e:csp` checks that the built bundle runs under the strict
policy with no external requests.

**D206: The MSW mock exists only in mock builds.** It is loaded through
a dynamic import guarded by `import.meta.env.MODE === 'mock'`. The
service-worker file lives in `mock-public/`, which is the public
directory only in mock mode. `npm run build` contains no mock code. This
was checked with grep on `dist/`. Adding `?mock=<scenario>` in dev
selects the demo states.

**D207: CSV is saved where the user chooses.** In Edge and Chrome the
export uses the File System Access API `showSaveFilePicker`, which opens
a native "Save as" dialog. Other browsers fall back to the browser's own
download prompt. Exports of paged lists fetch every page at
`page_size=200`, capped at 20,000 rows.

**D208: Exceptions use a separate status parameter in the URL.** The
global filter `status` means matter status (open, closed or all). The
exception result filter (late, missing or stale) is kept as
`ex_status` and sent to the API as `status`. On the exceptions screen
the filter bar hides the matter-status and opened-date fields, because
`/api/exceptions` does not accept them (gap G1).

**D209: Sorting uses only the server's sort options.** Exceptions sort
by severity, days late or matter opened. Matters sort by risk, activity,
opened or matter code. The UI offers no client-side column sorting,
which would sort only the current page and mislead (gap G2).

**D210: Device-code and browser sign-in poll `/api/session` every 2
seconds** until `signed_in` becomes true. The contract has no
completion endpoint. The verification URL is shown as selectable text,
not a link.

**D211: The dev proxy uses `changeOrigin: true`.** The Host header then
reaches the backend as `127.0.0.1:8765`, which passes its Host check (D5).

**D212: Conservative choices made without user confirmation, because
the run was autonomous.** No endpoints were invented. Gaps are handled
in the UI as described in D208 and D209, and listed in the agent's
summary. Nothing is committed.

**D100: DuckDB encryption at rest works, so the D4 fallback is not used.**
DuckDB 1.4.1+ (1.5.6 locked) `ATTACH ... (ENCRYPTION_KEY ...)` is used
with a random 256-bit key (hex) stored only in the OS keychain (entry
`db-key`, service `bws-dms-analytics`). A test shows the file cannot be
opened without the key or with a wrong one. The SQL connection also turns
off extension auto-install and auto-load and external access, so SQL can
never reach files or the network. On non-Windows dev machines without a
keyring backend, mock mode keeps the key in a `0600` file. Live mode
refuses to run without a real keychain. `IT-SETUP.md` needs no change.

**D101: Foreign keys are logical, not declared.** DuckDB runs `UPDATE` as
delete plus insert, so declared foreign keys reject ordinary upserts of
parent rows. Deletes cascade in code (`Repo.delete_matters`).

**D102: Addition to data-model.md: `control_result.explanation TEXT`.**
It stores the plain-English explanation required by the brief. Nothing
else in the schema changes.

**D103: A lost database key resets the store.** If the database file
exists but its key is gone from the keychain, the file is unreadable. It
is only a cache of the DMS, so it is deleted and rebuilt on the next sync.

**D104: Document type mapping.** Each document gets one `canonical_type`:
the most specific matching rule wins (most matchers), then file order. So
ENGAGE plus SIGNED becomes `engagement_signed`, which also counts as an
engagement letter for EL1. EL2 passes on `engagement_signed`, or on an
`engagement_letter` whose name matches `signed_name_patterns`.
Optional `field_map` keys added: `fee_earner` (default: workspace owner),
`opened_at` and `closed_at`. Display names come from
`<field>_description`. Unrecognised status values count as `open`.

**D105: Two meanings of "applicable" (contract ambiguity, contract not
changed).** `ControlTally.applicable` follows the contract (pass, late,
missing, stale and pending). `BreakdownCell.applicable`, Trend points and
`portfolio_snapshot.applicable` mean the compliance denominator (pass,
late, missing and stale), so that `passing ÷ applicable` equals
`compliance_rate`. Snapshots cover open matters. Trend `value` is
readiness for `ALL`, otherwise compliance as a percentage (0–100).

**D106: Control interpretation (ARCHITECTURE §3 underspecified).**
- Dates are compared by calendar day, so "on or before" includes the same
  day.
- EL1 and EL2 are `pending` until 14 days after the first substantive
  document.
- AN1 "activity" means a substantive (non-intake) document edited in the
  window.
- FE2 applies whatever the matter status, because the rule is literally
  "active in 6 months". CD1 applies to all matters.
- HY1 returns `not_applicable` for closed matters. The catalogue lists
  only pass and stale.
- `missing` results carry `days_late` (days overdue) where a due date
  exists, so that "days late" sorting is meaningful.

**D107: Default scopes.** Exceptions, key dates and the Lexcel sample
cover open matters (none of these endpoints has a status parameter).
`exceptions_open` in the summary counts the failing results in the
filtered scope.

**D108: Routes outside the JSON contract.** These are `GET /auth/callback`
(the live-mode PKCE loopback redirect on the app's own port, protected by
the single-use `state` and the PKCE verifier rather than the cookie),
`GET /` and the SPA fallback. FastAPI's `/docs` and `/openapi.json` are
disabled.

**D109: Sync semantics.**
- A reconcile is a full re-listing, chosen automatically on every 7th
  sync (counted by run order).
- An incremental sync lists changed documents in every known workspace,
  because iManage workspace edit dates do not move when documents are
  added (VERIFY V4). This also refreshes `synced_at`, so retention purges
  only data not refreshed within `retention_days`.
- HTTP 403, 404 or 410 on any workspace means access was lost, and the
  workspace is deleted locally.
- The checkpoint is stored in `sync_run.checkpoint`. A failed or cancelled
  run resumes automatically, skipping finished workspaces.
- After each successful sync every matter is re-evaluated (time-based
  controls change daily), and evaluation also runs at startup.
- The 12-month snapshot backfill runs in mock mode only.

**D110: Contract gaps handled without changing the contract.** These are
proposed contract additions:
- `/api/health` inherits global security, so it returns 401 without the
  cookie and header, but the contract lists no 401 for it.
- Invalid `within_days` on `/api/key-dates` returns 400 Error.
- A live-mode sign-in failure on `/api/auth/sign-in` returns 409 Error
  with code `sign_in_failed`.
- `/launch` 403 returns a plain-text message for the browser.
- Error codes used: `sync_running`, `not_signed_in`, `controls_invalid`,
  `sync_not_running`, `invalid_request`, `not_found`, `unauthorized` and
  `bad_host`.

**D111: The mock starts signed in.** Sign-out and sign-in toggle it. Mock
mode never touches the keychain for tokens.

**D112: Contract tests validate responses with `jsonschema` against the
YAML itself.** OpenAPI 3.1 schemas are JSON Schema 2020-12, and
`openapi-spec-validator` also checks the file. This replaces openapi-core
and schemathesis. The test fails if any contract operation or status code
is not exercised, or if the app exposes a JSON route that is not in the
contract.

**D113: Logging is deny-by-default.** Only allow-listed keys holding
numbers or short identifiers are emitted. String `%` arguments and
exception messages are dropped, and token patterns are scrubbed.
Uvicorn's access log, which would print launch codes and search text, is
off. Requests are logged by route template.

**D114: iManage document listing walks the folder tree** (container
listing, up to 500 per call, as documented) and deduplicates by document
ID within a workspace. A document filed in two workspaces is stored once,
and the last listing wins (VERIFY). Bulk writes send rows as one JSON
parameter, because DuckDB's `executemany` takes about 1 ms per row.
