"""Local API security: loopback only, Host check, launch code, cookie + header, no CORS."""

from __future__ import annotations

import pytest

from dms_analytics.api.app import create_app
from dms_analytics.security import (
    DEV_LAUNCH_CODE,
    LaunchCodes,
    UnsafeBindError,
    assert_loopback_bind,
)
from tests.conftest import API_HEADERS, AppFactory, local_client, signed_in_client


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.168.1.10", "localhost", ""])  # noqa: S104
def test_refuses_to_bind_anywhere_but_loopback(host: str) -> None:
    with pytest.raises(UnsafeBindError):
        assert_loopback_bind(host)
    assert_loopback_bind("127.0.0.1")


def test_create_app_refuses_non_loopback_host(make_app: AppFactory) -> None:
    with pytest.raises(UnsafeBindError):
        make_app(host="0.0.0.0")  # noqa: S104


def test_missing_cookie_or_header_is_401(make_app: AppFactory) -> None:
    app, state = make_app()
    anon = local_client(app)
    assert anon.get("/api/health").status_code == 401
    assert anon.get("/api/health", headers=API_HEADERS).status_code == 401
    c = local_client(app)
    assert c.get(f"/launch?code={state.launch_codes.issue()}").status_code == 302
    assert c.get("/api/health").status_code == 401  # cookie but no header
    assert c.get("/api/health", headers={"X-DMS-Analytics": "0"}).status_code == 401
    assert c.get("/api/health", headers=API_HEADERS).status_code == 200
    body = anon.get("/api/session").json()
    assert body["code"] == "unauthorized"


def test_forged_cookie_is_401(make_app: AppFactory) -> None:
    app, _ = make_app()
    c = local_client(app)
    c.cookies.set("session", "forged-value")
    assert c.get("/api/health", headers=API_HEADERS).status_code == 401


@pytest.mark.parametrize("host", ["evil.example", "evil.example:8765", "127.0.0.1",
                                  "127.0.0.1:9999", "localhost.evil.example:8765",
                                  "0.0.0.0:8765"])
def test_wrong_host_header_is_rejected(make_app: AppFactory, host: str) -> None:
    app, _ = make_app()
    c = signed_in_client(app)
    r = c.get("/api/health", headers={"Host": host})
    assert r.status_code == 400
    assert c.get("/", headers={"Host": host}).status_code == 400


def test_localhost_host_header_is_accepted(make_app: AppFactory) -> None:
    app, _ = make_app()
    c = signed_in_client(app)
    assert c.get("/api/health", headers={"Host": "localhost:8765"}).status_code == 200


@pytest.mark.parametrize("peer", ["10.0.0.5", "192.168.1.20", "testclient"])
def test_non_local_peer_is_refused(make_app: AppFactory, peer: str) -> None:
    app, state = make_app()
    c = local_client(app, peer=peer)
    assert c.get(f"/launch?code={state.launch_codes.issue()}").status_code == 403
    assert c.get("/api/health", headers=API_HEADERS).status_code == 403
    assert c.get("/").status_code == 403


def test_launch_code_is_single_use(make_app: AppFactory) -> None:
    app, state = make_app()
    code = state.launch_codes.issue()
    c = local_client(app)
    r = c.get(f"/launch?code={code}")
    assert r.status_code == 302 and r.headers["location"] == "/"
    cookie = r.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=Strict" in cookie and "Path=/" in cookie
    assert local_client(app).get(f"/launch?code={code}").status_code == 403
    assert local_client(app).get("/launch?code=").status_code == 403
    assert local_client(app).get("/launch").status_code == 403


def test_launch_code_expires_after_60s() -> None:
    t = [1000.0]
    codes = LaunchCodes(clock=lambda: t[0])
    code = codes.issue()
    t[0] += 61
    assert codes.redeem(code) is False
    fresh = codes.issue()
    t[0] += 59
    assert codes.redeem(fresh) is True


def test_dev_code_only_in_dev_mode_and_only_once(make_app: AppFactory, tmp_path) -> None:  # type: ignore[no-untyped-def]
    app, _ = make_app()
    assert local_client(app).get(f"/launch?code={DEV_LAUNCH_CODE}").status_code == 403
    dev_app, _ = make_app(dev=True, data_dir=tmp_path / "dev-data")
    assert local_client(dev_app).get(f"/launch?code={DEV_LAUNCH_CODE}").status_code == 302
    assert local_client(dev_app).get(f"/launch?code={DEV_LAUNCH_CODE}").status_code == 403


def test_dev_mode_refused_in_live_mode(settings, backend) -> None:  # type: ignore[no-untyped-def]
    from dataclasses import replace

    from dms_analytics.adapters.mock import MockDmsAdapter
    with pytest.raises(RuntimeError):
        create_app(replace(settings, mode="live", dev=True), secret_backend=backend,
                   adapter=MockDmsAdapter(n_workspaces=5))


def test_launch_codes_never_accept_dev_unless_enabled() -> None:
    assert LaunchCodes(dev=False).redeem(DEV_LAUNCH_CODE) is False


def test_no_cors_headers_even_for_preflight(make_app: AppFactory) -> None:
    app, _ = make_app()
    c = signed_in_client(app)
    origin = {"Origin": "https://evil.example"}
    r = c.get("/api/health", headers=origin)
    assert r.status_code == 200
    assert not any(h.lower().startswith("access-control-") for h in r.headers)
    pre = local_client(app).options("/api/health", headers={
        **origin, "Access-Control-Request-Method": "GET"})
    assert pre.status_code in (401, 405)
    assert not any(h.lower().startswith("access-control-") for h in pre.headers)


def test_security_headers(make_app: AppFactory) -> None:
    app, _ = make_app()
    c = signed_in_client(app)
    r = c.get("/api/health")
    assert "default-src 'self'" in r.headers["content-security-policy"]
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["cache-control"] == "no-store"
    assert "server" not in r.headers or "uvicorn" not in r.headers["server"].lower()


def test_static_ui_and_spa_fallback(make_app: AppFactory) -> None:
    app, _ = make_app()
    c = local_client(app)
    root = c.get("/")
    assert root.status_code == 200 and "<!doctype html>" in root.text.lower()
    assert c.get("/matters/123").text == root.text
    assert c.get("/../../etc/passwd").text == root.text
    assert c.get("/%2e%2e/%2e%2e/etc/passwd").text == root.text
    api_unknown = signed_in_client(app).get("/api/nope")
    assert api_unknown.status_code == 404 and api_unknown.json()["code"] == "not_found"


def test_sign_out_keeps_local_session_but_clears_dms(make_app: AppFactory) -> None:
    app, state = make_app()
    c = signed_in_client(app)
    assert c.post("/api/auth/sign-out").status_code == 204
    assert c.post("/api/auth/sign-out").status_code == 204  # idempotent
    assert c.get("/api/session").json()["signed_in"] is False
    assert state.adapter.is_signed_in() is False
