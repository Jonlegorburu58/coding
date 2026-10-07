"""Shared fixtures. Everything runs against the mock firm and an in-memory
fake keychain; no network, no real keychain, no real data."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterator
from dataclasses import replace
from datetime import datetime
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from dms_analytics.adapters.base import DmsAdapter
from dms_analytics.adapters.mock import MockDmsAdapter
from dms_analytics.adapters.token_store import MemoryBackend
from dms_analytics.api.app import create_app
from dms_analytics.api.state import AppState
from dms_analytics.config import Settings
from dms_analytics.controls.rules import ControlsConfig, load_controls

NOW = datetime(2026, 10, 7, 12, 0, 0)


class SlowMock(MockDmsAdapter):
    """Mock that takes a little time per workspace, so cancellation can be tested."""

    async def iter_documents(self, library_id, workspace_id, since):  # type: ignore[no-untyped-def]
        await asyncio.sleep(0.02)
        async for page in super().iter_documents(library_id, workspace_id, since):
            yield page


BASE_URL = "http://127.0.0.1:8765"
API_HEADERS = {"X-DMS-Analytics": "1"}


@pytest.fixture
def now() -> datetime:
    return NOW


@pytest.fixture
def cfg() -> ControlsConfig:
    return load_controls(None)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(mode="mock", dev=False, data_dir=tmp_path / "data",
                    config_dir=tmp_path / "config", open_browser=False)


@pytest.fixture
def backend() -> MemoryBackend:
    return MemoryBackend()


AppFactory = Callable[..., tuple[FastAPI, AppState]]


@pytest.fixture
def make_app(settings: Settings, backend: MemoryBackend) -> Iterator[AppFactory]:
    created: list[AppState] = []

    def factory(adapter: DmsAdapter | None = None, **overrides: object
                ) -> tuple[FastAPI, AppState]:
        s = replace(settings, **overrides)  # type: ignore[arg-type]
        ad = adapter or MockDmsAdapter(now=NOW, n_workspaces=60)
        app = create_app(s, secret_backend=backend, adapter=ad, clock=lambda: NOW)
        state: AppState = app.state.dms
        created.append(state)
        return app, state

    yield factory
    for st in created:
        st.close()


def local_client(app: FastAPI, peer: str = "127.0.0.1") -> TestClient:
    return TestClient(app, base_url=BASE_URL, client=(peer, 50000), follow_redirects=False)


def signed_in_client(app: FastAPI) -> TestClient:
    state: AppState = app.state.dms
    c = local_client(app)
    r = c.get(f"/launch?code={state.launch_codes.issue()}")
    assert r.status_code == 302
    c.headers.update(API_HEADERS)
    return c


@pytest.fixture
def client(make_app: AppFactory) -> TestClient:
    app, _ = make_app()
    return signed_in_client(app)


@pytest.fixture
def synced(make_app: AppFactory) -> tuple[TestClient, AppState]:
    app, state = make_app()
    c = signed_in_client(app)
    r = c.post("/api/sync/start")
    assert r.status_code == 202
    assert state.sync.wait(120)
    last = c.get("/api/sync/status").json()["last"]
    assert last["status"] == "succeeded", last
    return c, state
