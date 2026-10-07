"""Read-only HTTP guard for the iManage adapter (ARCHITECTURE §4).

``GuardedTransport`` wraps the real transport and inspects every request
*before* it is sent:

- ``GET`` is allowed only to the iManage API origin, over HTTPS, without a
  body, and only for paths matching the explicit allow-list below.
- ``POST`` is allowed only to the exact OAuth token and device-authorisation
  URLs on the sign-in origin. Nothing else.
- Every other method (PUT, PATCH, DELETE, HEAD, OPTIONS, ...) and every other
  path or host raises ``WriteBlockedError``; nothing leaves the laptop.

Paths are assumptions from iManage's public documentation and must be checked
against BWS's server (DIAGNOSIS §3).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from dms_analytics.config import IManageSettings

_SEG = r"[A-Za-z0-9!._~%\-]+"


class WriteBlockedError(Exception):
    """A request outside the read-only allow-list was attempted."""


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower()


def _base_path(url: str) -> str:
    return urlsplit(url).path.rstrip("/")


@dataclass(frozen=True)
class AllowList:
    api_origin: str
    api_base_path: str
    get_patterns: tuple[re.Pattern[str], ...]
    post_urls: frozenset[str]


def token_url(settings: IManageSettings) -> str:
    return f"{settings.effective_auth_base_url}/auth/oauth2/token"  # VERIFY(V2)


def device_url(settings: IManageSettings) -> str:
    return f"{settings.effective_auth_base_url}/auth/oauth2/device"  # VERIFY(V2)


def authorize_url_base(settings: IManageSettings) -> str:
    return f"{settings.effective_auth_base_url}/auth/oauth2/authorize"  # VERIFY(V2)


def api_prefix(settings: IManageSettings) -> str:
    """Path prefix for library-scoped calls (unescaped, for building URLs)."""
    # VERIFY(V1): cloud and on-prem 10.x expose /work/api/v2/customers/{id}/...
    return f"{_base_path(settings.base_url)}/work/api/v2/customers/{settings.customer_id}"


def build_allow_list(settings: IManageSettings) -> AllowList:
    base = _base_path(settings.base_url)
    p = re.escape(api_prefix(settings))
    lib = rf"{p}/libraries/{_SEG}"
    patterns = (
        rf"^{re.escape(base)}/api$",                         # VERIFY(V1) discovery + user
        rf"^{p}/libraries$",                                  # VERIFY(V1)
        rf"^{lib}/workspaces/search$",                        # VERIFY(V1,V4) GET search
        rf"^{lib}/workspaces/{_SEG}$",                        # VERIFY(V1)
        rf"^{lib}/workspaces/{_SEG}/children$",               # VERIFY(V1)
        rf"^{lib}/folders/{_SEG}/children$",                  # VERIFY(V1)
        rf"^{lib}/folders/{_SEG}/documents$",                 # VERIFY(V1,V4)
        rf"^{lib}/documents/{_SEG}/versions$",                # VERIFY(V5)
    )
    return AllowList(
        api_origin=_origin(settings.base_url),
        api_base_path=base,
        get_patterns=tuple(re.compile(x) for x in patterns),
        post_urls=frozenset({token_url(settings).lower(), device_url(settings).lower()}),
    )


def check_request(request: httpx.Request, allow: AllowList) -> None:
    """Raise WriteBlockedError unless the request is on the read-only allow-list."""
    method = request.method.upper()
    url = request.url
    if url.scheme != "https":
        raise WriteBlockedError(f"blocked: non-HTTPS request ({method})")
    path = url.path
    if ".." in path.split("/") or "//" in path:
        raise WriteBlockedError(f"blocked: suspicious path ({method})")
    origin = f"{url.scheme}://{url.netloc.decode('ascii')}".lower()
    if method == "GET":
        if origin != allow.api_origin:
            raise WriteBlockedError("blocked: GET to a host that is not the iManage API")
        if request.headers.get("content-length", "0") not in ("", "0"):
            raise WriteBlockedError("blocked: GET with a body")
        if not any(p.match(path) for p in allow.get_patterns):
            raise WriteBlockedError("blocked: GET path is not on the read-only allow-list")
        return
    if method == "POST":
        bare = f"{origin}{path}".lower()
        if bare in allow.post_urls and not url.query:
            return
        raise WriteBlockedError("blocked: POST is only allowed to the OAuth token endpoint")
    raise WriteBlockedError(f"blocked: HTTP method {method} is never allowed")


class GuardedTransport(httpx.AsyncBaseTransport):
    def __init__(self, inner: httpx.AsyncBaseTransport, allow: AllowList) -> None:
        self.inner = inner
        self.allow = allow

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        check_request(request, self.allow)
        return await self.inner.handle_async_request(request)

    async def aclose(self) -> None:
        await self.inner.aclose()
