"""Analytics: every metric matches its catalogue definition (ARCHITECTURE §3)."""

from __future__ import annotations

from collections import Counter
from datetime import date, timedelta
from typing import Any

from fastapi.testclient import TestClient

from dms_analytics.api.state import AppState
from dms_analytics.controls.sampling import Candidate, draw_sample
from tests.conftest import NOW

FAILING = {"late", "missing", "stale"}


def all_matters(c: TestClient, **params: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page = 1
    while True:
        body = c.get("/api/matters", params={**params, "page": page, "page_size": 200}).json()
        items.extend(body["items"])
        if len(items) >= body["total"]:
            return items
        page += 1


def test_summary_matches_definitions(synced: tuple[TestClient, AppState]) -> None:
    c, _ = synced
    s = c.get("/api/portfolio/summary").json()
    ms = all_matters(c)
    assert s["scope"]["matters"] == len(ms) == s["scope"]["open_matters"]
    scores = [m["risk_score"] for m in ms if m["risk_score"] is not None]
    assert s["readiness"] == round(sum(100 - x for x in scores) / len(scores), 1)
    assert s["high_risk_matters"] == sum(1 for x in scores if x >= 50)
    assert s["exceptions_open"] == sum(len(m["failing_controls"]) for m in ms)
    for t in s["controls"]:
        assessed = t["pass"] + t["late"] + t["missing"] + t["stale"]
        assert t["applicable"] == assessed + t["pending"]
        assert t["pass"] + t["late"] + t["missing"] + t["stale"] + t["pending"] + \
            t["not_applicable"] + t["unknown"] == len(ms)
        expected = None if assessed == 0 else round(t["pass"] / assessed, 3)
        assert t["compliance_rate"] == expected
    assert "60 workspaces" in s["coverage_note"] and "1 library" in s["coverage_note"]


def test_risk_score_per_matter(synced: tuple[TestClient, AppState]) -> None:
    c, state = synced
    sev = state.controls.severity
    for m in all_matters(c)[:15]:
        d = c.get(f"/api/matters/{m['id']}").json()
        app = sum(sev[r["control_id"]] for r in d["controls"]
                  if r["status"] in FAILING | {"pass"})
        fail = sum(sev[r["control_id"]] for r in d["controls"] if r["status"] in FAILING)
        assert d["risk_score"] == (None if app == 0 else round(100 * fail / app, 1))
        assert d["failing_controls"] == [r["control_id"] for r in d["controls"]
                                         if r["status"] in FAILING]


def test_status_scope_and_filters(synced: tuple[TestClient, AppState]) -> None:
    c, _ = synced
    open_ms = all_matters(c)
    closed = all_matters(c, status="closed")
    everything = all_matters(c, status="all")
    assert len(open_ms) + len(closed) == len(everything) == 60
    assert all(m["status"] == "closed" for m in closed)
    f = c.get("/api/filters").json()
    area = f["practice_areas"][0]
    assert all(m["practice_area"] == area for m in all_matters(c, practice_area=area))
    fe = f["fee_earners"][0]["id"]
    assert all(m["fee_earner"]["id"] == fe for m in all_matters(c, status="all",
                                                                 fee_earner_id=fe))
    ranged = all_matters(c, status="all", opened_from="2024-01-01", opened_to="2024-12-31")
    assert ranged and all(m["opened_at"].startswith("2024") for m in ranged)
    assert f["opened_range"]["min"] <= f["opened_range"]["max"]


def test_search_failing_control_and_min_risk(synced: tuple[TestClient, AppState]) -> None:
    c, _ = synced
    sample = all_matters(c, status="all")[0]
    hits = all_matters(c, status="all", q=sample["matter_code"].lower())
    assert sample["id"] in {m["id"] for m in hits}
    assert all_matters(c, status="all", q="no-such-thing-xyz") == []
    for m in all_matters(c, failing_control="EL2"):
        assert "EL2" in m["failing_controls"]
    for m in all_matters(c, min_risk=30):
        assert m["risk_score"] is not None and m["risk_score"] >= 30


def test_sorting(synced: tuple[TestClient, AppState]) -> None:
    c, _ = synced
    risks = [m["risk_score"] for m in all_matters(c, sort="risk_desc", status="all")]
    non_null = [r for r in risks if r is not None]
    assert non_null == sorted(non_null, reverse=True)
    assert risks[:len(non_null)] == non_null  # nulls last
    opened = [m["opened_at"] for m in all_matters(c, sort="opened_asc", status="all")]
    assert opened == sorted(opened)
    codes = [m["matter_code"] for m in all_matters(c, sort="matter_code", status="all")]
    assert codes == sorted(codes)


def test_breakdown_partitions_scope(synced: tuple[TestClient, AppState]) -> None:
    c, _ = synced
    total = c.get("/api/portfolio/summary").json()
    for dim in ("practice_area", "partner", "fee_earner", "office", "opened_month"):
        b = c.get("/api/portfolio/breakdown", params={"dimension": dim}).json()
        assert sum(r["matters"] for r in b["rows"]) == total["scope"]["matters"]
        for cid_idx, t in enumerate(total["controls"]):
            assert sum(r["cells"][cid_idx]["passing"] for r in b["rows"]) == t["pass"]
            assert sum(r["cells"][cid_idx]["applicable"] for r in b["rows"]) == \
                t["pass"] + t["late"] + t["missing"] + t["stale"]
    months = [r["key"] for r in c.get("/api/portfolio/breakdown",
                                      params={"dimension": "opened_month"}).json()["rows"]]
    assert months == sorted(months)


def test_key_dates(synced: tuple[TestClient, AppState]) -> None:
    c, _ = synced
    today = NOW.date()
    summary = c.get("/api/portfolio/summary").json()["upcoming_key_dates"]
    for n in (30, 60, 90):
        items = c.get("/api/key-dates", params={"within_days": n}).json()
        assert len(items) == summary[f"d{n}"]
        for it in items:
            kd = date.fromisoformat(it["key_date"])
            assert today <= kd <= today + timedelta(days=n)
            assert it["days_until"] == (kd - today).days
            assert it["matter"]["status"] == "open"
        assert [i["key_date"] for i in items] == sorted(i["key_date"] for i in items)
    assert c.get("/api/key-dates", params={"within_days": 45}).status_code == 400


def test_matter_detail(synced: tuple[TestClient, AppState]) -> None:
    c, _ = synced
    m = all_matters(c, status="all", sort="risk_desc")[0]
    d = c.get(f"/api/matters/{m['id']}").json()
    assert [r["control_id"] for r in d["controls"]] == [
        "FO1", "CF1", "AML1", "AML2", "EL1", "EL2", "AN1", "CD1", "FE1", "FE2", "HY1"]
    assert all(r["basis"] == "imanage_filing" and r["explanation"] for r in d["controls"])
    ats = [e["at"] for e in d["timeline"]]
    assert ats == sorted(ats) and d["timeline"][0]["kind"] in ("opened", "evidence")
    assert sum(x["count"] for x in d["doc_type_counts"]) == d["doc_count"]
    with_evidence = [r for r in d["controls"] if r["evidence"]]
    assert with_evidence and all(e["filed_at"] for r in with_evidence for e in r["evidence"])


def test_exceptions(synced: tuple[TestClient, AppState]) -> None:
    c, _ = synced
    body = c.get("/api/exceptions", params={"page_size": 200}).json()
    assert body["total"] == c.get("/api/portfolio/summary").json()["exceptions_open"]
    sev = [i["severity"] for i in body["items"]]
    assert sev == sorted(sev, reverse=True)
    assert all(i["status"] in FAILING and i["explanation"] for i in body["items"])
    missing = c.get("/api/exceptions", params={"status": "missing", "control_id": "FO1"}).json()
    assert all(i["status"] == "missing" and i["control_id"] == "FO1" for i in missing["items"])
    late = c.get("/api/exceptions", params={"sort": "days_late_desc",
                                            "page_size": 200}).json()["items"]
    days = [i["days_late"] for i in late if i["days_late"] is not None]
    assert days == sorted(days, reverse=True)


def test_lexcel_sample_reproducible(synced: tuple[TestClient, AppState]) -> None:
    c, state = synced
    a = c.get("/api/lexcel/sample", params={"seed": 1234}).json()
    b = c.get("/api/lexcel/sample", params={"seed": 1234}).json()
    assert a["items"] == b["items"] and a["seed"] == 1234 and a["per_fee_earner"] == 2
    assert all(1 <= len(i["matters"]) <= 2 for i in a["items"])
    for i in a["items"]:
        assert all(m["fee_earner"]["id"] == i["fee_earner"]["id"] for m in i["matters"])
    fresh = c.get("/api/lexcel/sample").json()
    assert isinstance(fresh["seed"], int)
    assert state.repo.get_setting("last_sample_seed") == str(fresh["seed"])
    c.put("/api/settings", json={"sample_per_fee_earner": 3})
    assert c.get("/api/lexcel/sample", params={"seed": 1}).json()["per_fee_earner"] == 3


def test_sampling_is_weighted_towards_risk() -> None:
    cands = [Candidate("low", "f1", 0.0), Candidate("high", "f1", 80.0)] + [
        Candidate(f"mid{i}", "f1", 10.0) for i in range(3)]
    counts: Counter[str] = Counter()
    for seed in range(400):
        counts.update(draw_sample(cands, 1, seed)["f1"])
    assert counts["high"] > counts["low"] * 5
    assert draw_sample(cands, 1, 99) == draw_sample(list(reversed(cands)), 1, 99)


def test_trend(synced: tuple[TestClient, AppState]) -> None:
    c, _ = synced
    t = c.get("/api/portfolio/trend").json()
    assert t["control_id"] == "ALL" and len(t["points"]) == 13
    assert t["points"][-1]["value"] == c.get("/api/portfolio/summary").json()["readiness"]
    el1 = c.get("/api/portfolio/trend", params={"control_id": "EL1"}).json()
    last = el1["points"][-1]
    assert last["value"] == round(100 * last["passing"] / last["applicable"], 1)
    narrowed = c.get("/api/portfolio/trend", params={"from": NOW.date().isoformat()}).json()
    assert len(narrowed["points"]) == 1


def test_settings_roundtrip_and_validation(synced: tuple[TestClient, AppState]) -> None:
    c, _ = synced
    assert c.get("/api/settings").json()["retention_days"] == 30
    assert c.put("/api/settings", json={"retention_days": 90}).json()["retention_days"] == 90
    assert c.get("/api/settings").json()["retention_days"] == 90
    for bad in ({"retention_days": 366}, {"sample_per_fee_earner": 0},
                {"retention_days": "30"}, {"retention_days": True}):
        assert c.put("/api/settings", json=bad).status_code == 400
    assert c.put("/api/settings", content=b"not json",
                 headers={"content-type": "application/json"}).status_code == 400
