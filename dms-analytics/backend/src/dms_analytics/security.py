"""Local-API security (ARCHITECTURE §6, DECISIONS D5).

- The server binds to 127.0.0.1 only (``assert_loopback_bind``).
- Every request must come from a loopback peer and carry a ``Host`` header of
  ``127.0.0.1:<port>`` or ``localhost:<port>`` (defeats DNS rebinding).
- A single-use launch code (60 s) is exchanged at ``/launch`` for a session
  cookie (``HttpOnly; SameSite=Strict; Path=/``).
- Every ``/api`` request needs that cookie **and** ``X-DMS-Analytics: 1``.
- No CORS headers are ever sent. Responses carry a strict CSP.
"""

from __future__ import annotations

import hmac
import json
import logging
import secrets
import threading
import time
from collections.abc import Awaitable, Callable, MutableMapping
from http.cookies import SimpleCookie
from typing import Any

from dms_analytics.config import LOOPBACK_HOST
from dms_analytics.logging import log_event

log = logging.getLogger(__name__)

LAUNCH_CODE_TTL_S = 60.0
DEV_LAUNCH_CODE = "dev"
SESSION_COOKIE = "session"
APP_HEADER = "x-dms-analytics"
LOOPBACK_PEERS = frozenset({"127.0.0.1", "::1"})

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

SECURITY_HEADERS: list[tuple[bytes, bytes]] = [
    (b"content-security-policy",
     b"default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; "
     b"frame-ancestors 'none'; form-action 'self'"),
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-resource-policy", b"same-origin"),
]


class UnsafeBindError(Exception):
    pass


def assert_loopback_bind(host: str) -> None:
    """Refuse to serve on anything but 127.0.0.1."""
    if host != LOOPBACK_HOST:
        raise UnsafeBindError(f"refusing to bind to {host!r}; only {LOOPBACK_HOST} is allowed")


class LaunchCodes:
    """Single-use, short-lived codes that bootstrap the browser session."""

    def __init__(self, dev: bool = False, ttl_s: float = LAUNCH_CODE_TTL_S,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._codes: dict[str, float] = {}
        self._dev_available = dev
        self._ttl = ttl_s
        self._clock = clock
        self._lock = threading.Lock()

    def issue(self) -> str:
        code = secrets.token_urlsafe(32)
        with self._lock:
            self._codes[code] = self._clock() + self._ttl
        return code

    def redeem(self, code: str | None) -> bool:
        if not code:
            return False
        now = self._clock()
        with self._lock:
            for c in [c for c, exp in self._codes.items() if exp < now]:
                del self._codes[c]
            if self._dev_available and hmac.compare_digest(code, DEV_LAUNCH_CODE):
                self._dev_available = False  # single use per process start
                return True
            match = next((c for c in self._codes if hmac.compare_digest(c, code)), None)
            if match is None:
                return False
            del self._codes[match]
            return True


class Sessions:
    def __init__(self) -> None:
        self._tokens: set[str] = set()
        self._lock = threading.Lock()

    def issue(self) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._tokens.add(token)
        return token

    def valid(self, token: str | None) -> bool:
        if not token:
            return False
        with self._lock:
            return any(hmac.compare_digest(t, token) for t in self._tokens)

    def revoke_all(self) -> None:
        with self._lock:
            self._tokens.clear()


def session_cookie_header(token: str) -> str:
    return f"{SESSION_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/"


def _headers(scope: Scope) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in scope.get("headers", []):
        out.setdefault(k.decode("latin-1").lower(), v.decode("latin-1"))
    return out


def _cookie(header: str | None, name: str) -> str | None:
    if not header:
        return None
    jar: SimpleCookie = SimpleCookie()
    try:
        jar.load(header)
    except Exception:
        return None
    morsel = jar.get(name)
    return morsel.value if morsel else None


class SecurityMiddleware:
    """Pure ASGI middleware: peer, Host, cookie+header checks and security headers."""

    def __init__(self, app: ASGIApp, *, port: int, sessions: Sessions) -> None:
        self.app = app
        self.sessions = sessions
        self.allowed_hosts = {f"{LOOPBACK_HOST}:{port}", f"localhost:{port}"}

    async def _reject(self, send: Send, status: int, code: str, message: str) -> None:
        body = json.dumps({"code": code, "message": message}).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode()),
                                (b"cache-control", b"no-store"), *SECURITY_HEADERS]})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope["type"] != "http":  # no websockets
            return
        client = scope.get("client")
        peer = client[0] if client else None
        if peer not in LOOPBACK_PEERS:
            log_event(log, "request_rejected", logging.WARNING, status_code=403)
            await self._reject(send, 403, "forbidden", "Only local connections are allowed.")
            return
        headers = _headers(scope)
        if headers.get("host", "").lower() not in self.allowed_hosts:
            log_event(log, "request_rejected", logging.WARNING, status_code=400)
            await self._reject(send, 400, "bad_host", "Invalid Host header.")
            return
        path: str = scope.get("path", "")
        if path == "/api" or path.startswith("/api/"):
            token = _cookie(headers.get("cookie"), SESSION_COOKIE)
            if headers.get(APP_HEADER) != "1" or not self.sessions.valid(token):
                await self._reject(send, 401, "unauthorized",
                                   "Your session has expired. Close this tab and start the app "
                                   "again.")
                return

        is_api = path.startswith("/api")
        started = time.perf_counter()
        status_holder: dict[str, int] = {}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = int(message["status"])
                hdrs = [h for h in message.get("headers", [])
                        if not h[0].lower().startswith(b"access-control-")]
                hdrs.extend(SECURITY_HEADERS)
                if is_api:
                    hdrs.append((b"cache-control", b"no-store"))
                message["headers"] = hdrs
            await send(message)

        await self.app(scope, receive, send_wrapper)
        route = scope.get("route")
        log_event(log, "request", logging.DEBUG, method=scope.get("method"),
                  route=getattr(route, "path", None) if route else None,
                  status_code=status_holder.get("status"),
                  duration_ms=round((time.perf_counter() - started) * 1000, 1))
