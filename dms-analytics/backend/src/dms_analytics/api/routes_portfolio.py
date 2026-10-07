"""Portfolio routes: filters, controls, summary, breakdown, trend."""

from __future__ import annotations

from datetime import date
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request

from dms_analytics import analytics
from dms_analytics.api.routes_system import st
from dms_analytics.controls.engine import control_definitions

router = APIRouter()

StatusQ = Annotated[Literal["open", "closed", "all"], Query()]


def scope_filters(practice_area: str | None = None, partner_id: str | None = None,
                  fee_earner_id: str | None = None, office: str | None = None,
                  status: str = "open", opened_from: date | None = None,
                  opened_to: date | None = None) -> analytics.Filters:
    return analytics.Filters(practice_area=practice_area, partner_id=partner_id,
                             fee_earner_id=fee_earner_id, office=office, status=status,
                             opened_from=opened_from, opened_to=opened_to)


@router.get("/api/filters")
def filters(request: Request) -> dict[str, Any]:
    return analytics.facets(st(request).frame())


@router.get("/api/controls")
def controls(request: Request) -> list[dict[str, Any]]:
    return [{"id": d.id, "name": d.name, "category": d.category, "description": d.description,
             "severity": d.severity, "basis": "imanage_filing", "configured": d.configured}
            for d in control_definitions(st(request).controls)]


@router.get("/api/portfolio/summary")
def summary(request: Request, practice_area: str | None = None, partner_id: str | None = None,
            fee_earner_id: str | None = None, office: str | None = None,
            status: StatusQ = "open", opened_from: date | None = None,
            opened_to: date | None = None) -> dict[str, Any]:
    state = st(request)
    f = scope_filters(practice_area, partner_id, fee_earner_id, office, status, opened_from,
                      opened_to)
    return analytics.summary(state.frame(), f, state.clock().date(), state.repo.coverage()[0])


@router.get("/api/portfolio/breakdown")
def breakdown(request: Request,
              dimension: Annotated[Literal["practice_area", "partner", "fee_earner", "office",
                                           "opened_month"], Query()],
              practice_area: str | None = None, partner_id: str | None = None,
              fee_earner_id: str | None = None, office: str | None = None,
              status: StatusQ = "open", opened_from: date | None = None,
              opened_to: date | None = None) -> dict[str, Any]:
    f = scope_filters(practice_area, partner_id, fee_earner_id, office, status, opened_from,
                      opened_to)
    return analytics.breakdown(st(request).frame(), f, dimension)


@router.get("/api/portfolio/trend")
def trend(request: Request, control_id: str | None = None,
          date_from: Annotated[date | None, Query(alias="from")] = None,
          date_to: Annotated[date | None, Query(alias="to")] = None) -> dict[str, Any]:
    return analytics.trend(st(request).repo, control_id, date_from, date_to)
