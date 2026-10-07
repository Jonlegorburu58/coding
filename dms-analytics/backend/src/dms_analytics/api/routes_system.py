"""System, auth and session routes: /launch, /api/health, /api/session, /api/auth/*."""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import (
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    RedirectResponse,
    Response,
)

from dms_analytics.adapters.base import AdapterError
from dms_analytics.analytics import iso_dt
from dms_analytics.api.schemas import error
from dms_analytics.api.state import AppState
from dms_analytics.config import APP_VERSION
from dms_analytics.logging import log_event
from dms_analytics.security import session_cookie_header

log = logging.getLogger(__name__)
router = APIRouter()


def st(request: Request) -> AppState:
    state: AppState = request.app.state.dms
    return state


@router.get("/launch", include_in_schema=False)
def launch(request: Request, code: Annotated[str | None, Query()] = None) -> Response:
    state = st(request)
    if not state.launch_codes.redeem(code):
        log_event(log, "launch_rejected", logging.WARNING)
        return PlainTextResponse("This launch link is invalid, already used or expired. "
                                 "Start the app again.", status_code=403)
    token = state.sessions.issue()
    resp = RedirectResponse("/", status_code=302)
    resp.headers.append("set-cookie", session_cookie_header(token))
    resp.headers["cache-control"] = "no-store"
    log_event(log, "launch_accepted")
    return resp


@router.get("/auth/callback", include_in_schema=False)
async def auth_callback(request: Request, code: str | None = None,
                        state: str | None = None) -> Response:
    """Live mode only: OAuth loopback redirect target (PKCE). Not part of the
    JSON API; validated by the PKCE ``state`` and verifier instead of the cookie."""
    app_state = st(request)
    complete = getattr(app_state.adapter, "complete_pkce", None)
    if complete is None or not code or not state:
        return PlainTextResponse("Not found", status_code=404)
    try:
        await complete(code, state)
    except AdapterError:
        return HTMLResponse("<!doctype html><title>Sign-in failed</title>"
                            "<p>Sign-in failed. Close this tab and try again from the app.</p>",
                            status_code=400)
    return HTMLResponse("<!doctype html><title>Signed in</title>"
                        "<p>Signed in to iManage. You can close this tab and return to the "
                        "app.</p>")


@router.get("/api/health")
def health(request: Request) -> dict[str, str]:
    return {"status": "ok", "version": APP_VERSION, "mode": st(request).settings.mode}


@router.get("/api/session")
async def session(request: Request) -> dict[str, object]:
    state = st(request)
    user = None
    if state.adapter.is_signed_in():
        try:
            user = await state.adapter.current_user()
        except AdapterError:
            user = None  # e.g. DMS unreachable; the session view must still load
    libraries, workspaces, documents = state.repo.coverage()
    return {
        "mode": state.settings.mode,
        "signed_in": state.adapter.is_signed_in(),
        "user_display_name": user.display_name if user else None,
        "source_name": state.adapter.source_name,
        "has_data": workspaces > 0,
        "last_sync_at": iso_dt(state.repo.last_successful_sync_at()),
        "coverage": {"libraries": libraries, "workspaces_visible": workspaces,
                     "documents": documents},
    }


@router.post("/api/auth/sign-in")
async def sign_in(request: Request) -> Response:
    state = st(request)
    try:
        result = await state.adapter.sign_in()
    except AdapterError as exc:
        return error(409, "sign_in_failed", str(exc))
    log_event(log, "sign_in_started", status=result.status)
    return JSONResponse({"status": result.status, "verification_url": result.verification_url,
                         "user_code": result.user_code})


@router.post("/api/auth/sign-out", status_code=204)
async def sign_out(request: Request) -> Response:
    await st(request).adapter.sign_out()
    log_event(log, "signed_out")
    return Response(status_code=204)
