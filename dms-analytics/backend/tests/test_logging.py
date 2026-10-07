"""Redaction: titles, names, tokens and query strings never reach the logs."""

from __future__ import annotations

import io
import json
import logging
from collections.abc import Iterator

import pytest

from dms_analytics.logging import REDACTED, configure_logging, log_event, scrub
from tests.conftest import AppFactory, local_client, signed_in_client

SECRET_TITLE = "Example Holdings Ltd (fictional) secret merger"


@pytest.fixture
def captured() -> Iterator[io.StringIO]:
    stream = io.StringIO()
    handler = configure_logging(logging.DEBUG, stream)
    yield stream
    logging.getLogger().removeHandler(handler)


def lines(stream: io.StringIO) -> list[dict[str, object]]:
    return [json.loads(x) for x in stream.getvalue().splitlines() if x.strip()]


def test_unsafe_fields_and_args_are_redacted(captured: io.StringIO) -> None:
    log = logging.getLogger("t")
    log_event(log, "sync_finished", count=3, matter_name=SECRET_TITLE, status="ok",
              kind=SECRET_TITLE)
    log.info("document %s by %s, %d pages", SECRET_TITLE, "Partner Alpha", 7)
    out = captured.getvalue()
    assert SECRET_TITLE not in out and "Partner Alpha" not in out
    first, second = lines(captured)
    assert first["count"] == 3 and first["status"] == "ok"
    assert first["matter_name"] == REDACTED and first["kind"] == REDACTED
    assert second["event"] == f"document {REDACTED} by {REDACTED}, 7 pages"


def test_exception_messages_are_dropped(captured: io.StringIO) -> None:
    log = logging.getLogger("t")
    try:
        raise ValueError(f"cannot parse {SECRET_TITLE}")
    except ValueError:
        log.exception("parse_failed")
    rec = lines(captured)[0]
    assert rec["error_type"] == "ValueError"
    assert SECRET_TITLE not in captured.getvalue()


@pytest.mark.parametrize("text", [
    "Authorization: Bearer abc.def-ghi_123",
    "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
    "GET /launch?code=AbCdEf123&x=1",
    'payload {"access_token": "s3cr3t", "refresh_token": "r3fr3sh"}',
    "refresh_token=r3fr3sh&client_id=x",
])
def test_scrubber_removes_tokens(text: str) -> None:
    out = scrub(text)
    for secret in ("abc.def-ghi_123", "c2lnbmF0dXJl", "AbCdEf123", "s3cr3t", "r3fr3sh"):
        assert secret not in out


def test_scrub_applies_to_event_text(captured: io.StringIO) -> None:
    logging.getLogger("t").warning("callback /auth/callback?code=xyz123&state=abc")
    assert "xyz123" not in captured.getvalue()


def test_requests_log_route_template_not_query(make_app: AppFactory,
                                               captured: io.StringIO) -> None:
    app, state = make_app()
    code = state.launch_codes.issue()
    local_client(app).get(f"/launch?code={code}")
    c = signed_in_client(app)
    c.get("/api/matters", params={"q": SECRET_TITLE})
    c.get("/api/matters/MOCK!ws-0001")
    out = captured.getvalue()
    assert code not in out
    assert "secret merger" not in out
    assert "MOCK!ws-0001" not in out
    routes = [x.get("route") for x in lines(captured) if x.get("event") == "request"]
    assert "/api/matters" in routes and "/api/matters/{matter_id}" in routes


def test_full_sync_logs_contain_no_names(make_app: AppFactory, captured: io.StringIO) -> None:
    app, state = make_app()
    c = signed_in_client(app)
    c.post("/api/sync/start")
    assert state.sync.wait(120)
    c.get("/api/matters")
    out = captured.getvalue()
    assert "(fictional)" not in out
    assert "Partner " not in out and "Fee Earner" not in out
    assert any(x.get("event") == "sync_finished" for x in lines(captured))
