# Build brief: backend (agent 2)

Build `dms-analytics/backend/` exactly to `ARCHITECTURE.md`,
`data-model.md` and `api-contract.yaml`. The ground rules are in
`agents/dms-analytics/README.md`, and your general instructions are in
`agents/dms-analytics/02-backend-engineer.md`.

## Stack
Python 3.12+ (the dev environment has 3.13). FastAPI, uvicorn, pydantic
v2, duckdb ≥ 1.4, httpx, keyring, PyYAML, pytest, pytest-asyncio,
`openapi-core` or `schemathesis` (for contract validation), ruff and mypy.
Manage it with `uv` (`pyproject.toml` plus `uv.lock`).

## Layout
```
dms-analytics/backend/
  pyproject.toml  uv.lock  README.md  controls.example.yaml  config.example.toml
  src/dms_analytics/
    __main__.py          # launcher: start server, print/open launch URL
    config.py            # paths (%LOCALAPPDATA% etc; XDG fallback on Linux for dev), settings
    logging.py           # redacting structured logger
    security.py          # launch codes, session cookie, host + header middleware
    store/ (db.py, migrations/, repo.py)
    adapters/ (base.py, mock.py, imanage.py, http_guard.py, auth.py, token_store.py)
    sync/engine.py
    controls/ (rules.py [load+validate controls.yaml], engine.py, scoring.py, sampling.py)
    api/ (app.py, routes_*.py, schemas.py)
    static/              # built UI is copied here (placeholder index.html until then)
  tests/ ...
```

## Must-haves

1. **Mock firm** (`MockDmsAdapter`, seed 42 by default): about 400
   workspaces across 6 practice areas, 8 partners, 25 fee earners, 2
   offices, opened between 2019 and the present, and about 40,000
   documents. Inject realistic control failure rates (about 5–20% per
   control), some dormant matters, some key dates in the next 90 days,
   restricted workspaces that "disappear" on a second listing (to test
   reconciliation), and odd unicode and HTML-like titles such as
   `<script>`. Every name must be obviously fictional (for example
   "Partner Alpha", "Example Holdings Ltd (fictional)").
2. **Controls engine**: implement every control in ARCHITECTURE §3 with
   the defaults in `data-model.md`, including the plain-English
   `explanation` for each result. Ship `controls.example.yaml` matching
   the mock's class codes. Validate the YAML on load, with clear errors.
3. **API**: every path in `api-contract.yaml`, with exactly its shapes.
   The `/` route serves `static/index.html`, and SPA fallback serves it
   for non-`/api` paths.
4. **Security** as in ARCHITECTURE §6 and D5: a `/launch` code exchange,
   a cookie, the `X-DMS-Analytics: 1` header, `Host` checks, no CORS, and
   binding to 127.0.0.1 only.
   - **Dev convenience**: `DMS_ANALYTICS_DEV=1` prints the launch URL and
     also accepts the fixed launch code `dev` (still single-use per
     process start). It must refuse to enable this in `live` mode.
5. **iManage adapter**: implement it against the documented shape
   (`/work/api/v2/customers/{cid}/libraries/{lib}/…`), with a
   `http_guard` GET-only allow-list, PKCE loopback sign-in, the
   device-code fallback, chunked `keyring` storage, backoff and paging.
   It can't be tested live. Test it with `httpx.MockTransport` fixtures
   that reflect the documented iManage JSON shapes, and mark every assumed
   field or endpoint with `# VERIFY(V#)`, referring to DIAGNOSIS §3.
6. **Sync**: full, incremental and reconcile runs, background task,
   progress, cancellation, a checkpoint and resume, and a
   `portfolio_snapshot` after each run. For the mock, also generate 12
   months of back-dated snapshots on the first sync so that trend charts
   have data. Mark these clearly in the code as mock-only.
7. **Retention purge** at startup, **wipe**, and **sign-out**.
8. **Snapshot of the contract**: add a test that fails if any route's
   response doesn't validate against `api-contract.yaml`.

## Acceptance
- `uv run pytest` is green, `uv run ruff check` is clean, and `uv run mypy
  src` is clean (or the gaps are documented).
- `DMS_ANALYTICS_DEV=1 uv run python -m dms_analytics` starts in mock mode
  on `127.0.0.1:8765`. The first sync completes in under 60 seconds.
- `curl` without the cookie or header returns 401. A wrong `Host` returns
  400 or 403.
- A test proves `IManageAdapter` can't send POST, PUT, PATCH or DELETE to
  iManage (only the OAuth token POST to the auth host).
- `README.md` includes a mock quick-start, test commands, a PyInstaller
  build command (documented, not necessarily run here), and the
  **First live connection checklist**.
- Don't edit files outside `dms-analytics/backend/`, except appending
  D1xx records to `docs/dms-analytics/DECISIONS.md`.
