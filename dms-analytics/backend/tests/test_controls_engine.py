"""Controls engine: one hand-built fixture per status for every control
(ARCHITECTURE §3), plus the derived measures."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from dms_analytics.controls.engine import (
    DocFacts,
    MatterFacts,
    add_months,
    as_of,
    control_definitions,
    evaluate_matter,
)
from dms_analytics.controls.rules import ControlsConfig, parse_controls
from dms_analytics.controls.scoring import Tally, mean_readiness, readiness, risk_score

NOW = datetime(2026, 10, 7, 12, 0)
_counter = [0]


def doc(day: datetime, cls: str, ctype: str | None, name: str = "Doc (fictional)",
        edited: datetime | None = None) -> DocFacts:
    _counter[0] += 1
    return DocFacts(f"D!{_counter[0]}.1", name, cls, ctype, day, edited or day)


def matter(opened: datetime, status: str = "open", matter_type: str | None = "STANDARD",
           key_date: date | None = None) -> MatterFacts:
    return MatterFacts("M!1", status, matter_type, opened,
                       None if status == "open" else opened + timedelta(days=500), key_date)


def ago(days: int) -> datetime:
    return NOW - timedelta(days=days)


def result(cfg: ControlsConfig, cid: str, m: MatterFacts, docs: list[DocFacts]):  # type: ignore[no-untyped-def]
    out = {o.control_id: o for o in evaluate_matter(m, docs, cfg, NOW)}
    return out[cid]


# ---------------------------------------------------------------- FO1

def test_fo1_pass(cfg: ControlsConfig) -> None:
    o = result(cfg, "FO1", matter(ago(100)), [doc(ago(97), "FILEOPEN", "file_opening")])
    assert o.status == "pass" and o.evidence_doc_ids and "3 days" in o.explanation


def test_fo1_late(cfg: ControlsConfig) -> None:
    o = result(cfg, "FO1", matter(ago(100)), [doc(ago(90), "FILEOPEN", "file_opening")])
    assert o.status == "late" and o.days_late == 5
    assert "allowed 5" in o.explanation


def test_fo1_missing_and_pending(cfg: ControlsConfig) -> None:
    assert result(cfg, "FO1", matter(ago(100)), []).status == "missing"
    o = result(cfg, "FO1", matter(ago(2)), [])
    assert o.status == "pending" and o.due_at == ago(2) + timedelta(days=5)


def test_fo1_boundary_day_5_is_pass(cfg: ControlsConfig) -> None:
    opened = datetime(2026, 1, 1, 9)
    o = result(cfg, "FO1", matter(opened), [doc(datetime(2026, 1, 6, 17), "FILEOPEN",
                                                "file_opening")])
    assert o.status == "pass"


# ---------------------------------------------------------------- CF1 / AML1

@pytest.mark.parametrize(("cid", "cls", "ctype"), [("CF1", "CONFLICT", "conflict_clearance"),
                                                   ("AML1", "AML", "cdd")])
def test_before_first_work_statuses(cfg: ControlsConfig, cid: str, cls: str, ctype: str) -> None:
    m = matter(ago(200))
    work = doc(ago(190), "CORR", None)
    assert result(cfg, cid, m, [doc(ago(195), cls, ctype), work]).status == "pass"
    same_day = result(cfg, cid, m, [doc(ago(190) + timedelta(hours=3), cls, ctype), work])
    assert same_day.status == "pass"  # "on or before": same calendar day passes
    late = result(cfg, cid, m, [work, doc(ago(180), cls, ctype)])
    assert late.status == "late" and late.days_late == 10
    assert result(cfg, cid, m, [work]).status == "missing"
    assert result(cfg, cid, m, []).status == "pending"
    assert result(cfg, cid, m, [doc(ago(199), cls, ctype)]).status == "pass"


def test_intake_documents_are_not_substantive(cfg: ControlsConfig) -> None:
    m = matter(ago(200))
    intake = [doc(ago(199), "FILEOPEN", "file_opening"), doc(ago(198), "ENGAGE",
                                                             "engagement_letter")]
    assert result(cfg, "CF1", m, intake).status == "pending"


def test_aml_exempt_matter_type(cfg: ControlsConfig) -> None:
    m = matter(ago(200), matter_type="INTERNAL")
    assert result(cfg, "AML1", m, []).status == "not_applicable"
    assert result(cfg, "AML2", m, []).status == "not_applicable"


# ---------------------------------------------------------------- AML2

def test_aml2_statuses(cfg: ControlsConfig) -> None:
    m = matter(ago(2000))
    assert result(cfg, "AML2", m, [doc(ago(400), "KYC", "cdd")]).status == "pass"
    stale = result(cfg, "AML2", m, [doc(ago(1200), "KYC", "cdd")])
    assert stale.status == "stale" and stale.days_late and stale.days_late > 0
    assert result(cfg, "AML2", m, []).status == "missing"
    assert result(cfg, "AML2", matter(ago(2000), status="closed"), []).status == \
        "not_applicable"
    # latest CDD counts, not the first
    assert result(cfg, "AML2", m, [doc(ago(1500), "AML", "cdd"),
                                   doc(ago(30), "KYC", "cdd")]).status == "pass"


# ---------------------------------------------------------------- EL1

def test_el1_statuses(cfg: ControlsConfig) -> None:
    m = matter(ago(300))
    work = doc(ago(290), "CORR", None)
    ok = result(cfg, "EL1", m, [work, doc(ago(281), "ENGAGE", "engagement_letter")])
    assert ok.status == "pass" and "9 days" in ok.explanation and "allowed 14" in ok.explanation
    assert result(cfg, "EL1", m, [work, doc(ago(285), "S150", "s150_notice")]).status == "pass"
    late = result(cfg, "EL1", m, [work, doc(ago(270), "ENGAGE", "engagement_letter")])
    assert late.status == "late" and late.days_late == 6
    assert result(cfg, "EL1", m, [work]).status == "missing"
    assert result(cfg, "EL1", m, []).status == "pending"
    recent = result(cfg, "EL1", matter(ago(10)), [doc(ago(5), "CORR", None)])
    assert recent.status == "pending"


# ---------------------------------------------------------------- EL2

def test_el2_statuses(cfg: ControlsConfig) -> None:
    m = matter(ago(300))
    work = doc(ago(290), "CORR", None)
    letter = doc(ago(285), "ENGAGE", "engagement_letter", "Engagement letter (fictional)")
    assert result(cfg, "EL2", m, [work, letter, doc(ago(280), "ENGAGE",
                                                    "engagement_signed")]).status == "pass"
    by_name = doc(ago(280), "ENGAGE", "engagement_letter", "Engagement letter - SIGNED copy")
    assert result(cfg, "EL2", m, [work, letter, by_name]).status == "pass"
    countersigned = doc(ago(280), "ENGAGE", "engagement_letter", "Countersigned terms")
    assert result(cfg, "EL2", m, [work, countersigned]).status == "pass"
    unsigned_word = doc(ago(280), "ENGAGE", "engagement_letter", "Unsigneddraft")
    assert result(cfg, "EL2", m, [work, letter, unsigned_word]).status == "missing"
    assert result(cfg, "EL2", m, [work, letter]).status == "missing"
    assert result(cfg, "EL2", matter(ago(5)), [doc(ago(4), "CORR", None)]).status == "pending"


# ---------------------------------------------------------------- AN1

def test_an1_statuses(cfg: ControlsConfig) -> None:
    m = matter(ago(400))
    active = doc(ago(30), "CORR", None)
    assert result(cfg, "AN1", m, [active, doc(ago(20), "ATTNOTE",
                                              "attendance_note")]).status == "pass"
    assert result(cfg, "AN1", m, [active, doc(ago(120), "ATTNOTE",
                                              "attendance_note")]).status == "missing"
    assert result(cfg, "AN1", m, [doc(ago(200), "CORR", None)]).status == "not_applicable"
    # intake activity alone does not trigger AN1
    assert result(cfg, "AN1", m, [doc(ago(10), "AML", "cdd")]).status == "not_applicable"
    assert result(cfg, "AN1", matter(ago(400), status="closed"),
                  [active]).status == "not_applicable"
    # an old document edited recently counts as activity
    edited = doc(ago(300), "DRAFT", None, edited=ago(5))
    assert result(cfg, "AN1", m, [edited]).status == "missing"


# ---------------------------------------------------------------- CD1

def test_cd1_statuses(cfg: ControlsConfig) -> None:
    assert result(cfg, "CD1", matter(ago(10), key_date=date(2026, 11, 1)), []).status == "pass"
    assert result(cfg, "CD1", matter(ago(10)), []).status == "missing"


def test_cd1_unknown_when_not_mapped() -> None:
    text = """
version: 1
field_map: {client_code: custom1, matter_code: custom2}
doc_types: {file_opening: [{class: FILEOPEN}]}
"""
    cfg = parse_controls(text)
    out = {o.control_id: o for o in evaluate_matter(matter(ago(10)), [], cfg, NOW)}
    assert out["CD1"].status == "unknown"
    assert out["EL1"].status == "unknown"  # no engagement mapping either
    assert out["FO1"].status != "unknown"
    defs = {d.id: d for d in control_definitions(cfg)}
    assert defs["CD1"].configured is False and defs["FO1"].configured is True


# ---------------------------------------------------------------- FE1

def test_fe1_statuses(cfg: ControlsConfig) -> None:
    m = matter(ago(800))
    assert result(cfg, "FE1", m, [doc(ago(100), "COSTS", "costs_update")]).status == "pass"
    assert result(cfg, "FE1", m, [doc(ago(100), "S150", "s150_notice")]).status == "pass"
    stale = result(cfg, "FE1", m, [doc(ago(500), "COSTS", "costs_update")])
    assert stale.status == "stale"
    assert result(cfg, "FE1", m, []).status == "missing"
    assert result(cfg, "FE1", matter(ago(200)), []).status == "not_applicable"
    assert result(cfg, "FE1", matter(ago(800), status="closed"), []).status == "not_applicable"


# ---------------------------------------------------------------- FE2

def test_fe2_statuses(cfg: ControlsConfig) -> None:
    m = matter(ago(800))
    active = doc(ago(20), "CORR", None)
    assert result(cfg, "FE2", m, [active, doc(ago(40), "BILL", "bill")]).status == "pass"
    assert result(cfg, "FE2", m, [active, doc(ago(300), "BILL", "bill")]).status == "stale"
    assert result(cfg, "FE2", m, [active]).status == "missing"
    assert result(cfg, "FE2", m, [doc(ago(400), "CORR", None)]).status == "not_applicable"


# ---------------------------------------------------------------- HY1

def test_hy1_statuses(cfg: ControlsConfig) -> None:
    m = matter(ago(900))
    assert result(cfg, "HY1", m, [doc(ago(30), "CORR", None)]).status == "pass"
    stale = result(cfg, "HY1", m, [doc(ago(400), "CORR", None)])
    assert stale.status == "stale" and "closure" in stale.explanation
    assert result(cfg, "HY1", m, []).status == "stale"  # no docs: opened date counts
    assert result(cfg, "HY1", matter(ago(30)), []).status == "pass"
    assert result(cfg, "HY1", matter(ago(900), status="closed"), []).status == \
        "not_applicable"


def test_every_control_has_an_explanation(cfg: ControlsConfig) -> None:
    outcomes = evaluate_matter(matter(ago(500)), [doc(ago(490), "CORR", None)], cfg, NOW)
    assert [o.control_id for o in outcomes] == ["FO1", "CF1", "AML1", "AML2", "EL1", "EL2",
                                                "AN1", "CD1", "FE1", "FE2", "HY1"]
    assert all(o.explanation.strip() for o in outcomes)


def test_thresholds_come_from_config() -> None:
    text = (CONFIG_TEXT := open_default()).replace("FO1_days: 5", "FO1_days: 20")
    assert text != CONFIG_TEXT
    cfg = parse_controls(text)
    o = result(cfg, "FO1", matter(ago(100)), [doc(ago(90), "FILEOPEN", "file_opening")])
    assert o.status == "pass"


def open_default() -> str:
    from dms_analytics.controls.rules import default_controls_text
    return default_controls_text()


# ---------------------------------------------------------------- derived measures

def test_risk_score_definition(cfg: ControlsConfig) -> None:
    sev = cfg.severity
    statuses = {"FO1": "pass", "CF1": "missing", "AML1": "late", "EL2": "pending",
                "CD1": "unknown", "AN1": "not_applicable", "HY1": "stale"}
    # applicable: FO1 2 + CF1 3 + AML1 3 + HY1 1 = 9; failing: 3 + 3 + 1 = 7
    assert risk_score(statuses, sev) == round(100 * 7 / 9, 1)
    assert readiness(risk_score(statuses, sev)) == round(100 - round(100 * 7 / 9, 1), 1)
    assert risk_score({"EL2": "pending", "CD1": "unknown"}, sev) is None
    assert risk_score({"FO1": "pass"}, sev) == 0.0
    assert mean_readiness([0.0, 50.0, None]) == 75.0
    assert mean_readiness([None]) is None


def test_tally_compliance_rate() -> None:
    t = Tally("EL1")
    for s in ["pass"] * 7 + ["late", "missing", "stale", "pending", "not_applicable",
                             "unknown"]:
        t.add(s)
    assert t.assessed == 10 and t.applicable == 11
    assert t.compliance_rate == 0.7
    assert Tally("X").compliance_rate is None


def test_add_months_clamps_day() -> None:
    assert add_months(datetime(2026, 1, 31), 1) == datetime(2026, 2, 28)
    assert add_months(datetime(2024, 3, 31), -1) == datetime(2024, 2, 29)
    assert add_months(datetime(2026, 10, 7), -12) == datetime(2025, 10, 7)


def test_as_of_reconstructs_past_state() -> None:
    m = MatterFacts("M", "closed", None, ago(500), ago(100), None)
    docs = [doc(ago(490), "CORR", None, edited=ago(50)), doc(ago(200), "CORR", None)]
    past = as_of(m, docs, ago(300))
    assert past is not None
    pm, pdocs = past
    assert pm.status == "open" and pm.closed_at is None
    assert len(pdocs) == 1 and pdocs[0].edited_at == pdocs[0].created_at
    assert as_of(m, docs, ago(600)) is None
