"""Load and validate ``controls.yaml`` (data-model.md) and apply its mappings."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import UTC, date, datetime
from importlib import resources
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from dms_analytics.adapters.base import RawDocument, RawWorkspace

CONTROL_IDS = ("FO1", "CF1", "AML1", "AML2", "EL1", "EL2", "AN1", "CD1", "FE1", "FE2", "HY1")
CANONICAL_TYPES = (
    "file_opening", "conflict_clearance", "cdd", "engagement_letter", "engagement_signed",
    "s150_notice", "attendance_note", "costs_update", "bill",
)
FIELD_MAP_KEYS = (
    "client_code", "matter_code", "practice_area", "partner", "fee_earner", "office",
    "matter_type", "status", "key_date", "opened_at", "closed_at",
)
THRESHOLD_DEFAULTS = {
    "FO1_days": 5, "EL1_days": 14, "AML2_months": 36, "AN1_days": 90,
    "FE1_months": 12, "FE2_months": 6, "HY1_months": 12,
}
SEVERITY_DEFAULTS = {
    "FO1": 2, "CF1": 3, "AML1": 3, "AML2": 2, "EL1": 3, "EL2": 2,
    "AN1": 1, "CD1": 2, "FE1": 2, "FE2": 1, "HY1": 1,
}


class ControlsConfigError(Exception):
    """controls.yaml is missing or invalid. The message is safe to show."""


class MatchRule(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    class_: str | None = Field(default=None, alias="class")
    subclass: str | None = None
    name_regex: str | None = None
    folder: str | None = None

    @field_validator("name_regex")
    @classmethod
    def _regex_compiles(cls, v: str | None) -> str | None:
        if v is not None:
            try:
                re.compile(v)
            except re.error as exc:
                raise ValueError(f"invalid regular expression: {exc}") from exc
        return v

    def specificity(self) -> int:
        return sum(x is not None for x in (self.class_, self.subclass, self.name_regex,
                                           self.folder))


class StatusValues(BaseModel):
    model_config = ConfigDict(extra="forbid")
    open: list[str] = Field(default_factory=lambda: ["OPEN"])
    closed: list[str] = Field(default_factory=lambda: ["CLOSED"])


class ControlsModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int
    field_map: dict[str, str]
    status_values: StatusValues = Field(default_factory=StatusValues)
    doc_types: dict[str, list[MatchRule]] = Field(default_factory=dict)
    intake_classes: list[str] = Field(default_factory=list)
    signed_name_patterns: list[str] = Field(default_factory=list)
    aml_exempt_matter_types: list[str] = Field(default_factory=list)
    thresholds: dict[str, int] = Field(default_factory=dict)
    severity: dict[str, int] = Field(default_factory=dict)

    @field_validator("version")
    @classmethod
    def _version(cls, v: int) -> int:
        if v != 1:
            raise ValueError("only version 1 is supported")
        return v

    @field_validator("field_map")
    @classmethod
    def _field_map(cls, v: dict[str, str]) -> dict[str, str]:
        unknown = sorted(set(v) - set(FIELD_MAP_KEYS))
        if unknown:
            raise ValueError(f"unknown field_map keys {unknown}; allowed: {list(FIELD_MAP_KEYS)}")
        for required in ("client_code", "matter_code"):
            if not v.get(required):
                raise ValueError(f"field_map.{required} is required")
        for key, value in v.items():
            if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_]+", value):
                raise ValueError(f"field_map.{key} must be a profile field name like 'custom1'")
        return v

    @field_validator("doc_types")
    @classmethod
    def _doc_types(cls, v: dict[str, list[MatchRule]]) -> dict[str, list[MatchRule]]:
        unknown = sorted(set(v) - set(CANONICAL_TYPES))
        if unknown:
            raise ValueError(f"unknown doc_types {unknown}; allowed: {list(CANONICAL_TYPES)}")
        for name, rules in v.items():
            for i, rule in enumerate(rules):
                if rule.specificity() == 0:
                    raise ValueError(f"doc_types.{name}[{i}] has no matcher "
                                     "(use class, subclass, name_regex or folder)")
        return v

    @field_validator("signed_name_patterns")
    @classmethod
    def _patterns(cls, v: list[str]) -> list[str]:
        for p in v:
            try:
                re.compile(p)
            except re.error as exc:
                raise ValueError(f"invalid regular expression {p!r}: {exc}") from exc
        return v

    @field_validator("thresholds")
    @classmethod
    def _thresholds(cls, v: dict[str, int]) -> dict[str, int]:
        unknown = sorted(set(v) - set(THRESHOLD_DEFAULTS))
        if unknown:
            raise ValueError(f"unknown thresholds {unknown}; allowed: {list(THRESHOLD_DEFAULTS)}")
        for k, n in v.items():
            if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= 3650:
                raise ValueError(f"thresholds.{k} must be a whole number between 1 and 3650")
        return v

    @field_validator("severity")
    @classmethod
    def _severity(cls, v: dict[str, int]) -> dict[str, int]:
        unknown = sorted(set(v) - set(CONTROL_IDS))
        if unknown:
            raise ValueError(f"unknown control ids in severity {unknown}")
        for k, n in v.items():
            if isinstance(n, bool) or n not in (1, 2, 3):
                raise ValueError(f"severity.{k} must be 1, 2 or 3")
        return v


@dataclass(frozen=True)
class CompiledRule:
    canonical_type: str
    order: int
    specificity: int
    class_: str | None
    subclass: str | None
    name_regex: re.Pattern[str] | None
    folder: str | None

    def matches(self, doc_class: str | None, doc_subclass: str | None, name: str,
                folder_path: str) -> bool:
        if self.class_ is not None and (doc_class or "").upper() != self.class_.upper():
            return False
        if self.subclass is not None and (doc_subclass or "").upper() != self.subclass.upper():
            return False
        if self.name_regex is not None and not self.name_regex.search(name or ""):
            return False
        if self.folder is not None:
            segments = [s.strip().lower() for s in (folder_path or "").split(" / ")]
            if self.folder.strip().lower() not in segments:
                return False
        return True


class ControlsConfig:
    """Validated, compiled controls configuration."""

    def __init__(self, model: ControlsModel, source: str, digest: str) -> None:
        self.model = model
        self.source = source
        self.digest = digest
        self.loaded_at = datetime.now(UTC).replace(tzinfo=None)
        self.thresholds = {**THRESHOLD_DEFAULTS, **model.thresholds}
        self.severity = {**SEVERITY_DEFAULTS, **model.severity}
        self.intake_classes = frozenset(c.upper() for c in model.intake_classes)
        self.signed_patterns = [re.compile(p) for p in model.signed_name_patterns]
        self.aml_exempt = frozenset(model.aml_exempt_matter_types)
        self.field_map = dict(model.field_map)
        self.open_values = frozenset(s.upper() for s in model.status_values.open)
        self.closed_values = frozenset(s.upper() for s in model.status_values.closed)
        rules: list[CompiledRule] = []
        order = 0
        for ctype, rule_list in model.doc_types.items():
            for r in rule_list:
                rules.append(CompiledRule(
                    canonical_type=ctype, order=order, specificity=r.specificity(),
                    class_=r.class_, subclass=r.subclass,
                    name_regex=re.compile(r.name_regex) if r.name_regex else None,
                    folder=r.folder,
                ))
                order += 1
        # most specific first, then file order
        self.rules = sorted(rules, key=lambda x: (-x.specificity, x.order))

    def configured_types(self) -> frozenset[str]:
        return frozenset(r.canonical_type for r in self.rules)

    def canonical_type(self, doc_class: str | None, doc_subclass: str | None, name: str,
                       folder_path: str) -> str | None:
        for rule in self.rules:
            if rule.matches(doc_class, doc_subclass, name, folder_path):
                return rule.canonical_type
        return None

    def is_intake(self, doc_class: str | None) -> bool:
        return (doc_class or "").upper() in self.intake_classes

    def name_looks_signed(self, name: str) -> bool:
        return any(p.search(name or "") for p in self.signed_patterns)

    @property
    def key_date_mapped(self) -> bool:
        return bool(self.field_map.get("key_date"))


def _format_validation_error(exc: ValidationError) -> str:
    parts = []
    for err in exc.errors():
        loc = ".".join(str(x) for x in err["loc"]) or "(top level)"
        msg = str(err["msg"]).removeprefix("Value error, ")
        parts.append(f"{loc}: {msg}")
    return "; ".join(parts)


def parse_controls(text: str, source: str = "controls.yaml") -> ControlsConfig:
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ControlsConfigError(f"{source} is not valid YAML: {exc}") from exc
    if not isinstance(data, dict):
        raise ControlsConfigError(f"{source} must be a mapping at the top level")
    try:
        model = ControlsModel.model_validate(data)
    except ValidationError as exc:
        raise ControlsConfigError(f"{source} is invalid: {_format_validation_error(exc)}") from exc
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return ControlsConfig(model, source, digest)


def default_controls_text() -> str:
    return resources.files("dms_analytics.controls").joinpath(
        "default_controls.yaml").read_text(encoding="utf-8")


def load_controls(path: Path | None) -> ControlsConfig:
    """Load from ``path`` if it exists, else the bundled defaults (mock class codes)."""
    if path is not None and path.exists():
        return parse_controls(path.read_text(encoding="utf-8"), source=str(path))
    return parse_controls(default_controls_text(), source="built-in defaults")


# ---------------------------------------------------------------------------
# Field mapping (raw DMS profile -> canonical matter fields)


@dataclass(frozen=True)
class MappedMatter:
    id: str
    library_id: str
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
    matter_type: str | None
    status: str
    opened_at: datetime
    closed_at: datetime | None
    key_date: date | None


def _to_naive_utc(dt: datetime) -> datetime:
    if dt.tzinfo is not None:
        return dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def parse_dt(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return _to_naive_utc(value)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day)
    text = str(value).strip()
    try:
        return _to_naive_utc(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return None


class FieldMapper:
    def __init__(self, config: ControlsConfig) -> None:
        self.config = config

    def _val(self, ws: RawWorkspace, key: str) -> Any:
        field_name = self.config.field_map.get(key)
        if not field_name:
            return None
        return ws.profile.get(field_name)

    def _desc(self, ws: RawWorkspace, key: str) -> Any:
        field_name = self.config.field_map.get(key)
        if not field_name:
            return None
        return ws.profile.get(f"{field_name}_description")

    @staticmethod
    def _s(v: Any) -> str | None:
        if v is None:
            return None
        s = str(v).strip()
        return s or None

    def map_workspace(self, ws: RawWorkspace) -> MappedMatter:
        client_code = self._s(self._val(ws, "client_code")) or ""
        matter_code = self._s(self._val(ws, "matter_code")) or ""
        status_raw = (self._s(self._val(ws, "status")) or "").upper()
        status = "closed" if status_raw in self.config.closed_values else "open"
        opened = parse_dt(self._val(ws, "opened_at")) or _to_naive_utc(ws.created_at)
        closed = parse_dt(self._val(ws, "closed_at")) if status == "closed" else None
        kd = parse_dt(self._val(ws, "key_date"))
        partner_id = self._s(self._val(ws, "partner"))
        if self.config.field_map.get("fee_earner"):
            fe_id = self._s(self._val(ws, "fee_earner"))
            fe_name = self._s(self._desc(ws, "fee_earner"))
        else:
            fe_id, fe_name = ws.owner_id, ws.owner_name
        return MappedMatter(
            id=ws.id,
            library_id=ws.library_id,
            client_code=client_code,
            client_name=self._s(self._desc(ws, "client_code")) or client_code,
            matter_code=matter_code,
            matter_name=self._s(self._desc(ws, "matter_code")) or ws.name,
            practice_area=self._s(self._desc(ws, "practice_area"))
            or self._s(self._val(ws, "practice_area")),
            partner_id=partner_id,
            partner_name=self._s(self._desc(ws, "partner")) or partner_id,
            fee_earner_id=fe_id,
            fee_earner_name=fe_name or fe_id,
            office=self._s(self._desc(ws, "office")) or self._s(self._val(ws, "office")),
            matter_type=self._s(self._val(ws, "matter_type")),
            status=status,
            opened_at=opened,
            closed_at=closed,
            key_date=kd.date() if kd else None,
        )

    def canonical_type(self, doc: RawDocument) -> str | None:
        return self.config.canonical_type(doc.doc_class, doc.doc_subclass, doc.name,
                                          doc.folder_path)
