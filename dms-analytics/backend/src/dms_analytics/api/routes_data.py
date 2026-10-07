"""Settings and data routes: /api/settings, /api/data/wipe."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from dms_analytics.analytics import iso_dt
from dms_analytics.api.routes_system import st
from dms_analytics.api.schemas import SettingsUpdate, WipeBody, error
from dms_analytics.api.state import AppState

router = APIRouter()


def _settings(state: AppState) -> dict[str, Any]:
    return {"retention_days": state.retention_days,
            "sample_per_fee_earner": state.sample_per_fee_earner,
            "controls_file": state.controls.source,
            "controls_loaded_at": iso_dt(state.controls.loaded_at)}


@router.get("/api/settings")
def get_settings(request: Request) -> dict[str, Any]:
    return _settings(st(request))


@router.put("/api/settings")
async def put_settings(request: Request) -> Response:
    state = st(request)
    try:
        body = SettingsUpdate.model_validate(await request.json())
    except (ValidationError, ValueError):
        return error(400, "invalid_request",
                     "retention_days must be 1-365 and sample_per_fee_earner 1-10.")
    if body.retention_days is not None:
        state.repo.set_setting("retention_days", str(body.retention_days))
    if body.sample_per_fee_earner is not None:
        state.repo.set_setting("sample_per_fee_earner", str(body.sample_per_fee_earner))
    return JSONResponse(_settings(state))


@router.post("/api/data/wipe", status_code=204)
async def wipe(request: Request) -> Response:
    try:
        WipeBody.model_validate(await request.json())
    except (ValidationError, ValueError):
        return error(400, "invalid_request", 'Send {"confirm": true} to wipe local data.')
    await run_in_threadpool(st(request).wipe)
    return Response(status_code=204)
