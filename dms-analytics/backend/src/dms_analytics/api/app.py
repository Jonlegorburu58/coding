"""FastAPI application factory."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import datetime
from importlib import resources
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from dms_analytics.adapters.base import DmsAdapter
from dms_analytics.adapters.token_store import SecretBackend
from dms_analytics.api import (
    routes_data,
    routes_matters,
    routes_portfolio,
    routes_sync,
    routes_system,
)
from dms_analytics.api.schemas import error
from dms_analytics.api.state import AppState, utcnow
from dms_analytics.config import APP_VERSION, Settings
from dms_analytics.security import SecurityMiddleware, assert_loopback_bind


def static_dir() -> Path:
    return Path(str(resources.files("dms_analytics").joinpath("static")))


def _validation_message(exc: RequestValidationError) -> str:
    parts = []
    for err in exc.errors()[:3]:
        loc = [str(x) for x in err.get("loc", ()) if x not in ("query", "body", "path")]
        parts.append(f"{'.'.join(loc) or 'request'}: {err.get('msg', 'invalid')}")
    return "Invalid request. " + "; ".join(parts)


def create_app(settings: Settings, *, secret_backend: SecretBackend, adapter: DmsAdapter,
               clock: Callable[[], datetime] = utcnow) -> FastAPI:
    assert_loopback_bind(settings.host)
    if settings.dev and settings.mode != "mock":
        raise RuntimeError("DMS_ANALYTICS_DEV=1 is not allowed in live mode")
    state = AppState(settings, secret_backend, adapter, clock)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        state.close()

    app = FastAPI(title="BWS DMS Risk Analytics (local)", version=APP_VERSION,
                  docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.dms = state

    @app.exception_handler(RequestValidationError)
    async def _invalid(_: Request, exc: RequestValidationError) -> Response:
        return error(400, "invalid_request", _validation_message(exc))

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> Response:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "error")
        msg = {404: "Not found.", 405: "Method not allowed."}.get(exc.status_code, "Error.")
        return error(exc.status_code, code, msg)

    for module in (routes_system, routes_sync, routes_portfolio, routes_matters, routes_data):
        app.include_router(module.router)

    root = static_dir().resolve()

    def _serve(path: str) -> Response:
        if path == "api" or path.startswith("api/"):
            return error(404, "not_found", "Not found.")
        candidate = (root / path).resolve() if path else root / "index.html"
        if path and candidate.is_file() and candidate.is_relative_to(root):
            return FileResponse(candidate)
        return FileResponse(root / "index.html", headers={"cache-control": "no-store"})

    @app.get("/", include_in_schema=False)
    def index() -> Response:
        return _serve("")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> Response:
        return _serve(path)

    app.add_middleware(SecurityMiddleware, port=settings.port, sessions=state.sessions)
    return app
