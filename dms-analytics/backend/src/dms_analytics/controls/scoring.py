"""Derived measures (ARCHITECTURE §3): risk score, readiness, compliance rates."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from dms_analytics.controls.engine import ASSESSED, FAILING, NA, PASS, PENDING, UNKNOWN

HIGH_RISK_THRESHOLD = 50.0


def risk_score(statuses: Mapping[str, str], severity: Mapping[str, int]) -> float | None:
    """100 x sum(severity of failing) / sum(severity of applicable).

    ``statuses`` maps control_id -> status. late/missing/stale fail; pending,
    not_applicable and unknown are excluded. None when nothing is assessable.
    """
    applicable = 0
    failing = 0
    for cid, status in statuses.items():
        if status in ASSESSED:
            sev = severity.get(cid, 1)
            applicable += sev
            if status in FAILING:
                failing += sev
    if applicable == 0:
        return None
    return round(100.0 * failing / applicable, 1)


def readiness(score: float | None) -> float | None:
    return None if score is None else round(100.0 - score, 1)


def mean_readiness(scores: Iterable[float | None]) -> float | None:
    values = [100.0 - s for s in scores if s is not None]
    if not values:
        return None
    return round(sum(values) / len(values), 1)


@dataclass
class Tally:
    control_id: str
    pass_: int = 0
    late: int = 0
    missing: int = 0
    stale: int = 0
    pending: int = 0
    not_applicable: int = 0
    unknown: int = 0

    def add(self, status: str) -> None:
        if status == PASS:
            self.pass_ += 1
        elif status == "late":
            self.late += 1
        elif status == "missing":
            self.missing += 1
        elif status == "stale":
            self.stale += 1
        elif status == PENDING:
            self.pending += 1
        elif status == NA:
            self.not_applicable += 1
        elif status == UNKNOWN:
            self.unknown += 1

    @property
    def assessed(self) -> int:
        """Denominator of the compliance rate: pass + late + missing + stale."""
        return self.pass_ + self.late + self.missing + self.stale

    @property
    def applicable(self) -> int:
        """As defined in the contract: pass + late + missing + stale + pending."""
        return self.assessed + self.pending

    @property
    def compliance_rate(self) -> float | None:
        if self.assessed == 0:
            return None
        return round(self.pass_ / self.assessed, 3)

    def as_contract(self) -> dict[str, object]:
        return {
            "control_id": self.control_id, "applicable": self.applicable, "pass": self.pass_,
            "late": self.late, "missing": self.missing, "stale": self.stale,
            "pending": self.pending, "not_applicable": self.not_applicable,
            "unknown": self.unknown, "compliance_rate": self.compliance_rate,
        }
