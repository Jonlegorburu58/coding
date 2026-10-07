"""Contract snapshot: every route's response must validate against
docs/dms-analytics/api-contract.yaml, and every contract operation must be
exercised here. Fails if the backend drifts from the contract."""

from __future__ import annotations

import re
from functools import cache
from pathlib import Path
from typing import Any

import httpx
import pytest
import yaml
from fastapi.routing import APIRoute
from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import validate as validate_spec
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from tests.conftest import NOW, AppFactory, SlowMock, local_client, signed_in_client

CONTRACT = Path(__file__).resolve().parents[3] / "docs" / "dms-analytics" / "api-contract.yaml"
URN = "urn:bws:dms-analytics:contract"
NON_CONTRACT_ROUTES = {"/auth/callback", "/", "/{path:path}"}  # see DECISIONS D108


@cache
def spec() -> dict[str, Any]:
    data: dict[str, Any] = yaml.safe_load(CONTRACT.read_text(encoding="utf-8"))
    return data


_formats = FormatChecker()


@_formats.checks("date-time")
def _is_datetime(value: object) -> bool:
    return not isinstance(value, str) or bool(
        re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z", value))


@_formats.checks("date")
def _is_date(value: object) -> bool:
    return not isinstance(value, str) or bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value))


def _escape(token: str) -> str:
    return token.replace("~", "~0").replace("/", "~1")


def response_pointer(path: str, method: str, status: int) -> tuple[str, dict[str, Any]]:
    op = spec()["paths"][path][method]
    resp = op["responses"][str(status)]
    ptr = f"#/paths/{_escape(path)}/{method}/responses/{status}"
    if "$ref" in resp:
        ptr = resp["$ref"]
        name = ptr.split("/")[-1]
        resp = spec()["components"]["responses"][name]
    return ptr, resp


covered: set[tuple[str, str, int]] = set()


def check(response: httpx.Response, path: str, method: str = "get") -> Any:
    """Assert the response matches the contract for (path, method, status)."""
    status = response.status_code
    responses = spec()["paths"][path][method]["responses"]
    assert str(status) in responses, (
        f"{method.upper()} {path} returned {status}, not in contract {sorted(responses)}: "
        f"{response.text[:300]}")
    covered.add((path, method, status))
    ptr, resp = response_pointer(path, method, status)
    content = resp.get("content")
    if not content:
        # No documented body: allow empty, or a human-readable non-JSON message
        # (e.g. /launch 403 shown in the browser), never an undocumented JSON shape.
        if response.content not in (b"", b"null"):
            assert not response.headers.get("content-type", "").startswith(
                "application/json"), f"{path} {status} returned undocumented JSON"
        return None
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    schema = {"$ref": f"{URN}{ptr}/content/application~1json/schema"}
    registry: Registry = Registry().with_resource(
        URN, Resource.from_contents(spec(), default_specification=DRAFT202012))
    validator = Draft202012Validator(schema, registry=registry, format_checker=_formats)
    errors = sorted(validator.iter_errors(body), key=lambda e: list(e.path))
    assert not errors, f"{method.upper()} {path} {status}: " + "; ".join(
        f"{list(e.absolute_path)}: {e.message}" for e in errors[:5])
    return body


def test_contract_file_is_valid_openapi() -> None:
    validate_spec(spec())


def test_every_route_validates_against_contract(make_app: AppFactory) -> None:
    covered.clear()
    app, state = make_app(SlowMock(now=NOW, n_workspaces=60))
    c = signed_in_client(app)

    # --- before any data
    check(c.get("/api/health"), "/api/health")
    s = check(c.get("/api/session"), "/api/session")
    assert s["has_data"] is False and s["last_sync_at"] is None
    check(c.get("/api/sync/status"), "/api/sync/status")
    check(c.get("/api/filters"), "/api/filters")
    check(c.get("/api/portfolio/summary"), "/api/portfolio/summary")
    check(c.get("/api/matters"), "/api/matters")
    check(c.get("/api/portfolio/trend"), "/api/portfolio/trend")
    check(c.post("/api/sync/cancel"), "/api/sync/cancel", "post")  # 409 not running

    # --- sync (start, busy, cancel while running)
    check(c.post("/api/sync/start", json={"kind": "full"}), "/api/sync/start", "post")
    check(c.post("/api/sync/start"), "/api/sync/start", "post")  # 409 busy
    check(c.get("/api/sync/status"), "/api/sync/status")
    assert state.sync.wait(120)
    check(c.post("/api/sync/start", json={"kind": "auto"}), "/api/sync/start", "post")
    check(c.post("/api/sync/cancel"), "/api/sync/cancel", "post")  # 202
    assert state.sync.wait(120)
    check(c.post("/api/sync/start", json={"kind": "reconcile"}), "/api/sync/start", "post")
    assert state.sync.wait(120)
    status = check(c.get("/api/sync/status"), "/api/sync/status")
    assert status["last"]["status"] == "succeeded"

    # --- auth
    check(c.post("/api/auth/sign-out"), "/api/auth/sign-out", "post")
    assert check(c.get("/api/session"), "/api/session")["signed_in"] is False
    check(c.post("/api/sync/start"), "/api/sync/start", "post")  # 409 not signed in
    body = check(c.post("/api/auth/sign-in"), "/api/auth/sign-in", "post")
    assert body["status"] == "signed_in"

    # --- portfolio
    check(c.get("/api/session"), "/api/session")
    filters = check(c.get("/api/filters"), "/api/filters")
    check(c.get("/api/controls"), "/api/controls")
    for status_q in ("open", "closed", "all"):
        check(c.get("/api/portfolio/summary", params={"status": status_q}),
              "/api/portfolio/summary")
    check(c.get("/api/portfolio/summary", params={
        "practice_area": filters["practice_areas"][0], "office": filters["offices"][0],
        "partner_id": filters["partners"][0]["id"], "opened_from": "2020-01-01",
        "opened_to": "2026-12-31"}), "/api/portfolio/summary")
    for dim in ("practice_area", "partner", "fee_earner", "office", "opened_month"):
        check(c.get("/api/portfolio/breakdown", params={"dimension": dim, "status": "all"}),
              "/api/portfolio/breakdown")
    check(c.get("/api/portfolio/breakdown"), "/api/portfolio/breakdown")  # 400
    check(c.get("/api/portfolio/breakdown", params={"dimension": "nope"}),
          "/api/portfolio/breakdown")  # 400
    trend = check(c.get("/api/portfolio/trend"), "/api/portfolio/trend")
    assert len(trend["points"]) >= 13
    check(c.get("/api/portfolio/trend", params={"control_id": "EL1", "from": "2026-01-01",
                                                "to": "2026-12-31"}), "/api/portfolio/trend")

    # --- matters
    for sort in ("risk_desc", "risk_asc", "opened_desc", "opened_asc", "activity_desc",
                 "activity_asc", "matter_code"):
        check(c.get("/api/matters", params={"sort": sort, "status": "all", "page_size": 200}),
              "/api/matters")
    page = check(c.get("/api/matters", params={"q": "fictional", "failing_control": "EL2",
                                               "min_risk": 10}), "/api/matters")
    mid = check(c.get("/api/matters", params={"status": "all"}), "/api/matters")["items"][0]["id"]
    detail = check(c.get(f"/api/matters/{mid}"), "/api/matters/{matter_id}")
    assert len(detail["controls"]) == 11
    check(c.get("/api/matters/NOPE!0"), "/api/matters/{matter_id}")  # 404
    assert page["page_size"] == 50

    check(c.get("/api/exceptions"), "/api/exceptions")
    for sort in ("severity_desc", "days_late_desc", "opened_desc"):
        check(c.get("/api/exceptions", params={"sort": sort, "status": "missing"}),
              "/api/exceptions")
    check(c.get("/api/exceptions", params={"control_id": "FO1", "page": 2, "page_size": 5}),
          "/api/exceptions")
    for n in (30, 60, 90):
        check(c.get("/api/key-dates", params={"within_days": n}), "/api/key-dates")
    sample = check(c.get("/api/lexcel/sample"), "/api/lexcel/sample")
    check(c.get("/api/lexcel/sample", params={"seed": sample["seed"], "per_fee_earner": 3,
                                              "office": filters["offices"][0]}),
          "/api/lexcel/sample")

    # --- settings and data
    check(c.get("/api/settings"), "/api/settings")
    check(c.put("/api/settings", json={"retention_days": 45}), "/api/settings", "put")
    check(c.put("/api/settings", json={"retention_days": 0}), "/api/settings", "put")  # 400
    check(c.post("/api/data/wipe", json={}), "/api/data/wipe", "post")  # 400
    check(c.post("/api/data/wipe", json={"confirm": False}), "/api/data/wipe", "post")  # 400
    check(c.post("/api/data/wipe", json={"confirm": True}), "/api/data/wipe", "post")
    assert check(c.get("/api/session"), "/api/session")["has_data"] is False

    # --- 401 for every /api operation without credentials
    anon = local_client(app)
    for path, ops in spec()["paths"].items():
        if not path.startswith("/api"):
            continue
        for method in ops:
            url = path.replace("{matter_id}", "x")
            r = anon.request(method.upper(), url)
            assert r.status_code == 401, f"{method.upper()} {path} must require auth"
            if "401" in ops[method]["responses"]:
                check(r, path, method)
            else:
                # Contract gap: /api/health inherits global security but lists no
                # 401. Proposed contract change (see DECISIONS D110).
                assert path == "/api/health"

    # --- /launch
    check(anon.get("/launch", params={"code": "wrong"}), "/launch")
    check(anon.get("/launch", params={"code": state.launch_codes.issue()}), "/launch")

    # every contract operation exercised with a 2xx, every status code at least once
    for path, ops in spec()["paths"].items():
        for method, op in ops.items():
            for status in op["responses"]:
                assert (path, method, int(status)) in covered, \
                    f"not exercised: {method.upper()} {path} -> {status}"


def test_no_routes_outside_contract(make_app: AppFactory) -> None:
    app, _ = make_app()
    contract_ops = {(p, m.upper()) for p, ops in spec()["paths"].items() for m in ops}
    for route in app.routes:
        if not isinstance(route, APIRoute) or route.path in NON_CONTRACT_ROUTES:
            continue
        for method in route.methods or set():
            assert (route.path, method) in contract_ops, f"{method} {route.path} not in contract"


@pytest.mark.parametrize("path", ["/api/health", "/api/session"])
def test_openapi_docs_are_not_exposed(make_app: AppFactory, path: str) -> None:
    app, _ = make_app()
    c = signed_in_client(app)
    assert c.get("/openapi.json").headers["content-type"].startswith("text/html")  # SPA
    assert c.get("/docs").headers["content-type"].startswith("text/html")
    assert c.get(path).status_code == 200
