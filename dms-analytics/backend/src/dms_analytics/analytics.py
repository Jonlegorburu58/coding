"""Analytics queries behind the local API (ARCHITECTURE §3 "Derived measures").

A ``Frame`` is an in-memory view of every matter with its control results and
risk score, loaded once per data version. Portfolios are hundreds to a few
thousand matters, so filtering in Python is fast and keeps every metric
definition in one readable place.
"""

from __future__ import annotations

import secrets
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any

from dms_analytics.controls.engine import FAILING, control_definitions
from dms_analytics.controls.rules import CONTROL_IDS, ControlsConfig
from dms_analytics.controls.sampling import Candidate, draw_sample
from dms_analytics.controls.scoring import (
    HIGH_RISK_THRESHOLD,
    Tally,
    mean_readiness,
    risk_score,
)
from dms_analytics.store.repo import Repo

DIMENSIONS = ("practice_area", "partner", "fee_earner", "office", "opened_month")


def iso_dt(v: datetime | None) -> str | None:
    if v is None:
        return None
    return v.replace(microsecond=0).isoformat() + "Z"


def iso_date(v: date | None) -> str | None:
    return None if v is None else v.isoformat()


@dataclass
class Result:
    control_id: str
    status: str
    due_at: datetime | None
    evidence_at: datetime | None
    days_late: int | None
    evidence_doc_ids: list[str]
    explanation: str


@dataclass
class MatterView:
    id: str
    client_code: str
    client_name: str
    matter_code: str
    matter_name: str
    practice_area: str | None
    partner_id: str | None
    partner_name: str | None
    fee_earner_id: str | None
    fee_earner_name: str | None
    office: str | None
    status: str
    opened_at: datetime
    last_activity_at: datetime | None
    doc_count: int
    key_date: date | None
    results: dict[str, Result] = field(default_factory=dict)
    risk_score: float | None = None

    @property
    def failing(self) -> list[str]:
        return [cid for cid in CONTROL_IDS
                if cid in self.results and self.results[cid].status in FAILING]

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "client_code": self.client_code,
            "client_name": self.client_name,
            "matter_code": self.matter_code,
            "matter_name": self.matter_name,
            "practice_area": self.practice_area,
            "partner": ({"id": self.partner_id, "name": self.partner_name or self.partner_id}
                        if self.partner_id else None),
            "fee_earner": ({"id": self.fee_earner_id,
                            "name": self.fee_earner_name or self.fee_earner_id}
                           if self.fee_earner_id else None),
            "office": self.office,
            "status": self.status,
            "opened_at": iso_dt(self.opened_at),
            "last_activity_at": iso_dt(self.last_activity_at),
            "doc_count": self.doc_count,
            "risk_score": self.risk_score,
            "failing_controls": self.failing,
            "key_date": iso_date(self.key_date),
        }


@dataclass
class Filters:
    practice_area: str | None = None
    partner_id: str | None = None
    fee_earner_id: str | None = None
    office: str | None = None
    status: str = "open"  # open | closed | all
    opened_from: date | None = None
    opened_to: date | None = None

    def match(self, m: MatterView) -> bool:
        if self.practice_area is not None and m.practice_area != self.practice_area:
            return False
        if self.partner_id is not None and m.partner_id != self.partner_id:
            return False
        if self.fee_earner_id is not None and m.fee_earner_id != self.fee_earner_id:
            return False
        if self.office is not None and m.office != self.office:
            return False
        if self.status != "all" and m.status != self.status:
            return False
        if self.opened_from is not None and m.opened_at.date() < self.opened_from:
            return False
        return not (self.opened_to is not None and m.opened_at.date() > self.opened_to)


class Frame:
    def __init__(self, matters: list[MatterView]) -> None:
        self.matters = matters
        self.by_id = {m.id: m for m in matters}

    def select(self, f: Filters) -> list[MatterView]:
        return [m for m in self.matters if f.match(m)]


def load_frame(repo: Repo, cfg: ControlsConfig) -> Frame:
    rows = repo.db.fetch_dicts(
        "SELECT m.*, p.display_name AS partner_name, fe.display_name AS fee_earner_name "
        "FROM matter m LEFT JOIN person p ON p.id = m.partner_id "
        "LEFT JOIN person fe ON fe.id = m.fee_earner_id ORDER BY m.matter_code, m.id")
    matters: dict[str, MatterView] = {}
    for r in rows:
        matters[r["id"]] = MatterView(
            id=r["id"], client_code=r["client_code"] or "", client_name=r["client_name"] or "",
            matter_code=r["matter_code"] or "", matter_name=r["matter_name"] or "",
            practice_area=r["practice_area"], partner_id=r["partner_id"],
            partner_name=r["partner_name"], fee_earner_id=r["fee_earner_id"],
            fee_earner_name=r["fee_earner_name"], office=r["office"], status=r["status"],
            opened_at=r["opened_at"], last_activity_at=r["last_activity_at"],
            doc_count=int(r["doc_count"] or 0), key_date=r["key_date"])
    for mid, cid, status, due, ev_at, late, ev_ids, expl in repo.db.fetchall(
            "SELECT matter_id, control_id, status, due_at, evidence_at, days_late, "
            "evidence_doc_ids, explanation FROM control_result"):
        m = matters.get(mid)
        if m is not None:
            m.results[cid] = Result(cid, status, due, ev_at, late, list(ev_ids or []),
                                    expl or "")
    for m in matters.values():
        m.risk_score = risk_score({c: r.status for c, r in m.results.items()}, cfg.severity)
    return Frame(list(matters.values()))


# ---------------------------------------------------------------------------
# Endpoints


def facets(frame: Frame) -> dict[str, Any]:
    ms = frame.matters
    partners = {m.partner_id: m.partner_name or m.partner_id for m in ms if m.partner_id}
    fes = {m.fee_earner_id: m.fee_earner_name or m.fee_earner_id for m in ms if m.fee_earner_id}
    opened = [m.opened_at.date() for m in ms]
    return {
        "practice_areas": sorted({m.practice_area for m in ms if m.practice_area}),
        "partners": [{"id": k, "name": v} for k, v in sorted(partners.items(),
                                                             key=lambda kv: (kv[1], kv[0]))],
        "fee_earners": [{"id": k, "name": v} for k, v in sorted(fes.items(),
                                                                key=lambda kv: (kv[1], kv[0]))],
        "offices": sorted({m.office for m in ms if m.office}),
        "opened_range": {"min": iso_date(min(opened)) if opened else None,
                         "max": iso_date(max(opened)) if opened else None},
    }


def tallies(matters: Iterable[MatterView]) -> dict[str, Tally]:
    out = {cid: Tally(cid) for cid in CONTROL_IDS}
    for m in matters:
        for cid, r in m.results.items():
            if cid in out:
                out[cid].add(r.status)
    return out


def key_date_counts(matters: Iterable[MatterView], today: date) -> dict[str, int]:
    counts = {"d30": 0, "d60": 0, "d90": 0}
    for m in matters:
        if m.key_date is None:
            continue
        delta = (m.key_date - today).days
        for n in (30, 60, 90):
            if 0 <= delta <= n:
                counts[f"d{n}"] += 1
    return counts


def coverage_note(libraries: int, workspaces: int) -> str:
    lib = "library" if libraries == 1 else "libraries"
    return (f"Based on {workspaces:,} workspaces visible to you in {libraries} {lib}. "
            "Results show iManage filing evidence only.")


def summary(frame: Frame, f: Filters, today: date, libraries: int) -> dict[str, Any]:
    scope = frame.select(f)
    t = tallies(scope)
    return {
        "scope": {"matters": len(scope),
                  "open_matters": sum(1 for m in scope if m.status == "open")},
        "readiness": mean_readiness(m.risk_score for m in scope),
        "high_risk_matters": sum(1 for m in scope if m.risk_score is not None
                                 and m.risk_score >= HIGH_RISK_THRESHOLD),
        "exceptions_open": sum(len(m.failing) for m in scope),
        "upcoming_key_dates": key_date_counts(scope, today),
        "controls": [t[cid].as_contract() for cid in CONTROL_IDS],
        "coverage_note": coverage_note(libraries, len(frame.matters)),
    }


def _dimension_key(m: MatterView, dimension: str) -> tuple[str, str] | None:
    if dimension == "practice_area":
        return (m.practice_area, m.practice_area) if m.practice_area else None
    if dimension == "partner":
        return (m.partner_id, m.partner_name or m.partner_id) if m.partner_id else None
    if dimension == "fee_earner":
        return ((m.fee_earner_id, m.fee_earner_name or m.fee_earner_id)
                if m.fee_earner_id else None)
    if dimension == "office":
        return (m.office, m.office) if m.office else None
    if dimension == "opened_month":
        k = m.opened_at.strftime("%Y-%m")
        return k, m.opened_at.strftime("%b %Y")
    raise ValueError(dimension)


def breakdown(frame: Frame, f: Filters, dimension: str) -> dict[str, Any]:
    """Heatmap rows. Cell ``applicable`` = pass+late+missing+stale (the
    compliance-rate denominator), ``passing`` = pass (D105)."""
    if dimension not in DIMENSIONS:
        raise ValueError(dimension)
    groups: dict[str, tuple[str, list[MatterView]]] = {}
    for m in frame.select(f):
        kl = _dimension_key(m, dimension)
        key, label = kl if kl else ("(none)", "(not set)")
        groups.setdefault(key, (label, []))[1].append(m)
    order = sorted(groups) if dimension == "opened_month" else sorted(
        groups, key=lambda k: (groups[k][0].lower(), k))
    rows = []
    for key in order:
        label, ms = groups[key]
        t = tallies(ms)
        rows.append({
            "key": key, "label": label, "matters": len(ms),
            "readiness": mean_readiness(m.risk_score for m in ms),
            "cells": [{"control_id": cid, "applicable": t[cid].assessed,
                       "passing": t[cid].pass_, "compliance_rate": t[cid].compliance_rate}
                      for cid in CONTROL_IDS],
        })
    return {"dimension": dimension, "rows": rows}


def trend(repo: Repo, control_id: str | None, date_from: date | None,
          date_to: date | None) -> dict[str, Any]:
    cid = control_id or "ALL"
    sql = ("SELECT taken_at, applicable, passing, readiness FROM portfolio_snapshot "
           "WHERE control_id = ?")
    params: list[Any] = [cid]
    if date_from is not None:
        sql += " AND taken_at >= ?"
        params.append(datetime.combine(date_from, datetime.min.time()))
    if date_to is not None:
        sql += " AND taken_at < ?"
        params.append(datetime.combine(date_to + timedelta(days=1), datetime.min.time()))
    sql += " ORDER BY taken_at"
    points = [{"taken_at": iso_dt(t), "applicable": int(a or 0), "passing": int(p or 0),
               "value": None if v is None else round(float(v), 1)}
              for t, a, p, v in repo.db.fetchall(sql, params)]
    return {"control_id": cid, "points": points}


def _nulls_last(value: Any, reverse: bool) -> tuple[int, Any]:
    if value is None:
        return (1, 0)
    return (0, -value if reverse else value)


def sort_matters(ms: list[MatterView], sort: str) -> list[MatterView]:
    base = sorted(ms, key=lambda m: (m.matter_code, m.id))
    if sort == "matter_code":
        return base
    if sort in ("risk_desc", "risk_asc"):
        return sorted(base, key=lambda m: _nulls_last(m.risk_score, sort == "risk_desc"))
    if sort in ("opened_desc", "opened_asc"):
        return sorted(base, key=lambda m: m.opened_at, reverse=sort == "opened_desc")
    if sort in ("activity_desc", "activity_asc"):
        with_ts = [m for m in base if m.last_activity_at is not None]
        without = [m for m in base if m.last_activity_at is None]
        return sorted(with_ts, key=lambda m: m.last_activity_at or datetime.min,
                      reverse=sort == "activity_desc") + without
    raise ValueError(sort)


def page_of(items: list[Any], page: int, page_size: int) -> list[Any]:
    start = (page - 1) * page_size
    return items[start:start + page_size]


def list_matters(frame: Frame, f: Filters, *, q: str | None, failing_control: str | None,
                 min_risk: float | None, sort: str, page: int,
                 page_size: int) -> dict[str, Any]:
    ms = frame.select(f)
    if q:
        needle = q.casefold().strip()
        ms = [m for m in ms if needle in m.client_code.casefold()
              or needle in m.client_name.casefold() or needle in m.matter_code.casefold()
              or needle in m.matter_name.casefold()]
    if failing_control:
        ms = [m for m in ms if failing_control in m.failing]
    if min_risk is not None:
        ms = [m for m in ms if m.risk_score is not None and m.risk_score >= min_risk]
    ms = sort_matters(ms, sort)
    return {"total": len(ms), "page": page, "page_size": page_size,
            "items": [m.summary() for m in page_of(ms, page, page_size)]}


def matter_detail(repo: Repo, frame: Frame, cfg: ControlsConfig,
                  matter_id: str) -> dict[str, Any] | None:
    m = frame.by_id.get(matter_id)
    if m is None:
        return None
    names = {d.id: d.name for d in control_definitions(cfg)}
    evidence_ids = sorted({i for r in m.results.values() for i in r.evidence_doc_ids})
    docs: dict[str, tuple[str, str | None, datetime]] = {}
    if evidence_ids:
        for did, name, ctype, created in repo.db.fetchall(
                "SELECT id, name, canonical_type, created_at FROM document "
                "WHERE list_contains(?, id)", [evidence_ids]):
            docs[did] = (name or "", ctype, created)
    controls = []
    timeline: list[dict[str, Any]] = [
        {"at": m.opened_at, "kind": "opened", "label": "Workspace opened", "control_id": None}]
    for cid in CONTROL_IDS:
        r = m.results.get(cid)
        if r is None:
            continue
        evidence = [{"id": i, "name": docs[i][0], "canonical_type": docs[i][1],
                     "filed_at": iso_dt(docs[i][2])} for i in r.evidence_doc_ids if i in docs]
        controls.append({
            "control_id": cid, "status": r.status, "due_at": iso_dt(r.due_at),
            "evidence_at": iso_dt(r.evidence_at), "days_late": r.days_late,
            "explanation": r.explanation, "evidence": evidence, "basis": "imanage_filing",
        })
        if evidence and r.evidence_at is not None:
            timeline.append({"at": r.evidence_at, "kind": "evidence",
                             "label": f"{names[cid]}: evidence filed", "control_id": cid})
    first = repo.db.fetchall(
        "SELECT created_at, doc_class FROM document WHERE matter_id = ? ORDER BY created_at, id",
        [matter_id])
    first_work = next((c for c, cls in first if not cfg.is_intake(cls)), None)
    if first_work is not None:
        timeline.append({"at": first_work, "kind": "first_substantive",
                         "label": "First substantive document filed", "control_id": None})
    if m.key_date is not None:
        timeline.append({"at": datetime.combine(m.key_date, datetime.min.time()),
                         "kind": "key_date", "label": "Key date", "control_id": "CD1"})
    if m.last_activity_at is not None:
        timeline.append({"at": m.last_activity_at, "kind": "last_activity",
                         "label": "Last document activity", "control_id": None})
    timeline.sort(key=lambda e: e["at"])
    for e in timeline:
        e["at"] = iso_dt(e["at"])
    counts = [{"canonical_type": ct, "count": int(n)} for ct, n in repo.db.fetchall(
        "SELECT canonical_type, count(*) AS n FROM document WHERE matter_id = ? "
        "GROUP BY canonical_type ORDER BY n DESC, canonical_type NULLS LAST", [matter_id])]
    return {**m.summary(), "controls": controls, "timeline": timeline,
            "doc_type_counts": counts}


def exceptions(frame: Frame, cfg: ControlsConfig, f: Filters, *, control_id: str | None,
               status: str | None, sort: str, page: int, page_size: int) -> dict[str, Any]:
    items: list[tuple[MatterView, Result]] = []
    for m in frame.select(f):
        for cid in m.failing:
            r = m.results[cid]
            if control_id and cid != control_id:
                continue
            if status and r.status != status:
                continue
            items.append((m, r))
    base = sorted(items, key=lambda x: (x[0].matter_code, x[0].id,
                                        CONTROL_IDS.index(x[1].control_id)))
    if sort == "severity_desc":
        base.sort(key=lambda x: (-cfg.severity[x[1].control_id], _nulls_last(x[1].days_late,
                                                                              True)))
    elif sort == "days_late_desc":
        base.sort(key=lambda x: _nulls_last(x[1].days_late, True))
    elif sort == "opened_desc":
        base.sort(key=lambda x: x[0].opened_at, reverse=True)
    else:
        raise ValueError(sort)
    return {"total": len(base), "page": page, "page_size": page_size, "items": [
        {"matter": m.summary(), "control_id": r.control_id, "status": r.status,
         "severity": cfg.severity[r.control_id], "days_late": r.days_late,
         "due_at": iso_dt(r.due_at), "explanation": r.explanation}
        for m, r in page_of(base, page, page_size)]}


def key_dates(frame: Frame, within_days: int, today: date) -> list[dict[str, Any]]:
    out = []
    for m in frame.select(Filters(status="open")):
        if m.key_date is None:
            continue
        days = (m.key_date - today).days
        if 0 <= days <= within_days:
            out.append((m.key_date, m.matter_code, m))
    out.sort(key=lambda x: (x[0], x[1]))
    return [{"matter": m.summary(), "key_date": iso_date(kd), "days_until": (kd - today).days}
            for kd, _, m in out]


def lexcel_sample(frame: Frame, *, per_fee_earner: int, seed: int | None,
                  practice_area: str | None, office: str | None,
                  now: datetime) -> dict[str, Any]:
    if seed is None:
        seed = secrets.randbelow(2**31 - 1) + 1
    ms = frame.select(Filters(practice_area=practice_area, office=office, status="open"))
    picks = draw_sample([Candidate(m.id, m.fee_earner_id, m.risk_score)
                         for m in ms if m.fee_earner_id], per_fee_earner, seed)
    names = {m.fee_earner_id: m.fee_earner_name for m in ms if m.fee_earner_id}
    items = [{"fee_earner": {"id": fe, "name": names.get(fe) or fe},
              "matters": [frame.by_id[mid].summary() for mid in mids]}
             for fe, mids in sorted(picks.items(), key=lambda kv: (names.get(kv[0]) or kv[0]))]
    return {"seed": seed, "per_fee_earner": per_fee_earner, "generated_at": iso_dt(now),
            "items": items}
