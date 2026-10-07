"""IManageAdapter against httpx.MockTransport fixtures shaped like iManage
Work API v2 responses (VERIFY(V1): shapes assumed from public docs).

Most importantly: the adapter cannot send POST/PUT/PATCH/DELETE to iManage;
the only POSTs that can leave are to the OAuth token / device endpoints."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import logging
import re
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from dms_analytics.adapters.auth import AuthError
from dms_analytics.adapters.base import AccessLostError, AdapterError, NotSignedInError
from dms_analytics.adapters.http_guard import WriteBlockedError, build_allow_list, check_request
from dms_analytics.adapters.imanage import (
    MAX_ATTEMPTS,
    IManageAdapter,
    backoff_delay,
    parse_retry_after,
)
from dms_analytics.adapters.token_store import (
    CHUNK_CHARS,
    MemoryBackend,
    SecretStore,
    TokenStore,
)
from dms_analytics.config import IManageSettings
from dms_analytics.logging import configure_logging

BASE = "https://imanage.example.test"
P = "/work/api/v2/customers/1/libraries/ACTIVE"
SETTINGS = IManageSettings(base_url=BASE, customer_id="1", client_id="test-client-id",
                           scopes=("user",), max_concurrency=2, page_size=2)
FAR_FUTURE = 4_000_000_000


def ws_json(n: int) -> dict[str, Any]:
    return {"id": f"ACTIVE!{n}", "name": f"Workspace {n} (fictional)", "owner": "FEONE",
            "owner_description": "Fee Earner One", "create_date": "2024-03-01T09:00:00Z",
            "edit_date": "2024-03-02T09:00:00Z", "custom1": f"C{n}",
            "custom1_description": "Example Holdings Ltd (fictional)", "custom2": f"C{n}-1",
            "custom2_description": "Share purchase (fictional)", "custom3": "Corporate",
            "custom7": "OPEN", "custom21": "2026-11-02", "default_security": "private"}


def doc_json(n: int, cls: str = "CORR", edited: str = "2024-04-01T10:00:00Z",
             ws: int = 1) -> dict[str, Any]:
    return {"id": f"ACTIVE!{ws * 1000 + n}.1", "name": f"Letter {n} (fictional)", "class": cls,
            "subclass": "", "author": "FEONE", "author_description": "Fee Earner One",
            "create_date": "2024-03-05T10:00:00Z", "edit_date": edited, "version": 1,
            "size": 12345, "extension": "docx"}


class FakeIManage:
    """Routes requests like the iManage Work API and records them."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.overrides: dict[str, list[httpx.Response]] = {}
        self.token_responses: list[httpx.Response] = []
        self.valid_tokens = {"AT1"}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if self.overrides.get(path):
            return self.overrides[path].pop(0)
        if path == "/auth/oauth2/token":
            if self.token_responses:
                return self.token_responses.pop(0)
            return httpx.Response(400, json={"error": "invalid_grant"})
        if path == "/auth/oauth2/device":
            return httpx.Response(200, json={
                "device_code": "DEV-123", "user_code": "ABCD-EFGH", "interval": 1,
                "verification_uri": f"{BASE}/device", "expires_in": 600})
        auth = request.headers.get("authorization", "")
        if auth.removeprefix("Bearer ") not in self.valid_tokens:
            return httpx.Response(401, json={"error": "unauthorized"})
        offset = int(request.url.params.get("offset", 0))
        limit = int(request.url.params.get("limit", 500))
        if path == "/api":
            return httpx.Response(200, json={"data": {"user": {
                "id": "DEMO", "full_name": "Demo User (fictional)"}}})
        if path == "/work/api/v2/customers/1/libraries":
            return httpx.Response(200, json={"data": [{"id": "ACTIVE",
                                                       "name": "Active (fictional)"}]})
        if path == f"{P}/workspaces/search":
            items = [ws_json(n) for n in (1, 2, 3)]
            return httpx.Response(200, json={"data": items[offset:offset + limit]})
        m = re.fullmatch(rf"{P}/workspaces/(ACTIVE!\d+)/children", path)
        if m:
            if m.group(1) == "ACTIVE!3":
                return httpx.Response(403, json={"error": "forbidden"})
            children = [
                {"id": f"{m.group(1)}-F1", "name": "Correspondence", "wstype": "folder"},
                {"id": "S1", "name": "Saved search", "wstype": "search"}]
            return httpx.Response(200, json={"data": children[offset:offset + limit]})
        m = re.fullmatch(rf"{P}/folders/([^/]+)/children", path)
        if m:
            if m.group(1).endswith("-F1"):
                return httpx.Response(200, json={"data": [
                    {"id": f"{m.group(1)}-F2", "name": "Letters", "wstype": "folder"}]})
            return httpx.Response(200, json={"data": []})
        m = re.fullmatch(rf"{P}/folders/([^/]+)/documents", path)
        if m:
            ws = int(m.group(1).split("!")[1].split("-")[0])
            if m.group(1).endswith("-F2"):
                docs = [doc_json(1, ws=ws), doc_json(2, "ENGAGE", ws=ws),
                        doc_json(3, "BILL", "2026-10-01T09:00:00Z", ws=ws)]
            else:  # doc 1 is filed in two folders
                docs = [doc_json(9, "FILEOPEN", ws=ws), doc_json(1, ws=ws)]
            return httpx.Response(200, json={"data": docs[offset:offset + limit]})
        m = re.fullmatch(rf"{P}/documents/([^/]+)/versions", path)
        if m:
            return httpx.Response(200, json={"data": [
                {"version": 1, "edit_date": "2024-03-05T10:00:00Z"},
                {"version": 2, "edit_date": "2024-03-06T10:00:00Z"}]})
        return httpx.Response(404, json={"error": "not found"})


class Harness:
    def __init__(self, signed_in: bool = True, **overrides: Any) -> None:
        self.fake = FakeIManage()
        self.backend = MemoryBackend()
        self.tokens = TokenStore(SecretStore(self.backend))
        if signed_in:
            self.tokens.save({"access_token": "AT1", "refresh_token": "RT1",
                              "expires_at": FAR_FUTURE})
        self.sleeps: list[float] = []
        self.opened: list[str] = []
        self.now = [1_800_000_000.0]

        async def sleep(s: float) -> None:
            self.sleeps.append(s)

        settings = IManageSettings(**{**SETTINGS.__dict__, **overrides})
        self.adapter = IManageAdapter(
            settings, self.tokens, "http://127.0.0.1:8765/auth/callback",
            transport=httpx.MockTransport(self.fake), sleep=sleep,
            clock=lambda: self.now[0], open_browser=self.opened.append)


async def collect(agen: Any) -> list[Any]:
    out: list[Any] = []
    async for page in agen:
        out.extend(page)
    return out


# ------------------------------------------------------------------ read paths

async def test_lists_libraries_workspaces_and_documents_with_paging() -> None:
    h = Harness()
    ad = h.adapter
    assert [lib.id for lib in await ad.list_libraries()] == ["ACTIVE"]
    wss = await collect(ad.iter_workspaces("ACTIVE", None))
    assert [w.id for w in wss] == ["ACTIVE!1", "ACTIVE!2", "ACTIVE!3"]
    searches = [r for r in h.fake.requests if r.url.path.endswith("/workspaces/search")]
    assert [r.url.params["offset"] for r in searches] == ["0", "2"]  # page_size 2
    assert wss[0].profile["custom1"] == "C1" and "default_security" not in wss[0].profile
    assert wss[0].owner_id == "FEONE"

    docs = await collect(ad.iter_documents("ACTIVE", "ACTIVE!1", None))
    assert sorted(d.id for d in docs) == ["ACTIVE!1001.1", "ACTIVE!1002.1", "ACTIVE!1003.1",
                                          "ACTIVE!1009.1"]  # deduplicated
    by_id = {d.id: d for d in docs}
    assert by_id["ACTIVE!1002.1"].folder_path == "Correspondence / Letters"
    assert by_id["ACTIVE!1009.1"].folder_path == "Correspondence"
    assert by_id["ACTIVE!1002.1"].doc_class == "ENGAGE" and by_id["ACTIVE!1001.1"].doc_subclass \
        is None
    user = await ad.current_user()
    assert user is not None and user.display_name == "Demo User (fictional)"
    n = len(h.fake.requests)
    assert await ad.current_user() == user and len(h.fake.requests) == n  # cached
    versions = await ad.get_versions("ACTIVE", "ACTIVE!1001.1")
    assert [v.version for v in versions] == [1, 2]
    assert all(r.method == "GET" for r in h.fake.requests)
    await ad.aclose()


async def test_incremental_filters_by_edit_date() -> None:
    from datetime import datetime
    h = Harness()
    docs = await collect(h.adapter.iter_documents("ACTIVE", "ACTIVE!1",
                                                  datetime(2026, 9, 1)))
    assert [d.id for d in docs] == ["ACTIVE!1003.1"]


async def test_forbidden_workspace_is_access_lost() -> None:
    h = Harness()
    with pytest.raises(AccessLostError):
        await collect(h.adapter.iter_documents("ACTIVE", "ACTIVE!3", None))


async def test_configured_libraries_skip_discovery() -> None:
    h = Harness(library_ids=("ACTIVE", "ARCHIVE"))
    assert [x.id for x in await h.adapter.list_libraries()] == ["ACTIVE", "ARCHIVE"]
    assert h.fake.requests == []


# ------------------------------------------------------------------ write blocking

WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"]
API_PATHS = [
    f"{P}/workspaces/search", f"{P}/workspaces/ACTIVE!1", f"{P}/folders/F1/documents",
    f"{P}/documents/ACTIVE!1001.1", f"{P}/documents/ACTIVE!1001.1/checkout",
    f"{P}/documents/ACTIVE!1001.1/lock", f"{P}/documents/ACTIVE!1001.1/versions",
    "/work/api/v2/customers/1/libraries", "/api",
]


@pytest.mark.parametrize("method", WRITE_METHODS)
@pytest.mark.parametrize("path", API_PATHS)
async def test_adapter_cannot_send_write_methods_to_imanage(method: str, path: str) -> None:
    h = Harness()
    client = h.adapter._client()
    with pytest.raises(WriteBlockedError):
        await client.request(method, f"{BASE}{path}", json={"x": 1})
    assert h.fake.requests == []  # nothing reached the server


@pytest.mark.parametrize("url", [
    f"{BASE}{P}/documents/ACTIVE!1001.1/download",           # content, not metadata
    f"{BASE}{P}/documents/ACTIVE!1001.1",                   # not on list
    f"{BASE}{P}/workspaces/ACTIVE!1/../../users",           # traversal
    f"{BASE}/work/api/v2/customers/2/libraries",            # another customer
    "https://evil.example/work/api/v2/customers/1/libraries",
    f"http://imanage.example.test{P}/workspaces/search",     # not HTTPS
])
async def test_get_outside_allow_list_is_blocked(url: str) -> None:
    h = Harness()
    with pytest.raises(WriteBlockedError):
        await h.adapter._client().get(url)
    assert h.fake.requests == []


@pytest.mark.parametrize("url", [
    f"{BASE}/auth/oauth2/token?x=1", f"{BASE}/auth/oauth2/tokens", f"{BASE}/auth/oauth2/authorize",
    "https://evil.example/auth/oauth2/token",
])
async def test_post_only_to_exact_token_endpoints(url: str) -> None:
    h = Harness()
    with pytest.raises(WriteBlockedError):
        await h.adapter._client().post(url, data={"a": "b"})


def test_token_and_device_posts_are_allowed() -> None:
    allow = build_allow_list(SETTINGS)
    check_request(httpx.Request("POST", f"{BASE}/auth/oauth2/token"), allow)
    check_request(httpx.Request("POST", f"{BASE}/auth/oauth2/device"), allow)
    check_request(httpx.Request("GET", f"{BASE}{P}/workspaces/search?limit=2"), allow)
    with pytest.raises(WriteBlockedError):
        check_request(httpx.Request("GET", f"{BASE}{P}/workspaces/search", content=b"x"), allow)


def test_separate_auth_host() -> None:
    s = IManageSettings(**{**SETTINGS.__dict__, "auth_base_url": "https://login.example.test"})
    allow = build_allow_list(s)
    check_request(httpx.Request("POST", "https://login.example.test/auth/oauth2/token"), allow)
    with pytest.raises(WriteBlockedError):
        check_request(httpx.Request("POST", f"{BASE}/auth/oauth2/token"), allow)
    with pytest.raises(WriteBlockedError):
        check_request(httpx.Request("GET", f"https://login.example.test{P}/workspaces/search"),
                      allow)


def test_source_has_no_write_calls() -> None:
    """Belt and braces: the adapter code never names a write verb on a client."""
    src = Path(__file__).resolve().parents[1] / "src" / "dms_analytics" / "adapters"
    imanage = (src / "imanage.py").read_text(encoding="utf-8")
    assert not re.search(r"\.(post|put|patch|delete|request|stream|send)\(", imanage)
    auth = (src / "auth.py").read_text(encoding="utf-8")
    assert re.findall(r"\.(post|put|patch|delete|request|stream|send)\(", auth) == ["post"]


async def test_redirects_are_not_followed() -> None:
    h = Harness()
    h.fake.overrides[f"{P}/workspaces/search"] = [
        httpx.Response(302, headers={"location": "https://evil.example/"})]
    with pytest.raises(AdapterError, match="redirect"):
        await collect(h.adapter.iter_workspaces("ACTIVE", None))
    assert all(r.url.host == "imanage.example.test" for r in h.fake.requests)


# ------------------------------------------------------------------ rate limits

async def test_429_honours_retry_after() -> None:
    h = Harness()
    h.fake.overrides["/work/api/v2/customers/1/libraries"] = [
        httpx.Response(429, headers={"Retry-After": "7"}),
        httpx.Response(503, headers={"Retry-After": "2"})]
    libs = await h.adapter.list_libraries()
    assert [x.id for x in libs] == ["ACTIVE"]
    assert h.sleeps == [7.0, 2.0]


async def test_backoff_with_jitter_then_gives_up() -> None:
    h = Harness()
    h.fake.overrides["/work/api/v2/customers/1/libraries"] = [
        httpx.Response(503) for _ in range(MAX_ATTEMPTS)]
    with pytest.raises(AdapterError, match="busy"):
        await h.adapter.list_libraries()
    assert len(h.sleeps) == MAX_ATTEMPTS - 1
    assert all(0 <= s <= 30 for s in h.sleeps)


def test_retry_after_parsing_and_backoff_bounds() -> None:
    import random
    assert parse_retry_after("5", 0) == 5.0
    assert parse_retry_after("100000", 0) == 120.0
    assert parse_retry_after("Thu, 01 Jan 1970 00:00:10 GMT", 4.0) == 6.0
    assert parse_retry_after("soon", 0) is None and parse_retry_after(None, 0) is None
    rng = random.Random(1)
    for attempt in range(10):
        assert 0 <= backoff_delay(attempt, rng) <= min(30, 0.5 * 2 ** attempt)


async def test_concurrency_is_capped() -> None:
    h = Harness(max_concurrency=2)
    active = [0]
    peak = [0]
    inner = h.fake

    async def slow(request: httpx.Request) -> httpx.Response:
        active[0] += 1
        peak[0] = max(peak[0], active[0])
        await asyncio.sleep(0.01)
        active[0] -= 1
        return inner(request)

    h.adapter._transport_factory = lambda: httpx.MockTransport(slow)
    await asyncio.gather(*(h.adapter.list_libraries() for _ in range(8)))
    assert peak[0] <= 2


# ------------------------------------------------------------------ tokens

def _token_response(access: str, refresh: str | None = "RT2", expires: int = 1800
                    ) -> httpx.Response:
    body: dict[str, Any] = {"access_token": access, "expires_in": expires,
                            "token_type": "Bearer"}
    if refresh:
        body["refresh_token"] = refresh
    return httpx.Response(200, json=body)


async def test_401_triggers_one_refresh_and_retry() -> None:
    h = Harness()
    h.fake.valid_tokens = {"AT2"}
    h.fake.token_responses = [_token_response("AT2", "RT2")]
    assert [x.id for x in await h.adapter.list_libraries()] == ["ACTIVE"]
    token_calls = [r for r in h.fake.requests if r.url.path == "/auth/oauth2/token"]
    assert len(token_calls) == 1 and token_calls[0].method == "POST"
    form = parse_qs(token_calls[0].content.decode())
    assert form["grant_type"] == ["refresh_token"] and form["refresh_token"] == ["RT1"]
    saved = h.tokens.load()
    assert saved is not None and saved["access_token"] == "AT2" and saved["refresh_token"] == "RT2"


async def test_expired_access_token_is_refreshed_first() -> None:
    h = Harness()
    h.tokens.save({"access_token": "OLD", "refresh_token": "RT1", "expires_at": 0})
    h.adapter._cached = None
    h.fake.token_responses = [_token_response("AT1", None)]
    await h.adapter.list_libraries()
    assert h.fake.requests[0].url.path == "/auth/oauth2/token"
    saved = h.tokens.load()
    assert saved is not None and saved["refresh_token"] == "RT1"  # kept when not rotated


async def test_refresh_failure_signs_out() -> None:
    h = Harness()
    h.fake.valid_tokens = set()
    with pytest.raises(NotSignedInError):
        await h.adapter.list_libraries()
    assert h.tokens.load() is None and not h.adapter.is_signed_in()
    assert h.backend.data == {}


async def test_not_signed_in() -> None:
    h = Harness(signed_in=False)
    assert not h.adapter.is_signed_in()
    assert await h.adapter.current_user() is None
    with pytest.raises(NotSignedInError):
        await h.adapter.list_libraries()


async def test_pkce_sign_in_flow() -> None:
    h = Harness(signed_in=False)
    result = await h.adapter.sign_in()
    assert result.status == "browser_opened" and len(h.opened) == 1
    url = urlsplit(h.opened[0])
    q = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert url.path == "/auth/oauth2/authorize"
    assert q["response_type"] == "code" and q["code_challenge_method"] == "S256"
    assert q["client_id"] == "test-client-id" and q["scope"] == "user"
    assert q["redirect_uri"] == "http://127.0.0.1:8765/auth/callback"
    assert "client_secret" not in q
    with pytest.raises(AuthError):
        await h.adapter.complete_pkce("CODE", "wrong-state")
    h.fake.token_responses = [_token_response("AT1", "RT9")]
    await h.adapter.complete_pkce("CODE", q["state"])
    post = next(r for r in h.fake.requests if r.url.path == "/auth/oauth2/token")
    form = {k: v[0] for k, v in parse_qs(post.content.decode()).items()}
    assert form["grant_type"] == "authorization_code" and form["code"] == "CODE"
    digest = hashlib.sha256(form["code_verifier"].encode()).digest()
    assert base64.urlsafe_b64encode(digest).rstrip(b"=").decode() == q["code_challenge"]
    assert "client_secret" not in form
    assert h.adapter.is_signed_in()
    with pytest.raises(AuthError):  # state is single-use
        await h.adapter.complete_pkce("CODE", q["state"])


async def test_device_code_flow() -> None:
    h = Harness(signed_in=False, auth_flow="device_code")
    h.fake.token_responses = [httpx.Response(400, json={"error": "authorization_pending"}),
                              _token_response("AT1", "RT1")]
    result = await h.adapter.sign_in()
    assert result.status == "device_code" and result.user_code == "ABCD-EFGH"
    assert result.verification_url == f"{BASE}/device"
    assert h.adapter._device_task is not None
    await h.adapter._device_task
    assert h.adapter.is_signed_in()
    polls = [parse_qs(r.content.decode())["grant_type"][0] for r in h.fake.requests
             if r.url.path == "/auth/oauth2/token"]
    assert polls == ["urn:ietf:params:oauth:grant-type:device_code"] * 2


async def test_sign_out_clears_keychain() -> None:
    h = Harness()
    big = "R" * (CHUNK_CHARS * 4 + 17)
    h.tokens.save({"access_token": "AT1", "refresh_token": big, "expires_at": FAR_FUTURE})
    assert len(h.backend.data) > 3
    await h.adapter.sign_out()
    await h.adapter.sign_out()  # idempotent
    assert h.backend.data == {}


def test_chunked_secret_store_roundtrip() -> None:
    backend = MemoryBackend()
    store = SecretStore(backend)
    value = "x" * 5000 + "end"
    store.set("tok", value)  # MemoryBackend rejects > 1280 chars per entry
    assert store.get("tok") == value
    assert len(backend.data) == 7  # header + 6 chunks
    store.set("tok", "short")
    assert store.get("tok") == "short" and len(backend.data) == 2
    store.delete("tok")
    assert backend.data == {} and store.get("tok") is None


async def test_tokens_never_logged() -> None:
    stream = io.StringIO()
    handler = configure_logging(logging.DEBUG, stream)
    try:
        h = Harness(signed_in=False)
        await h.adapter.sign_in()
        state = parse_qs(urlsplit(h.opened[0]).query)["state"][0]
        h.fake.token_responses = [_token_response("SECRET-ACCESS", "SECRET-REFRESH")]
        h.fake.valid_tokens = {"SECRET-ACCESS"}
        await h.adapter.complete_pkce("SECRET-CODE", state)
        h.fake.overrides["/work/api/v2/customers/1/libraries"] = [httpx.Response(429)]
        await h.adapter.list_libraries()
    finally:
        logging.getLogger().removeHandler(handler)
    out = stream.getvalue()
    assert out and "SECRET" not in out and state not in out


# ------------------------------------------------------------------ end to end

async def test_sync_engine_runs_on_imanage_adapter(tmp_path: Path) -> None:
    import secrets as pysecrets
    from datetime import datetime

    from dms_analytics.controls.rules import load_controls
    from dms_analytics.store.db import Database
    from dms_analytics.store.repo import Repo
    from dms_analytics.sync.engine import SyncEngine

    db = Database(tmp_path / "e2e.duckdb", pysecrets.token_hex(32))
    db.open()
    repo = Repo(db)
    h = Harness()
    now = datetime(2026, 10, 7, 12)
    run_id = repo.create_run("full", now)
    engine = SyncEngine(repo, h.adapter, load_controls(None), lambda: now, is_mock=False)
    progress = await engine.run(run_id, "full", None)
    assert progress.workspaces_total == 3 and progress.deleted == 1  # ACTIVE!3 forbidden
    assert repo.matter_ids() == {"ACTIVE!1", "ACTIVE!2"}
    row = db.fetch_dicts("SELECT * FROM matter WHERE id = 'ACTIVE!1'")[0]
    assert row["client_name"] == "Example Holdings Ltd (fictional)"
    assert row["status"] == "open" and str(row["key_date"]) == "2026-11-02"
    assert row["doc_count"] == 4
    types = dict(db.fetchall("SELECT id, canonical_type FROM document WHERE matter_id = "
                             "'ACTIVE!1'"))
    assert types["ACTIVE!1009.1"] == "file_opening" and types["ACTIVE!1003.1"] == "bill"
    assert all(r.method == "GET" for r in h.fake.requests)
    await h.adapter.aclose()
    db.close()

