"""IManageAdapter: iManage Work REST API v2, read-only, delegated OAuth.

NOT TESTED AGAINST A LIVE SERVER. Every endpoint, parameter and JSON field
below is taken from iManage's public documentation and is marked
``VERIFY(V#)`` (DIAGNOSIS §3) until confirmed with BWS IT on the first live
connection (README "First live connection" checklist).

Safety properties (tested in tests/test_imanage_adapter.py):
- all traffic goes through ``GuardedTransport`` (GET-only allow-list, plus
  the OAuth token/device POSTs);
- redirects are never followed;
- tokens live only in the OS keychain (``TokenStore``), never in logs;
- 429/503 honour ``Retry-After``; other transient errors back off
  exponentially with full jitter; concurrency is capped.
"""

from __future__ import annotations

import asyncio
import email.utils
import logging
import random
import time
import webbrowser
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import httpx

from dms_analytics.adapters.auth import AuthError, AuthorizationPending, OAuthClient
from dms_analytics.adapters.base import (
    AccessLostError,
    AdapterError,
    Capabilities,
    Library,
    NotSignedInError,
    RawDocument,
    RawFolder,
    RawVersion,
    RawWorkspace,
    SignInResult,
    UserInfo,
)
from dms_analytics.adapters.http_guard import GuardedTransport, api_prefix, build_allow_list
from dms_analytics.adapters.token_store import TokenStore
from dms_analytics.config import IManageSettings
from dms_analytics.logging import log_event

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 6
BACKOFF_BASE_S = 0.5
BACKOFF_CAP_S = 30.0
RETRY_AFTER_CAP_S = 120.0
TOKEN_EXPIRY_SKEW_S = 60


def parse_retry_after(value: str | None, now: float) -> float | None:
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return min(float(value), RETRY_AFTER_CAP_S)
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(when.timestamp() - now, RETRY_AFTER_CAP_S))


def backoff_delay(attempt: int, rng: random.Random) -> float:
    """Exponential backoff with full jitter."""
    return rng.uniform(0, min(BACKOFF_CAP_S, BACKOFF_BASE_S * (2 ** attempt)))


def _dt(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt.astimezone(UTC).replace(tzinfo=None) if dt.tzinfo else dt


def _items(payload: Any) -> list[dict[str, Any]]:
    # VERIFY(V1): list responses are {"data": [...]} (some: {"data": {"results": [...]}})
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict)]
        if isinstance(data, dict) and isinstance(data.get("results"), list):
            return [x for x in data["results"] if isinstance(x, dict)]
    return []


class IManageAdapter:
    source_name = "iManage Work"

    def __init__(self, settings: IManageSettings, tokens: TokenStore, redirect_uri: str, *,
                 transport: httpx.AsyncBaseTransport | None = None,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 clock: Callable[[], float] = time.time,
                 open_browser: Callable[[str], Any] = webbrowser.open,
                 rng: random.Random | None = None) -> None:
        self.settings = settings
        self.tokens = tokens
        self.oauth = OAuthClient(settings, redirect_uri, clock)
        self.allow = build_allow_list(settings)
        self._transport_factory: Callable[[], httpx.AsyncBaseTransport] = (
            (lambda: transport) if transport is not None else httpx.AsyncHTTPTransport)
        self._sleep = sleep
        self._clock = clock
        self._open_browser = open_browser
        self._rng = rng or random.Random()
        self._clients: dict[int, httpx.AsyncClient] = {}
        self._sems: dict[int, asyncio.Semaphore] = {}
        self._pending_pkce: dict[str, str] = {}
        self._device_task: asyncio.Task[None] | None = None
        self._cached: dict[str, Any] | None = None
        self._refresh_lock: asyncio.Lock | None = None
        self._user: UserInfo | None = None
        self.prefix = api_prefix(settings)

    # ------------------------------------------------------------ plumbing

    def _client(self) -> httpx.AsyncClient:
        """One guarded client per event loop (API loop and sync-thread loop)."""
        key = id(asyncio.get_running_loop())
        client = self._clients.get(key)
        if client is None or client.is_closed:
            client = httpx.AsyncClient(
                transport=GuardedTransport(self._transport_factory(), self.allow),
                follow_redirects=False, timeout=httpx.Timeout(30.0, connect=10.0),
                headers={"Accept": "application/json", "User-Agent": "bws-dms-analytics/1.0"})
            self._clients[key] = client
            self._sems[key] = asyncio.Semaphore(self.settings.max_concurrency)
        return client

    def _sem(self) -> asyncio.Semaphore:
        self._client()
        return self._sems[id(asyncio.get_running_loop())]

    async def aclose(self) -> None:
        key = id(asyncio.get_running_loop())
        client = self._clients.pop(key, None)
        self._sems.pop(key, None)
        if client is not None:
            await client.aclose()

    def capabilities(self) -> Capabilities:
        return Capabilities(history=False,  # VERIFY(V5)
                            versions=True, server_side_since_filter=False,
                            max_concurrency=self.settings.max_concurrency)

    # ------------------------------------------------------------ auth

    def _load_tokens(self) -> dict[str, Any] | None:
        if self._cached is None:
            self._cached = self.tokens.load()
        return self._cached

    def is_signed_in(self) -> bool:
        return self._load_tokens() is not None

    def _save_tokens(self, tokens: dict[str, Any]) -> None:
        self.tokens.save(tokens)
        self._cached = tokens

    async def sign_in(self) -> SignInResult:
        client = self._client()
        if self.settings.auth_flow == "device_code":
            start = await self.oauth.start_device(client)
            self._device_task = asyncio.get_running_loop().create_task(
                self._poll_device(start.device_code, start.interval, start.expires_in))
            log_event(log, "sign_in_device_code", flow="device_code")
            return SignInResult("device_code", start.verification_uri, start.user_code)
        req = self.oauth.pkce_request()
        self._pending_pkce = {req.state: req.verifier}  # only the latest attempt is valid
        self._open_browser(req.url)
        log_event(log, "sign_in_browser_opened", flow="pkce")
        return SignInResult("browser_opened")

    async def complete_pkce(self, code: str, state: str) -> None:
        verifier = self._pending_pkce.pop(state, None)
        if verifier is None:
            raise AuthError("Unknown or expired sign-in attempt.")
        self._save_tokens(await self.oauth.exchange_code(self._client(), code, verifier))
        log_event(log, "signed_in", flow="pkce")

    async def _poll_device(self, device_code: str, interval: int, expires_in: int) -> None:
        deadline = self._clock() + expires_in
        while self._clock() < deadline:
            await self._sleep(max(1, interval))
            try:
                tokens = await self.oauth.poll_device(self._client(), device_code)
            except AuthorizationPending as exc:
                if str(exc) == "slow_down":
                    interval += 5
                continue
            except AuthError:
                log_event(log, "sign_in_failed", logging.WARNING, flow="device_code")
                return
            self._save_tokens(tokens)
            log_event(log, "signed_in", flow="device_code")
            return

    async def sign_out(self) -> None:
        if self._device_task is not None:
            self._device_task.cancel()
            self._device_task = None
        self._pending_pkce.clear()
        self.tokens.clear()
        self._cached = None
        self._user = None

    async def _access_token(self, force_refresh: bool = False) -> str:
        tokens = self._load_tokens()
        if tokens is None:
            raise NotSignedInError("Not signed in to iManage.")
        expired = int(tokens.get("expires_at", 0)) - TOKEN_EXPIRY_SKEW_S <= self._clock()
        if force_refresh or expired:
            if self._refresh_lock is None:
                self._refresh_lock = asyncio.Lock()
            refresh = tokens.get("refresh_token")
            if not refresh:
                await self.sign_out()
                raise NotSignedInError("Your iManage session has expired. Sign in again.")
            try:
                tokens = await self.oauth.refresh(self._client(), str(refresh))
            except AuthError as exc:
                await self.sign_out()
                raise NotSignedInError("Your iManage session has expired. Sign in again.") \
                    from exc
            self._save_tokens(tokens)
        return str(tokens["access_token"])

    # ------------------------------------------------------------ requests

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        url = f"{self.allow.api_origin}{path}"
        refreshed = False
        attempt = 0
        async with self._sem():
            while True:
                token = await self._access_token()
                try:
                    resp = await self._client().get(
                        url, params=params, headers={"Authorization": f"Bearer {token}"})
                except httpx.TransportError as exc:
                    if attempt + 1 >= MAX_ATTEMPTS:
                        raise AdapterError(f"Could not reach iManage ({type(exc).__name__}).") \
                            from exc
                    await self._sleep(backoff_delay(attempt, self._rng))
                    attempt += 1
                    continue
                status = resp.status_code
                if status in (429, 503) or status in (500, 502, 504):
                    if attempt + 1 >= MAX_ATTEMPTS:
                        raise AdapterError(f"iManage is busy (HTTP {status}); try again later.")
                    delay = parse_retry_after(resp.headers.get("retry-after"), self._clock())
                    if delay is None:
                        delay = backoff_delay(attempt, self._rng)
                    log_event(log, "imanage_retry", logging.INFO, status_code=status,
                              attempt=attempt + 1, delay_s=round(delay, 2))
                    await self._sleep(delay)
                    attempt += 1
                    continue
                if status == 401 and not refreshed:
                    refreshed = True
                    await self._access_token(force_refresh=True)
                    continue
                if status == 401:
                    raise NotSignedInError("iManage rejected the sign-in. Sign in again.")
                if status in (403, 404, 410):
                    raise AccessLostError(f"iManage returned HTTP {status}.")
                if 300 <= status < 400:
                    raise AdapterError(f"iManage returned an unexpected redirect (HTTP {status}).")
                if status >= 400:
                    raise AdapterError(f"iManage returned HTTP {status}.")
                try:
                    return resp.json()
                except ValueError as exc:
                    raise AdapterError("iManage returned a response that is not JSON.") from exc

    async def _paged(self, path: str, params: dict[str, Any] | None = None
                     ) -> AsyncIterator[list[dict[str, Any]]]:
        # VERIFY(V4): offset/limit paging, max 500 per call; stop on a short page.
        limit = self.settings.page_size
        offset = 0
        while True:
            payload = await self._get(path, {**(params or {}), "limit": limit, "offset": offset})
            items = _items(payload)
            if items:
                yield items
            if len(items) < limit:
                return
            offset += limit

    # ------------------------------------------------------------ DmsAdapter

    async def current_user(self) -> UserInfo | None:
        if not self.is_signed_in():
            return None
        if self._user is not None:  # cached: the UI polls /api/session
            return self._user
        payload = await self._get(f"{self.allow.api_base_path}/api")
        user = (payload.get("data") or {}).get("user") or {}  # VERIFY(V1)
        uid = str(user.get("id") or "")
        name = str(user.get("full_name") or user.get("name") or uid)
        self._user = UserInfo(uid, name) if uid else None
        return self._user

    async def list_libraries(self) -> list[Library]:
        if self.settings.library_ids:
            return [Library(lib, lib) for lib in self.settings.library_ids]
        payload = await self._get(f"{self.prefix}/libraries")
        return [Library(str(x["id"]), str(x.get("name") or x["id"]))
                for x in _items(payload) if x.get("id")]

    def _workspace(self, library_id: str, x: dict[str, Any]) -> RawWorkspace | None:
        created = _dt(x.get("create_date"))  # VERIFY(V1)
        if not x.get("id") or created is None:
            return None
        return RawWorkspace(
            id=str(x["id"]), library_id=library_id, name=str(x.get("name") or ""),
            owner_id=x.get("owner"), owner_name=x.get("owner_description"),  # VERIFY(V1)
            created_at=created, edited_at=_dt(x.get("edit_date")) or created,
            profile={k: v for k, v in x.items() if k.startswith("custom")},  # VERIFY(V6)
        )

    async def iter_workspaces(self, library_id: str,
                              since: datetime | None) -> AsyncIterator[list[RawWorkspace]]:
        params: dict[str, Any] = {}
        # Workspace edit dates do not change when documents are added, so the
        # engine always lists documents per workspace for incremental runs.
        async for page in self._paged(f"{self.prefix}/libraries/{library_id}/workspaces/search",
                                      params):
            out = [w for w in (self._workspace(library_id, x) for x in page) if w is not None]
            if since is not None:
                out = [w for w in out if w.edited_at >= since]
            if out:
                yield out

    async def _folders(self, library_id: str, workspace_id: str) -> list[RawFolder]:
        """Breadth-first walk of the workspace's folder tree."""
        result: list[RawFolder] = []
        queue: list[tuple[str, str, str]] = [
            ("workspaces", workspace_id, "")]
        while queue:
            kind, cid, parent_path = queue.pop(0)
            async for page in self._paged(
                    f"{self.prefix}/libraries/{library_id}/{kind}/{cid}/children"):
                for x in page:
                    # VERIFY(V1): container items carry wstype "folder"/"tab"/"search"
                    if x.get("wstype", x.get("type")) not in ("folder", "tab"):
                        continue
                    name = str(x.get("name") or "")
                    path = f"{parent_path} / {name}" if parent_path else name
                    result.append(RawFolder(str(x["id"]), workspace_id, name, path))
                    queue.append(("folders", str(x["id"]), path))
        return result

    async def iter_folders(self, library_id: str,
                           workspace_id: str) -> AsyncIterator[list[RawFolder]]:
        folders = await self._folders(library_id, workspace_id)
        if folders:
            yield folders

    async def iter_documents(self, library_id: str, workspace_id: str,
                             since: datetime | None) -> AsyncIterator[list[RawDocument]]:
        seen: set[str] = set()
        for folder in await self._folders(library_id, workspace_id):
            async for page in self._paged(
                    f"{self.prefix}/libraries/{library_id}/folders/{folder.id}/documents"):
                out = []
                for x in page:
                    doc = self._document(workspace_id, folder.path, x)
                    if doc is None or doc.id in seen:
                        continue
                    seen.add(doc.id)
                    if since is None or doc.edited_at >= since:
                        out.append(doc)
                if out:
                    yield out

    @staticmethod
    def _document(workspace_id: str, folder_path: str, x: dict[str, Any]) -> RawDocument | None:
        created = _dt(x.get("create_date"))  # VERIFY(V1)
        if not x.get("id") or created is None:
            return None
        return RawDocument(
            id=str(x["id"]), workspace_id=workspace_id, folder_path=folder_path,
            name=str(x.get("name") or ""), doc_class=x.get("class"),
            doc_subclass=x.get("subclass") or None,
            author_id=x.get("author"), author_name=x.get("author_description"),
            created_at=created, edited_at=_dt(x.get("edit_date")) or created,
            version=int(x.get("version") or 1), size_bytes=int(x.get("size") or 0),
        )

    async def get_versions(self, library_id: str, document_id: str) -> list[RawVersion]:
        payload = await self._get(
            f"{self.prefix}/libraries/{library_id}/documents/{document_id}/versions")
        out = []
        for x in _items(payload):
            edited = _dt(x.get("edit_date"))
            if edited is not None:
                out.append(RawVersion(document_id, int(x.get("version") or 1), edited))
        return out
