"""Delegated OAuth 2.0 for iManage: authorization code + PKCE (loopback
redirect, preferred) or device code (fallback). No client secret is used.

Endpoint paths and parameter names follow the OAuth 2.0 RFCs (6749, 7636,
8628). Their exact iManage URLs are VERIFY(V2); scopes are VERIFY(V3).
All requests go through the guarded HTTP client, so only the token and
device-authorisation POSTs can ever be sent to the sign-in host.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx

from dms_analytics.adapters.base import AdapterError
from dms_analytics.adapters.http_guard import authorize_url_base, device_url, token_url
from dms_analytics.config import IManageSettings


class AuthError(AdapterError):
    pass


class AuthorizationPending(AuthError):
    pass


def make_pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)[:96]
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


@dataclass(frozen=True)
class PkceRequest:
    url: str
    state: str
    verifier: str


@dataclass(frozen=True)
class DeviceStart:
    device_code: str
    user_code: str
    verification_uri: str
    interval: int
    expires_in: int


class OAuthClient:
    def __init__(self, settings: IManageSettings, redirect_uri: str,
                 clock: Callable[[], float] = time.time) -> None:
        self.settings = settings
        self.redirect_uri = redirect_uri
        self.clock = clock

    def pkce_request(self) -> PkceRequest:
        verifier, challenge = make_pkce_pair()
        state = secrets.token_urlsafe(24)
        query = urlencode({
            "response_type": "code",
            "client_id": self.settings.client_id,
            "redirect_uri": self.redirect_uri,
            "scope": " ".join(self.settings.scopes),  # VERIFY(V3)
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        })
        return PkceRequest(f"{authorize_url_base(self.settings)}?{query}", state, verifier)

    def _normalise(self, payload: dict[str, Any], previous_refresh: str | None = None
                   ) -> dict[str, Any]:
        access = payload.get("access_token")
        if not isinstance(access, str) or not access:
            raise AuthError("The sign-in service did not return an access token.")
        expires_in = int(payload.get("expires_in") or 1800)
        return {
            "access_token": access,
            "refresh_token": payload.get("refresh_token") or previous_refresh,
            "expires_at": int(self.clock()) + expires_in,
            "token_type": payload.get("token_type", "Bearer"),
        }

    async def _post(self, http: httpx.AsyncClient, url: str,
                    form: dict[str, str]) -> dict[str, Any]:
        try:
            resp = await http.post(url, data=form, headers={"Accept": "application/json"})
        except httpx.HTTPError as exc:
            raise AuthError(f"Could not reach the sign-in service ({type(exc).__name__}).") \
                from exc
        try:
            payload: dict[str, Any] = resp.json()
        except ValueError:
            payload = {}
        if resp.status_code == 400 and payload.get("error") in ("authorization_pending",
                                                                "slow_down"):
            raise AuthorizationPending(str(payload.get("error")))
        if resp.status_code >= 400:
            # error codes only; never echo error_description (may contain identifiers)
            code = payload.get("error", f"http_{resp.status_code}")
            raise AuthError(f"Sign-in was refused ({code}).")
        return payload

    async def exchange_code(self, http: httpx.AsyncClient, code: str,
                            verifier: str) -> dict[str, Any]:
        payload = await self._post(http, token_url(self.settings), {
            "grant_type": "authorization_code", "code": code,
            "redirect_uri": self.redirect_uri, "client_id": self.settings.client_id,
            "code_verifier": verifier,
        })
        return self._normalise(payload)

    async def refresh(self, http: httpx.AsyncClient, refresh_token: str) -> dict[str, Any]:
        payload = await self._post(http, token_url(self.settings), {
            "grant_type": "refresh_token", "refresh_token": refresh_token,
            "client_id": self.settings.client_id,
        })
        return self._normalise(payload, previous_refresh=refresh_token)

    async def start_device(self, http: httpx.AsyncClient) -> DeviceStart:
        payload = await self._post(http, device_url(self.settings), {
            "client_id": self.settings.client_id, "scope": " ".join(self.settings.scopes),
        })
        try:
            return DeviceStart(
                device_code=str(payload["device_code"]), user_code=str(payload["user_code"]),
                verification_uri=str(payload.get("verification_uri")
                                     or payload.get("verification_url")),
                interval=int(payload.get("interval", 5)),
                expires_in=int(payload.get("expires_in", 900)))
        except (KeyError, ValueError) as exc:
            raise AuthError("Unexpected device-code response from the sign-in service.") \
                from exc

    async def poll_device(self, http: httpx.AsyncClient, device_code: str) -> dict[str, Any]:
        payload = await self._post(http, token_url(self.settings), {
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "device_code": device_code, "client_id": self.settings.client_id,
        })
        return self._normalise(payload)
