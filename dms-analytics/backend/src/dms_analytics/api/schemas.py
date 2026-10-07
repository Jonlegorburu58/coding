"""Request bodies and error helpers. Response shapes follow api-contract.yaml
and are verified by tests/test_contract.py against the YAML itself."""

from __future__ import annotations

from typing import Literal

from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field


class SyncStartBody(BaseModel):
    kind: Literal["auto", "full", "reconcile"] = "auto"


class SettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    retention_days: int | None = Field(default=None, ge=1, le=365, strict=True)
    sample_per_fee_earner: int | None = Field(default=None, ge=1, le=10, strict=True)


class WipeBody(BaseModel):
    confirm: Literal[True]


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"code": code, "message": message}, status_code=status)
