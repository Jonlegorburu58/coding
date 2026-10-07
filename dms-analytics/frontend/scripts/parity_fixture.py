"""Generate the TS engine parity fixture from the Python reference engine.

Run from dms-analytics/frontend (uses the backend read-only):

    uv run --project ../backend python scripts/parity_fixture.py

Writes src/portal/__fixtures__/parity.json: synthetic (fictional) matters and
documents, plus the Python engine's outcome for every control. Two configs are
used: the bundled defaults, and a reduced one (no key date, no bill mapping,
no signed patterns) so that "unknown" results are covered too.
"""

from __future__ import annotations

import json
import random
from datetime import date, datetime, timedelta
from pathlib import Path

from dms_analytics.controls.engine import DocFacts, MatterFacts, evaluate_matter
from dms_analytics.controls.rules import (
    CONTROL_IDS,
    default_controls_text,
    parse_controls,
)
from dms_analytics.controls.scoring import risk_score

NOW = datetime(2026, 10, 6, 21, 0, 0)
OUT = Path(__file__).resolve().parent.parent / "src" / "portal" / "__fixtures__" / "parity.json"

FULL = parse_controls(default_controls_text(), source="defaults")
REDUCED_TEXT = (default_controls_text()
                .replace("  key_date: custom21\n", "")
                .replace('  bill:               [{ class: "BILL" }]\n', "")
                .replace('  engagement_signed:  [{ class: "ENGAGE", subclass: "SIGNED" }]\n', "")
                .replace('signed_name_patterns: ["(?i)\\\\bsigned\\\\b", "(?i)countersigned"]',
                         "signed_name_patterns: []"))
REDUCED = parse_controls(REDUCED_TEXT, source="reduced")
assert not REDUCED.key_date_mapped and "bill" not in REDUCED.configured_types()

CLASSES = [
    ("FILEOPEN", None, "File opening form"),
    ("CONFLICT", None, "Conflict search clearance"),
    ("AML", None, "CDD pack - ID and address"),
    ("KYC", None, "KYC refresh"),
    ("ENGAGE", None, "Letter of engagement"),
    ("ENGAGE", "SIGNED", "Letter of engagement - countersigned copy"),
    ("ENGAGE", None, "Engagement letter signed"),
    ("S150", None, "Section 150 notice"),
    ("ATTNOTE", None, "Attendance note - call with client"),
    ("COSTS", None, "Costs update"),
    ("BILL", None, "Interim bill"),
    ("CORR", None, "Letter to other side"),
    ("DRAFT", None, "Draft agreement v2"),
]


def iso(d: datetime | date | None) -> str | None:
    if d is None:
        return None
    if isinstance(d, datetime):
        return d.isoformat(timespec="seconds")
    return d.isoformat()


def gen_matter(r: random.Random, i: int) -> tuple[MatterFacts, list[tuple[DocFacts, str, str | None]]]:
    age = r.choice([1, 3, 6, 10, 20, 40, 120, 300, 400, 800, 1200, 1500, 2000])
    opened = NOW - timedelta(days=age, hours=r.randint(0, 20), minutes=r.randint(0, 59))
    status = "closed" if r.random() < 0.18 else "open"
    mtype = "INTERNAL" if r.random() < 0.08 else r.choice([None, "LIT", "CORP"])
    key = (NOW + timedelta(days=r.randint(-30, 200))).date() if r.random() < 0.6 else None
    m = MatterFacts(f"PARITY-{i:04d}", status, mtype, opened,
                    opened + timedelta(days=age // 2) if status == "closed" else None, key)
    docs: list[tuple[DocFacts, str, str | None]] = []
    n_docs = r.choice([0, 1, 2, 4, 6, 9, 14])
    span = max(1, age)
    for j in range(n_docs):
        cls, sub, name = r.choice(CLASSES)
        # bias towards early filing for intake classes
        if cls in ("FILEOPEN", "CONFLICT", "AML", "KYC", "ENGAGE", "S150") and r.random() < 0.6:
            offset = r.randint(-2, min(span, 30))
        else:
            offset = r.randint(0, span)
        created = opened + timedelta(days=offset, hours=r.randint(0, 23), minutes=r.randint(0, 59))
        created = min(created, NOW - timedelta(minutes=5))
        edited = min(created + timedelta(days=r.choice([0, 0, 1, 10, 100, 400])), NOW - timedelta(minutes=1))
        docs.append((DocFacts(f"{i}.{j}", name, cls, None, created, edited), cls, sub))
    return m, docs


def run(cfg, matters):  # type: ignore[no-untyped-def]
    cases = []
    for m, raw in matters:
        docs = [DocFacts(d.id, d.name, d.doc_class,
                         cfg.canonical_type(cls, sub, d.name, ""), d.created_at, d.edited_at)
                for d, cls, sub in raw]
        outcomes = evaluate_matter(m, docs, cfg, NOW)
        cases.append({
            "matter": {"id": m.id, "status": m.status, "matter_type": m.matter_type,
                       "opened_at": iso(m.opened_at), "closed_at": iso(m.closed_at),
                       "key_date": iso(m.key_date)},
            "docs": [{"id": d.id, "name": d.name, "doc_class": d.doc_class,
                      "is_intake": cfg.is_intake(d.doc_class),
                      "canonical_type": d.canonical_type,
                      "created_at": iso(d.created_at), "edited_at": iso(d.edited_at)}
                     for d in docs],
            "expected": [{"control_id": o.control_id, "status": o.status,
                          "explanation": o.explanation, "due_at": iso(o.due_at),
                          "evidence_at": iso(o.evidence_at), "days_late": o.days_late,
                          "evidence_doc_ids": o.evidence_doc_ids} for o in outcomes],
            "risk_score": risk_score({o.control_id: o.status for o in outcomes}, cfg.severity),
        })
    return cases


def config_json(cfg):  # type: ignore[no-untyped-def]
    return {
        "thresholds": cfg.thresholds, "severity": cfg.severity,
        "configured_types": sorted(cfg.configured_types()),
        "signed_patterns": [p.pattern for p in cfg.signed_patterns],
        "aml_exempt": sorted(cfg.aml_exempt), "key_date_mapped": cfg.key_date_mapped,
    }


def main() -> None:
    r = random.Random(20261006)
    matters = [gen_matter(r, i) for i in range(260)]
    # Hand-made edge cases: no documents at all, and a same-day boundary.
    edge_open = NOW - timedelta(days=5)
    matters.append((MatterFacts("PARITY-EDGE-1", "open", None, edge_open, None, None), []))
    same_day = NOW - timedelta(days=30)
    matters.append((MatterFacts("PARITY-EDGE-2", "open", "LIT", same_day, None, None), [
        (DocFacts("e2.0", "Draft memo", "DRAFT", None, same_day + timedelta(hours=2),
                  same_day + timedelta(hours=3)), "DRAFT", None),
        (DocFacts("e2.1", "Conflict search clearance", "CONFLICT", None,
                  same_day + timedelta(hours=9), same_day + timedelta(hours=9)), "CONFLICT", None),
    ]))
    out = {
        "generated_by": "scripts/parity_fixture.py (Python reference engine)",
        "now": iso(NOW),
        "configs": {"full": config_json(FULL), "reduced": config_json(REDUCED)},
        "cases": {"full": run(FULL, matters), "reduced": run(REDUCED, matters[:120])},
    }
    seen: dict[str, set[str]] = {cid: set() for cid in CONTROL_IDS}
    for group in out["cases"].values():
        for c in group:
            for e in c["expected"]:
                seen[e["control_id"]].add(e["status"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
    for cid in CONTROL_IDS:
        print(cid, sorted(seen[cid]))


if __name__ == "__main__":
    main()
