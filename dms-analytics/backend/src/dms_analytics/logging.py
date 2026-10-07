"""Structured JSON logging that redacts by default.

Rules (ARCHITECTURE §6):
- The log message is an *event name* (a fixed string chosen by the developer).
- Structured fields go in ``extra={"fields": {...}}``. Only keys in
  ``SAFE_KEYS`` are emitted as-is, and only when the value is a number, a
  boolean, ``None`` or a short identifier-like string. Anything else becomes
  ``"[REDACTED]"``.
- ``%``-style string arguments are replaced by ``[REDACTED]`` (numbers survive).
- Exception messages are dropped; only the exception type is logged, because
  messages can contain document titles or URLs with tokens.
- A final scrub removes anything that looks like a bearer token, JWT, OAuth
  code or secret query parameter.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from datetime import UTC, datetime
from typing import Any

REDACTED = "[REDACTED]"

SAFE_KEYS = frozenset({
    "event", "run_id", "kind", "status", "state", "mode", "count", "total", "done",
    "workspaces_done", "workspaces_total", "documents_seen", "deleted", "duration_ms",
    "method", "route", "status_code", "attempt", "retry_after_s", "delay_s", "page",
    "port", "version", "library_count", "matters", "controls", "error_type", "phase",
    "resumed", "snapshots", "purged", "migration", "chunks", "flow",
})

_IDENTIFIER = re.compile(r"^[A-Za-z0-9_.:/{}\-]{0,64}$")

_SCRUBBERS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?i)bearer\s+[A-Za-z0-9\-._~+/]+=*"), "Bearer " + REDACTED),
    (re.compile(r"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*"), REDACTED),
    (re.compile(
        r"(?i)\b(access_token|refresh_token|id_token|code|code_verifier|client_secret|"
        r"device_code|password|session|state)=([^&\s\"']+)"),
     r"\1=" + REDACTED),
    (re.compile(r"(?i)\"(access_token|refresh_token|id_token|password)\"\s*:\s*\"[^\"]*\""),
     r'"\1": "' + REDACTED + '"'),
]


def scrub(text: str) -> str:
    for pattern, repl in _SCRUBBERS:
        text = pattern.sub(repl, text)
    return text


def _safe_value(key: str, value: Any) -> Any:
    if key not in SAFE_KEYS:
        return REDACTED
    if value is None or isinstance(value, bool | int | float):
        return value
    if isinstance(value, str) and _IDENTIFIER.match(value):
        return value
    return REDACTED


class RedactingFilter(logging.Filter):
    """Neutralises string arguments before formatting."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.args:
            args = record.args if isinstance(record.args, tuple) else (record.args,)
            record.args = tuple(
                a if isinstance(a, bool | int | float) else REDACTED for a in args
            )
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        try:
            message = record.getMessage()
        except (TypeError, ValueError):
            message = str(record.msg)
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat().replace("+00:00", "Z"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "event": scrub(message),
        }
        fields = getattr(record, "fields", None)
        if isinstance(fields, dict):
            for key, value in fields.items():
                payload[str(key)] = _safe_value(str(key), value)
        if record.exc_info and record.exc_info[0] is not None:
            payload["error_type"] = record.exc_info[0].__name__
        return scrub(json.dumps(payload, ensure_ascii=True, default=lambda _: REDACTED))


def configure_logging(level: int = logging.INFO, stream: Any = None) -> logging.Handler:
    """Install the JSON + redaction handler on the root logger (idempotent)."""
    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, "_dms_analytics", False):
            root.removeHandler(h)
    handler = logging.StreamHandler(stream or sys.stderr)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(RedactingFilter())
    handler._dms_analytics = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    root.setLevel(level)
    # uvicorn's access log would print query strings (launch codes, search
    # text). It is disabled at server start; quieten its other loggers too.
    for name in ("uvicorn", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers = []
        lg.propagate = True
    logging.getLogger("uvicorn.access").disabled = True
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    return handler


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def log_event(logger: logging.Logger, event: str, level: int = logging.INFO,
              **fields: Any) -> None:
    logger.log(level, event, extra={"fields": fields})
