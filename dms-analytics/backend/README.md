# BWS DMS Risk Analytics: backend

A read-only connector, local store, controls engine and local API that
implements `docs/dms-analytics/ARCHITECTURE.md`, `data-model.md` and
`api-contract.yaml`. It runs as a single process on the GC's laptop, listens
on `127.0.0.1` only, and serves the React UI as static files.

**Mock mode is the default.** Everything in this repository (code, tests and
fixtures) uses a synthetic, obviously fictional firm. Nothing here has ever
connected to BWS's iManage.

## Safety properties (and the tests that prove them)

| Property | Where | Test |
|---|---|---|
| Never writes to iManage: GET-only allow-list, plus the OAuth token/device POST | `adapters/http_guard.py` | `tests/test_imanage_adapter.py` |
| Binds to 127.0.0.1 only; refuses non-loopback peers and wrong `Host` | `security.py` | `tests/test_security.py` |
| Launch code (single use, 60 s), then `HttpOnly; SameSite=Strict` cookie **and** `X-DMS-Analytics: 1`; no CORS | `security.py` | `tests/test_security.py` |
| Tokens only in the OS keychain (chunked for Credential Manager's limit) | `adapters/token_store.py` | `tests/test_imanage_adapter.py` |
| DuckDB file encrypted; key only in the keychain; SQL cannot reach files or network | `store/db.py` | `tests/test_store.py` |
| Logs never contain titles, names, tokens or query strings | `logging.py` | `tests/test_logging.py` |
| Every response matches `api-contract.yaml` | `api/` | `tests/test_contract.py` |

## Layout

```
pyproject.toml  uv.lock  config.example.toml  controls.example.yaml
src/dms_analytics/
  __main__.py      launcher (server + one-time launch URL)
  config.py        settings, %LOCALAPPDATA% / %APPDATA% paths (XDG on Linux dev boxes)
  logging.py       JSON logs with default-deny redaction
  security.py      launch codes, session cookie, Host/peer/header middleware
  analytics.py     every portfolio metric as a query function
  adapters/        base.py (interface), mock.py, imanage.py, http_guard.py, auth.py, token_store.py
  store/           db.py (encrypted DuckDB), repo.py, migrations/0001_initial.sql
  sync/engine.py   full / incremental / reconcile, checkpoint + resume, cancel
  controls/        rules.py (controls.yaml), engine.py, scoring.py, sampling.py
  api/             app.py, state.py, routes_*.py, schemas.py
  static/          built UI goes here (placeholder index.html for now)
tests/             pytest suite (mock only, in-memory fake keychain)
```

## Setup

Requires Python 3.12+ and [uv](https://docs.astral.sh/uv/).

```bash
cd dms-analytics/backend
uv sync                      # creates .venv from the pinned uv.lock
```

## Run in mock mode (one command)

```bash
uv run dms-analytics-dev
# equivalent (bash):        DMS_ANALYTICS_DEV=1 uv run python -m dms_analytics
# equivalent (PowerShell):  $env:DMS_ANALYTICS_DEV=1; uv run python -m dms_analytics
```

It listens on `http://127.0.0.1:8765` and prints a launch URL. In dev mode
`http://127.0.0.1:8765/launch?code=dev` also works, **once** per process
start. Dev mode is refused in live mode. Open the URL in a browser, then start
a sync from the UI. To use curl instead:

```bash
B=http://127.0.0.1:8765
curl -s -c jar.txt -o /dev/null "$B/launch?code=dev"            # 302 + session cookie
H="X-DMS-Analytics: 1"
curl -s -b jar.txt -H "$H" -X POST $B/api/sync/start             # 202, about 15-20 s for the mock firm
curl -s -b jar.txt -H "$H" $B/api/sync/status
curl -s -b jar.txt -H "$H" $B/api/portfolio/summary
curl -s -w '%{http_code}\n' $B/api/health                         # 401: no cookie/header
curl -s -w '%{http_code}\n' -H "Host: evil.example:8765" $B/       # 400: wrong Host
```

The mock firm (seed 42) has 400 workspaces in 6 practice areas, 8 partners,
25 fee earners, 2 offices, matters opened from 2019 onwards and about 45,000
documents. It includes realistic control failure rates, dormant matters, key
dates in the next 90 days, restricted workspaces that disappear on the second
listing, deleted documents, and HTML-like and unicode titles. The first sync
also writes 12 months of back-dated snapshots (mock only) so that trend
charts have data.

Data goes to `$XDG_DATA_HOME/bws-dms-analytics` on Linux, or to
`%LOCALAPPDATA%\BWS\DmsAnalytics` on Windows. Override with
`DMS_ANALYTICS_DATA_DIR` / `DMS_ANALYTICS_CONFIG_DIR`. On a Linux dev box
without a keyring backend, mock mode keeps the DB key in a `0600`
`dev-secrets.json` in the data folder. Live mode refuses to run without a
real OS keychain.

## Tests, lint and type-check

```bash
uv run pytest            # about 2 minutes
uv run ruff check
uv run mypy src          # (mypy src tests is also clean)
```

## Configuration

- `config.example.toml`: copy it to `%APPDATA%\BWS\DmsAnalytics\config.toml`.
  It contains only `<PLACEHOLDER>` values. Live mode refuses to start while
  any placeholder remains. There is no client secret.
- `controls.example.yaml`: copy it to `controls.yaml` in the same folder.
  The class codes match the mock firm and are placeholders for BWS's real
  codes (V6). The file is validated on load and gives plain-English errors.
  A changed file is picked up at the next sync.
- Environment variables: `DMS_ANALYTICS_MODE` (`mock`|`live`),
  `DMS_ANALYTICS_DEV`, `DMS_ANALYTICS_PORT`, `DMS_ANALYTICS_DATA_DIR`,
  `DMS_ANALYTICS_CONFIG_DIR`, `DMS_ANALYTICS_CONTROLS_FILE`,
  `DMS_ANALYTICS_MOCK_SEED`, `DMS_ANALYTICS_NO_BROWSER`.

## Serving the UI

Build the frontend and copy its output into `src/dms_analytics/static/` (so
that `index.html` is replaced). `/` serves `index.html`. Unknown non-`/api`
paths fall back to it (SPA routing). For frontend development, the Vite
proxy must forward to `127.0.0.1:8765` with `changeOrigin: true` so that the
Host check passes.

## Packaging (Windows, documented, not run here)

```powershell
uv run --with pyinstaller pyinstaller --noconfirm --onedir --name dms-analytics `
  --collect-data dms_analytics --collect-submodules dms_analytics `
  --hidden-import keyring.backends.Windows `
  src\dms_analytics\__main__.py
# output: dist\dms-analytics\dms-analytics.exe  (static UI, migrations and
# default controls are bundled as package data)
```

## First live connection checklist

Do this yourself, on your own laptop, after IT and risk have approved
`IT-REQUEST.md`. No agent should ever see your password, tokens or client ID.

1. **Approvals in hand**: IT/InfoSec sign-off on `IT-REQUEST.md`, the DPO's
   DPIA screening outcome, and the app registered in iManage Control Center
   (read-only scopes, refresh-token expiry agreed).
2. **Get these values from IT** (V1–V4): API base URL, customer ID, library
   IDs, the registered client ID, the exact read-only scope names, the grant
   type (PKCE with redirect `http://127.0.0.1:8765/auth/callback`, or device
   code), and the rate and page limits.
3. **Get the profile mapping from the DMS admin** (V6): which custom fields
   hold client, matter, practice area, partner, office, matter type, status
   and key date, and the document class/subclass codes for each document type.
4. Copy `config.example.toml` to `%APPDATA%\BWS\DmsAnalytics\config.toml`,
   fill in step 2, and set `mode = "live"`. Copy `controls.example.yaml` to
   `controls.yaml` there and replace every class code and field from step 3.
5. Run `dms-analytics.exe` with **no** `DMS_ANALYTICS_DEV` set. Live mode
   refuses dev mode.
6. In the app, choose **Sign in**. Sign in in your own browser with firm SSO
   and MFA. Check that Windows Credential Manager now has
   `bws-dms-analytics` entries, and that `config.toml` contains no token.
7. **Verify the VERIFY markers before the first full sync**: start with one
   small library (`library_ids = ["<SMALL_LIBRARY>"]`), run a sync, and
   compare a handful of matters with iManage by hand: names, partner, dates,
   document counts and classes. Fix `controls.yaml` and re-sync if they
   differ. Every `# VERIFY(V#)` in `adapters/imanage.py`,
   `adapters/http_guard.py` and `adapters/auth.py` marks an assumed endpoint
   or field. If iManage returns 404 or blocked-request errors, the paths
   need adjusting, and that change must keep the GET-only guard and its
   tests.
8. Watch the log (stderr, JSON) for `imanage_retry` events. If they are
   frequent, lower `max_concurrency`.
9. Check the coverage note: "Based on N workspaces visible to you" should
   match what you expect your account to see (R1).
10. When finished, or before handing the laptop back: **Sign out** removes
    the tokens, and **Wipe local data** deletes the database and its key.

## Known limitations and VERIFY items

- The iManage endpoints, paging parameters, field names and OAuth URLs are
  taken from public documentation and have not been checked against a live
  server (V1–V6). Each one is marked `VERIFY(V#)` in the code.
- A document filed in folders of two different workspaces is stored once.
  The last workspace listed wins (VERIFY with BWS's filing practice).
- Document history and audit events (V5) are not used. Activity uses
  document edit dates.
- The UI shows pre-sync figures while a sync runs, and refreshes when the
  sync finishes.
- No idle auto-exit yet: the launcher keeps running until it is closed
  (ARCHITECTURE §2 mentions idle exit).
