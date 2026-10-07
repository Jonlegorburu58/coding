"""Controls engine (ARCHITECTURE §3). Pure functions, no I/O, no network.

Dates are compared at *calendar-day* granularity ("filed on or before" means
the same day or earlier). All datetimes are naive UTC.
"""

from __future__ import annotations

import calendar
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from dms_analytics.controls.rules import CONTROL_IDS, ControlsConfig

PASS, LATE, MISSING, STALE = "pass", "late", "missing", "stale"
PENDING, NA, UNKNOWN = "pending", "not_applicable", "unknown"
FAILING = frozenset({LATE, MISSING, STALE})
ASSESSED = frozenset({PASS, LATE, MISSING, STALE})
BASIS = "imanage_filing"

ENGAGEMENT_TYPES = frozenset({"engagement_letter", "engagement_signed", "s150_notice"})
COSTS_TYPES = frozenset({"costs_update", "s150_notice"})


@dataclass(frozen=True)
class MatterFacts:
    id: str
    status: str  # open | closed
    matter_type: str | None
    opened_at: datetime
    closed_at: datetime | None
    key_date: date | None


@dataclass(frozen=True)
class DocFacts:
    id: str
    name: str
    doc_class: str | None
    canonical_type: str | None
    created_at: datetime
    edited_at: datetime


@dataclass
class ControlOutcome:
    control_id: str
    status: str
    explanation: str
    due_at: datetime | None = None
    evidence_at: datetime | None = None
    days_late: int | None = None
    evidence_doc_ids: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ControlDefinition:
    id: str
    name: str
    category: str
    description: str
    severity: int
    configured: bool


def add_months(dt: datetime, months: int) -> datetime:
    total = dt.year * 12 + (dt.month - 1) + months
    year, month = divmod(total, 12)
    month += 1
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def _fmt(d: datetime | date) -> str:
    return d.strftime("%d %b %Y").lstrip("0")


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def _days_between(later: datetime, earlier: datetime) -> int:
    return (later.date() - earlier.date()).days


def _first(docs: Sequence[DocFacts], types: frozenset[str]) -> DocFacts | None:
    for d in docs:  # docs are sorted by created_at
        if d.canonical_type in types:
            return d
    return None


def _latest(docs: Sequence[DocFacts], types: frozenset[str]) -> DocFacts | None:
    found = None
    for d in docs:
        if d.canonical_type in types:
            found = d
    return found


# ---------------------------------------------------------------------------
# Control catalogue


_CATALOGUE: dict[str, tuple[str, str]] = {
    "FO1": ("File-opening form on file", "file_opening"),
    "CF1": ("Conflict clearance before work", "conflicts"),
    "AML1": ("CDD before work", "aml"),
    "AML2": ("CDD currency (open matters)", "aml"),
    "EL1": ("Engagement letter / s.150 notice", "engagement"),
    "EL2": ("Signed engagement letter returned", "engagement"),
    "AN1": ("Attendance note cadence (open matters)", "attendance"),
    "CD1": ("Critical date recorded", "critical_dates"),
    "FE1": ("Costs update (matters open > 12 months)", "fees"),
    "FE2": ("Billing evidence (active matters)", "fees"),
    "HY1": ("Dormant open matter", "hygiene"),
}


def _describe(cid: str, cfg: ControlsConfig) -> str:
    t = cfg.thresholds
    return {
        "FO1": f"A file-opening form is filed within {t['FO1_days']} days of the workspace "
               "being opened.",
        "CF1": "A conflict clearance is filed on or before the first substantive document.",
        "AML1": "Customer due diligence (CDD) is filed on or before the first substantive "
                "document. Exempt matter types are not applicable.",
        "AML2": f"On open matters, the latest CDD document is no older than "
                f"{t['AML2_months']} months.",
        "EL1": f"An engagement letter or s.150 notice is filed within {t['EL1_days']} days of "
               "the first substantive document.",
        "EL2": "A signed engagement letter is on file (signed class, or an engagement "
               "document whose name indicates it is signed).",
        "AN1": f"If an open matter had substantive activity in the last {t['AN1_days']} days, "
               "at least one attendance note was filed in that period.",
        "CD1": "The workspace's critical (key) date field is populated.",
        "FE1": f"On matters open more than 12 months, a costs update or s.150 notice was "
               f"filed in the last {t['FE1_months']} months.",
        "FE2": f"If the matter was active in the last {t['FE2_months']} months, a bill was "
               f"filed in the last {t['FE2_months']} months.",
        "HY1": f"An open matter with no document activity in {t['HY1_months']} months is "
               "flagged for closure review.",
    }[cid]


def is_configured(cid: str, cfg: ControlsConfig) -> bool:
    types = cfg.configured_types()
    return {
        "FO1": "file_opening" in types,
        "CF1": "conflict_clearance" in types,
        "AML1": "cdd" in types,
        "AML2": "cdd" in types,
        "EL1": bool(types & ENGAGEMENT_TYPES),
        "EL2": "engagement_signed" in types
        or ("engagement_letter" in types and bool(cfg.signed_patterns)),
        "AN1": "attendance_note" in types,
        "CD1": cfg.key_date_mapped,
        "FE1": bool(types & COSTS_TYPES),
        "FE2": "bill" in types,
        "HY1": True,
    }[cid]


def control_definitions(cfg: ControlsConfig) -> list[ControlDefinition]:
    return [
        ControlDefinition(
            id=cid, name=_CATALOGUE[cid][0], category=_CATALOGUE[cid][1],
            description=_describe(cid, cfg), severity=cfg.severity[cid],
            configured=is_configured(cid, cfg),
        )
        for cid in CONTROL_IDS
    ]


# ---------------------------------------------------------------------------
# Individual controls


def _fo1(m: MatterFacts, docs: Sequence[DocFacts], cfg: ControlsConfig,
         now: datetime) -> ControlOutcome:
    n = cfg.thresholds["FO1_days"]
    due = m.opened_at + timedelta(days=n)
    ev = _first(docs, frozenset({"file_opening"}))
    if ev is not None:
        after = max(0, _days_between(ev.created_at, m.opened_at))
        if ev.created_at.date() <= due.date():
            return ControlOutcome("FO1", PASS,
                                  f"File-opening form filed {_plural(after, 'day')} after the "
                                  f"workspace was opened (allowed {n}).",
                                  due, ev.created_at, None, [ev.id])
        late = _days_between(ev.created_at, due)
        return ControlOutcome("FO1", LATE,
                              f"File-opening form filed {_plural(after, 'day')} after the "
                              f"workspace was opened, {_plural(late, 'day')} late "
                              f"(allowed {n}).", due, ev.created_at, late, [ev.id])
    if now.date() <= due.date():
        return ControlOutcome("FO1", PENDING,
                              f"Not due yet: a file-opening form is due by {_fmt(due)}.", due)
    return ControlOutcome("FO1", MISSING,
                          f"No file-opening form on file. It was due by {_fmt(due)}.", due,
                          None, _days_between(now, due))


def _before_first_work(cid: str, label: str, ctype: str, m: MatterFacts,
                       docs: Sequence[DocFacts], cfg: ControlsConfig,
                       now: datetime) -> ControlOutcome:
    first_work = next((d for d in docs if not cfg.is_intake(d.doc_class)), None)
    ev = _first(docs, frozenset({ctype}))
    due = first_work.created_at if first_work else None
    if ev is not None and (first_work is None
                           or ev.created_at.date() <= first_work.created_at.date()):
        expl = (f"{label} filed on {_fmt(ev.created_at)}, before any substantive work."
                if first_work is None else
                f"{label} filed on {_fmt(ev.created_at)}, on or before the first substantive "
                f"document ({_fmt(first_work.created_at)}).")
        return ControlOutcome(cid, PASS, expl, due, ev.created_at, None, [ev.id])
    if ev is not None and first_work is not None:
        late = _days_between(ev.created_at, first_work.created_at)
        return ControlOutcome(cid, LATE,
                              f"{label} filed {_plural(late, 'day')} after the first substantive "
                              f"document ({_fmt(first_work.created_at)}).",
                              due, ev.created_at, late, [ev.id])
    if first_work is None:
        return ControlOutcome(cid, PENDING,
                              f"No substantive work filed yet. {label} is due before the first "
                              "substantive document.")
    return ControlOutcome(cid, MISSING,
                          f"No {label.lower()} on file, although substantive work started on "
                          f"{_fmt(first_work.created_at)}.", due, None,
                          _days_between(now, first_work.created_at))


def _aml1(m: MatterFacts, docs: Sequence[DocFacts], cfg: ControlsConfig,
          now: datetime) -> ControlOutcome:
    if m.matter_type is not None and m.matter_type in cfg.aml_exempt:
        return ControlOutcome("AML1", NA, "Matter type is exempt from AML checks.")
    return _before_first_work("AML1", "CDD", "cdd", m, docs, cfg, now)


def _aml2(m: MatterFacts, docs: Sequence[DocFacts], cfg: ControlsConfig,
          now: datetime) -> ControlOutcome:
    if m.status != "open":
        return ControlOutcome("AML2", NA, "Matter is closed.")
    if m.matter_type is not None and m.matter_type in cfg.aml_exempt:
        return ControlOutcome("AML2", NA, "Matter type is exempt from AML checks.")
    months = cfg.thresholds["AML2_months"]
    latest = _latest(docs, frozenset({"cdd"}))
    if latest is None:
        return ControlOutcome("AML2", MISSING, "No CDD document on file for this open matter.")
    due = add_months(latest.created_at, months)
    if now.date() > due.date():
        late = _days_between(now, due)
        return ControlOutcome("AML2", STALE,
                              f"Latest CDD was filed on {_fmt(latest.created_at)}, more than "
                              f"{months} months ago; it should have been refreshed by "
                              f"{_fmt(due)}.", due, latest.created_at, late, [latest.id])
    return ControlOutcome("AML2", PASS,
                          f"Latest CDD filed on {_fmt(latest.created_at)} (within {months} "
                          "months).", due, latest.created_at, None, [latest.id])


def _el_due(docs: Sequence[DocFacts], cfg: ControlsConfig) -> tuple[DocFacts | None,
                                                                     datetime | None]:
    first_work = next((d for d in docs if not cfg.is_intake(d.doc_class)), None)
    if first_work is None:
        return None, None
    return first_work, first_work.created_at + timedelta(days=cfg.thresholds["EL1_days"])


def _el1(m: MatterFacts, docs: Sequence[DocFacts], cfg: ControlsConfig,
         now: datetime) -> ControlOutcome:
    n = cfg.thresholds["EL1_days"]
    first_work, due = _el_due(docs, cfg)
    ev = _first(docs, ENGAGEMENT_TYPES)
    if ev is not None and (due is None or ev.created_at.date() <= due.date()):
        if first_work is None:
            expl = f"Engagement letter / s.150 notice filed on {_fmt(ev.created_at)}."
        else:
            delta = _days_between(ev.created_at, first_work.created_at)
            expl = ("Engagement letter / s.150 notice filed before the first substantive "
                    "document." if delta <= 0 else
                    f"Engagement letter / s.150 notice filed {_plural(delta, 'day')} after the "
                    f"first substantive document (allowed {n}).")
        return ControlOutcome("EL1", PASS, expl, due, ev.created_at, None, [ev.id])
    if ev is not None and due is not None and first_work is not None:
        late = _days_between(ev.created_at, due)
        delta = _days_between(ev.created_at, first_work.created_at)
        return ControlOutcome("EL1", LATE,
                              f"Engagement letter / s.150 notice filed {_plural(delta, 'day')} "
                              f"after the first substantive document (allowed {n}).",
                              due, ev.created_at, late, [ev.id])
    if due is None:
        return ControlOutcome("EL1", PENDING,
                              "No substantive work filed yet. An engagement letter or s.150 "
                              f"notice is due within {n} days of it.")
    if now.date() <= due.date():
        return ControlOutcome("EL1", PENDING,
                              "Not due yet: an engagement letter or s.150 notice is due by "
                              f"{_fmt(due)}.", due)
    return ControlOutcome("EL1", MISSING,
                          f"No engagement letter or s.150 notice on file. It was due by "
                          f"{_fmt(due)}.", due, None, _days_between(now, due))


def _el2(m: MatterFacts, docs: Sequence[DocFacts], cfg: ControlsConfig,
         now: datetime) -> ControlOutcome:
    signed = next((d for d in docs if d.canonical_type == "engagement_signed"
                   or (d.canonical_type == "engagement_letter"
                       and cfg.name_looks_signed(d.name))), None)
    _, due = _el_due(docs, cfg)
    if signed is not None:
        return ControlOutcome("EL2", PASS,
                              f"Signed engagement letter on file (filed "
                              f"{_fmt(signed.created_at)}).", due, signed.created_at, None,
                              [signed.id])
    if due is None or now.date() <= due.date():
        return ControlOutcome("EL2", PENDING,
                              "Not due yet: the signed engagement letter is expected once the "
                              "engagement letter deadline has passed.", due)
    return ControlOutcome("EL2", MISSING,
                          "No signed engagement letter on file.", due, None,
                          _days_between(now, due))


def _an1(m: MatterFacts, docs: Sequence[DocFacts], cfg: ControlsConfig,
         now: datetime) -> ControlOutcome:
    if m.status != "open":
        return ControlOutcome("AN1", NA, "Matter is closed.")
    n = cfg.thresholds["AN1_days"]
    start = now - timedelta(days=n)
    active = any(not cfg.is_intake(d.doc_class) and d.edited_at >= start for d in docs)
    if not active:
        return ControlOutcome("AN1", NA, f"No substantive activity in the last {n} days.")
    notes = [d for d in docs if d.canonical_type == "attendance_note" and d.created_at >= start]
    if notes:
        last = notes[-1]
        return ControlOutcome("AN1", PASS,
                              f"{_plural(len(notes), 'attendance note')} filed in the last "
                              f"{n} days.", None, last.created_at, None, [d.id for d in notes][-5:])
    return ControlOutcome("AN1", MISSING,
                          f"The matter was active in the last {n} days but no attendance note "
                          "was filed in that period.")


def _cd1(m: MatterFacts, docs: Sequence[DocFacts], cfg: ControlsConfig,
         now: datetime) -> ControlOutcome:
    if not cfg.key_date_mapped:
        return ControlOutcome("CD1", UNKNOWN,
                              "No key-date field is mapped in controls.yaml, so this cannot be "
                              "checked.")
    if m.key_date is not None:
        return ControlOutcome("CD1", PASS, f"Key date recorded: {_fmt(m.key_date)}.")
    return ControlOutcome("CD1", MISSING, "No key date recorded on the workspace.")


def _fe1(m: MatterFacts, docs: Sequence[DocFacts], cfg: ControlsConfig,
         now: datetime) -> ControlOutcome:
    if m.status != "open":
        return ControlOutcome("FE1", NA, "Matter is closed.")
    if m.opened_at > add_months(now, -12):
        return ControlOutcome("FE1", NA, "Matter has been open for less than 12 months.")
    months = cfg.thresholds["FE1_months"]
    latest = _latest(docs, COSTS_TYPES)
    if latest is None:
        return ControlOutcome("FE1", MISSING,
                              "No costs update or s.150 notice on file for a matter open more "
                              "than 12 months.")
    due = add_months(latest.created_at, months)
    if now.date() > due.date():
        return ControlOutcome("FE1", STALE,
                              f"Latest costs update was filed on {_fmt(latest.created_at)}, "
                              f"more than {months} months ago.", due, latest.created_at,
                              _days_between(now, due), [latest.id])
    return ControlOutcome("FE1", PASS,
                          f"Costs update filed on {_fmt(latest.created_at)} (within {months} "
                          "months).", due, latest.created_at, None, [latest.id])


def _fe2(m: MatterFacts, docs: Sequence[DocFacts], cfg: ControlsConfig,
         now: datetime) -> ControlOutcome:
    months = cfg.thresholds["FE2_months"]
    start = add_months(now, -months)
    if not any(d.edited_at >= start for d in docs):
        return ControlOutcome("FE2", NA, f"No activity in the last {months} months.")
    latest = _latest(docs, frozenset({"bill"}))
    if latest is None:
        return ControlOutcome("FE2", MISSING,
                              f"The matter was active in the last {months} months but no bill "
                              "is on file.")
    due = add_months(latest.created_at, months)
    if latest.created_at < start:
        return ControlOutcome("FE2", STALE,
                              f"The matter was active in the last {months} months but the "
                              f"latest bill was filed on {_fmt(latest.created_at)}.", due,
                              latest.created_at, _days_between(now, due), [latest.id])
    return ControlOutcome("FE2", PASS,
                          f"Bill filed on {_fmt(latest.created_at)} (within {months} months).",
                          due, latest.created_at, None, [latest.id])


def _hy1(m: MatterFacts, docs: Sequence[DocFacts], cfg: ControlsConfig,
         now: datetime) -> ControlOutcome:
    if m.status != "open":
        return ControlOutcome("HY1", NA, "Matter is closed.")
    months = cfg.thresholds["HY1_months"]
    last = max((d.edited_at for d in docs), default=m.opened_at)
    due = add_months(last, months)
    if now.date() > due.date():
        return ControlOutcome("HY1", STALE,
                              f"No document activity since {_fmt(last)} (more than {months} "
                              "months). Review for closure.", due, last,
                              _days_between(now, due))
    return ControlOutcome("HY1", PASS, f"Last document activity on {_fmt(last)}.", None, last)


_EVALUATORS = {
    "FO1": _fo1,
    "CF1": lambda m, d, c, n: _before_first_work("CF1", "Conflict clearance",
                                                 "conflict_clearance", m, d, c, n),
    "AML1": _aml1, "AML2": _aml2, "EL1": _el1, "EL2": _el2, "AN1": _an1, "CD1": _cd1,
    "FE1": _fe1, "FE2": _fe2, "HY1": _hy1,
}


def evaluate_matter(m: MatterFacts, docs: Sequence[DocFacts], cfg: ControlsConfig,
                    now: datetime) -> list[ControlOutcome]:
    """Evaluate every control for one matter. ``docs`` need not be sorted."""
    ordered = sorted(docs, key=lambda d: (d.created_at, d.id))
    out: list[ControlOutcome] = []
    for cid in CONTROL_IDS:
        if not is_configured(cid, cfg):
            out.append(ControlOutcome(cid, UNKNOWN,
                                      "This control is not configured in controls.yaml (no "
                                      "document type mapping), so it cannot be checked."))
            continue
        out.append(_EVALUATORS[cid](m, ordered, cfg, now))
    return out


def as_of(m: MatterFacts, docs: Sequence[DocFacts],
          when: datetime) -> tuple[MatterFacts, list[DocFacts]] | None:
    """Reconstruct a matter's state at ``when`` (used for back-dated snapshots).

    Returns None if the matter did not exist yet. Documents created later are
    dropped; later edits are treated as if the document was last edited when
    it was created (the DMS does not tell us intermediate edit dates).
    """
    if m.opened_at > when:
        return None
    closed = m.closed_at is not None and m.closed_at <= when
    facts = MatterFacts(m.id, "closed" if closed else "open", m.matter_type, m.opened_at,
                        m.closed_at if closed else None, m.key_date)
    kept = [
        d if d.edited_at <= when else DocFacts(d.id, d.name, d.doc_class, d.canonical_type,
                                               d.created_at, d.created_at)
        for d in docs if d.created_at <= when
    ]
    return facts, kept
