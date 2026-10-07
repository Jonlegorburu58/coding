"""Matter routes: list, detail, exceptions, key dates, Lexcel sample."""

from __future__ import annotations

from datetime import date
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, Response

from dms_analytics import analytics
from dms_analytics.api.routes_portfolio import StatusQ, scope_filters
from dms_analytics.api.routes_system import st
from dms_analytics.api.schemas import error

router = APIRouter()

PageQ = Annotated[int, Query(ge=1)]
PageSizeQ = Annotated[int, Query(ge=1, le=200)]


@router.get("/api/matters")
def matters(request: Request, q: str | None = None, practice_area: str | None = None,
            partner_id: str | None = None, fee_earner_id: str | None = None,
            office: str | None = None, status: StatusQ = "open",
            opened_from: date | None = None, opened_to: date | None = None,
            failing_control: str | None = None,
            min_risk: Annotated[float | None, Query(ge=0, le=100)] = None,
            sort: Annotated[Literal["risk_desc", "risk_asc", "opened_desc", "opened_asc",
                                    "activity_desc", "activity_asc", "matter_code"],
                            Query()] = "risk_desc",
            page: PageQ = 1, page_size: PageSizeQ = 50) -> dict[str, Any]:
    f = scope_filters(practice_area, partner_id, fee_earner_id, office, status, opened_from,
                      opened_to)
    return analytics.list_matters(st(request).frame(), f, q=q, failing_control=failing_control,
                                  min_risk=min_risk, sort=sort, page=page, page_size=page_size)


@router.get("/api/matters/{matter_id}")
def matter(request: Request, matter_id: str) -> Response:
    state = st(request)
    detail = analytics.matter_detail(state.repo, state.frame(), state.controls, matter_id)
    if detail is None:
        return error(404, "not_found", "No matter with that ID is in your local data.")
    return JSONResponse(detail)


@router.get("/api/exceptions")
def exceptions(request: Request, control_id: str | None = None,
               status: Annotated[Literal["late", "missing", "stale"] | None, Query()] = None,
               practice_area: str | None = None, partner_id: str | None = None,
               fee_earner_id: str | None = None, office: str | None = None,
               sort: Annotated[Literal["severity_desc", "days_late_desc", "opened_desc"],
                               Query()] = "severity_desc",
               page: PageQ = 1, page_size: PageSizeQ = 50) -> dict[str, Any]:
    state = st(request)
    f = scope_filters(practice_area, partner_id, fee_earner_id, office, "open")
    return analytics.exceptions(state.frame(), state.controls, f, control_id=control_id,
                                status=status, sort=sort, page=page, page_size=page_size)


@router.get("/api/key-dates")
def key_dates(request: Request, within_days: int = 30) -> Response:
    if within_days not in (30, 60, 90):
        return error(400, "invalid_request", "within_days must be 30, 60 or 90.")
    state = st(request)
    return JSONResponse(analytics.key_dates(state.frame(), within_days, state.clock().date()))


@router.get("/api/lexcel/sample")
def lexcel_sample(request: Request,
                  per_fee_earner: Annotated[int | None, Query(ge=1, le=10)] = None,
                  seed: int | None = None, practice_area: str | None = None,
                  office: str | None = None) -> dict[str, Any]:
    state = st(request)
    n = per_fee_earner or state.sample_per_fee_earner
    result = analytics.lexcel_sample(state.frame(), per_fee_earner=n, seed=seed,
                                     practice_area=practice_area, office=office,
                                     now=state.clock())
    state.repo.set_setting("last_sample_seed", str(result["seed"]))
    return result
