"""controls.yaml loading, validation, document-type mapping and field mapping."""

from __future__ import annotations

from datetime import date, datetime
from pathlib import Path

import pytest

from dms_analytics.adapters.base import RawDocument, RawWorkspace
from dms_analytics.controls.rules import (
    ControlsConfig,
    ControlsConfigError,
    FieldMapper,
    default_controls_text,
    load_controls,
    parse_controls,
)

BACKEND = Path(__file__).resolve().parents[1]


def test_example_file_matches_bundled_defaults() -> None:
    assert (BACKEND / "controls.example.yaml").read_text(encoding="utf-8") == \
        default_controls_text()


def test_example_file_is_valid() -> None:
    cfg = load_controls(BACKEND / "controls.example.yaml")
    assert cfg.thresholds["FO1_days"] == 5 and cfg.severity["CF1"] == 3
    assert cfg.key_date_mapped


def test_missing_file_falls_back_to_defaults(tmp_path: Path) -> None:
    cfg = load_controls(tmp_path / "nope.yaml")
    assert cfg.source == "built-in defaults"


@pytest.mark.parametrize(("snippet", "message"), [
    ("version: 2\nfield_map: {client_code: c1, matter_code: c2}", "version"),
    ("version: 1\nfield_map: {matter_code: c2}", "client_code is required"),
    ("version: 1\nfield_map: {client_code: c1, matter_code: c2, colour: c3}",
     "unknown field_map keys"),
    ("version: 1\nfield_map: {client_code: 'c1; DROP', matter_code: c2}", "profile field name"),
    ("version: 1\nfield_map: {client_code: c1, matter_code: c2}\ndoc_types: {cdd: [{}]}",
     "has no matcher"),
    ("version: 1\nfield_map: {client_code: c1, matter_code: c2}\ndoc_types: {invoice: "
     "[{class: X}]}", "unknown doc_types"),
    ("version: 1\nfield_map: {client_code: c1, matter_code: c2}\nthresholds: {FO1_days: 0}",
     "between 1 and 3650"),
    ("version: 1\nfield_map: {client_code: c1, matter_code: c2}\nthresholds: {XX_days: 3}",
     "unknown thresholds"),
    ("version: 1\nfield_map: {client_code: c1, matter_code: c2}\nseverity: {FO1: 5}",
     "must be 1, 2 or 3"),
    ("version: 1\nfield_map: {client_code: c1, matter_code: c2}\nsignature: x", "Extra inputs"),
    ("version: 1\nfield_map: {client_code: c1, matter_code: c2}\nsigned_name_patterns: ['(']",
     "invalid regular expression"),
    ("version: 1\nfield_map: [", "not valid YAML"),
    ("- just a list", "mapping at the top level"),
])
def test_invalid_yaml_gives_clear_error(snippet: str, message: str) -> None:
    with pytest.raises(ControlsConfigError) as err:
        parse_controls(snippet)
    assert message in str(err.value)


def test_most_specific_rule_wins(cfg: ControlsConfig) -> None:
    assert cfg.canonical_type("ENGAGE", "SIGNED", "x", "") == "engagement_signed"
    assert cfg.canonical_type("engage", None, "x", "") == "engagement_letter"
    assert cfg.canonical_type("KYC", "REFRESH", "x", "") == "cdd"
    assert cfg.canonical_type("CORR", None, "x", "") is None


def test_name_regex_and_folder_matchers() -> None:
    cfg = parse_controls("""
version: 1
field_map: {client_code: c1, matter_code: c2}
doc_types:
  attendance_note: [{name_regex: "(?i)^attendance"}, {folder: "Attendance Notes"}]
""")
    assert cfg.canonical_type("X", None, "Attendance with client", "") == "attendance_note"
    assert cfg.canonical_type("X", None, "Call", "Admin / attendance notes") == "attendance_note"
    assert cfg.canonical_type("X", None, "Call", "Admin / Notes") is None


def _ws(**profile: object) -> RawWorkspace:
    return RawWorkspace("LIB!1", "LIB", "WS name", "f01", "Fee Earner One",
                        datetime(2024, 1, 2, 9), datetime(2024, 1, 2, 9), dict(profile))


def test_field_mapper(cfg: ControlsConfig) -> None:
    m = FieldMapper(cfg).map_workspace(_ws(
        custom1="C1", custom1_description="Client (fictional)", custom2="C1-1",
        custom2_description="Matter (fictional)", custom3="Corporate", custom4="p01",
        custom4_description="Partner Alpha", custom5="Dublin", custom6="STANDARD",
        custom7="Active", custom21="2026-11-02", custom22=None))
    assert (m.client_code, m.client_name, m.matter_name) == ("C1", "Client (fictional)",
                                                             "Matter (fictional)")
    assert m.partner_id == "p01" and m.partner_name == "Partner Alpha"
    assert m.fee_earner_id == "f01" and m.status == "open"
    assert m.key_date == date(2026, 11, 2) and m.opened_at == datetime(2024, 1, 2, 9)


def test_field_mapper_closed_and_unknown_status(cfg: ControlsConfig) -> None:
    mapper = FieldMapper(cfg)
    closed = mapper.map_workspace(_ws(custom1="C", custom2="M", custom7="CLOSED",
                                      custom22="2025-05-01T10:00:00Z"))
    assert closed.status == "closed" and closed.closed_at == datetime(2025, 5, 1, 10)
    odd = mapper.map_workspace(_ws(custom1="C", custom2="M", custom7="On hold"))
    assert odd.status == "open" and odd.matter_name == "WS name"


def test_document_mapping(cfg: ControlsConfig) -> None:
    d = RawDocument("L!1.1", "LIB!1", "Admin", "File opening form", "FILEOPEN", None, "f01",
                    "Fee Earner One", datetime(2024, 1, 3), datetime(2024, 1, 3), 1, 100)
    assert FieldMapper(cfg).canonical_type(d) == "file_opening"
