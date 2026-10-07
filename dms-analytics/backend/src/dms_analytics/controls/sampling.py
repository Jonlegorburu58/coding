"""Lexcel file-review sample: seeded, risk-weighted, reproducible.

For each fee earner (in id order) we draw ``per_fee_earner`` matters without
replacement using the Efraimidis-Spirakis method: each candidate gets key
``u ** (1 / w)`` with ``u ~ U(0,1)`` and weight ``w = 1 + risk_score``
(a matter with no score gets weight 1), and the largest keys win. The random
stream for each fee earner is seeded from ``f"{seed}:{fee_earner_id}"`` so the
same seed over the same data always reproduces the same sample, and one fee
earner's caseload does not change another's selection.
"""

from __future__ import annotations

import random
from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class Candidate:
    matter_id: str
    fee_earner_id: str
    risk_score: float | None


def weight(risk: float | None) -> float:
    return 1.0 + (risk or 0.0)


def draw_sample(candidates: Sequence[Candidate], per_fee_earner: int,
                seed: int) -> dict[str, list[str]]:
    """Return fee_earner_id -> selected matter ids (highest key first)."""
    by_fe: dict[str, list[Candidate]] = {}
    for c in candidates:
        by_fe.setdefault(c.fee_earner_id, []).append(c)
    result: dict[str, list[str]] = {}
    for fe_id in sorted(by_fe):
        rng = random.Random(f"{seed}:{fe_id}")
        pool = sorted(by_fe[fe_id], key=lambda c: c.matter_id)
        keyed = []
        for c in pool:
            u = rng.random() or 1e-12
            keyed.append((u ** (1.0 / weight(c.risk_score)), c.matter_id))
        keyed.sort(reverse=True)
        result[fe_id] = [mid for _, mid in keyed[:per_fee_earner]]
    return result
