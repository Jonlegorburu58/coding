"""Sync routes: /api/sync/status, /api/sync/start, /api/sync/cancel."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from dms_analytics.adapters.base import AdapterError
from dms_analytics.analytics import iso_dt
from dms_analytics.api.routes_system import st
from dms_analytics.api.schemas import SyncStartBody, error
from dms_analytics.controls.rules import ControlsConfigError
from dms_analytics.sync.engine import SyncBusyError, SyncNotRunningError

router = APIRouter()


def _run(run: dict[str, Any] | None) -> dict[str, Any] | None:
    if run is None:
        return None
    return {**run, "started_at": iso_dt(run["started_at"]),
            "finished_at": iso_dt(run.get("finished_at")),
            "workspaces_done": int(run.get("workspaces_done") or 0),
            "documents_seen": int(run.get("documents_seen") or 0)}


def _status(request: Request) -> dict[str, Any]:
    s = st(request).sync.status()
    return {"state": s["state"], "current": _run(s["current"]), "last": _run(s["last"])}


@router.get("/api/sync/status")
def sync_status(request: Request) -> dict[str, Any]:
    return _status(request)


@router.post("/api/sync/start", status_code=202)
def sync_start(request: Request, body: SyncStartBody | None = None) -> Response:
    state = st(request)
    kind = body.kind if body else "auto"
    try:
        state.controls_for_sync()
        state.sync.start(kind)
    except SyncBusyError:
        return error(409, "sync_running", "A sync is already running.")
    except ControlsConfigError as exc:
        return error(409, "controls_invalid", str(exc))
    except AdapterError:
        return error(409, "not_signed_in", "Sign in to the DMS before syncing.")
    return JSONResponse(_status(request), status_code=202)


@router.post("/api/sync/cancel", status_code=202)
def sync_cancel(request: Request) -> Response:
    try:
        st(request).sync.cancel()
    except SyncNotRunningError:
        return error(409, "sync_not_running", "No sync is running.")
    return Response(status_code=202)
