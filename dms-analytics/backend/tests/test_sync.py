"""Sync engine: full, incremental, reconcile, cancel, resume, snapshots, wipe."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any

from dms_analytics.adapters.mock import MockDmsAdapter
from dms_analytics.api.state import AppState
from dms_analytics.sync.engine import RECONCILE_EVERY, SyncEngine
from tests.conftest import NOW, AppFactory, SlowMock, signed_in_client


def run_sync(state: AppState, kind: str = "auto") -> dict[str, Any]:
    state.sync.start(kind)
    assert state.sync.wait(120)
    last: dict[str, Any] | None = state.sync.status()["last"]
    assert last is not None
    return last


def test_full_then_incremental_then_reconcile(make_app: AppFactory) -> None:
    ad = MockDmsAdapter(now=NOW, n_workspaces=80)
    _, state = make_app(ad)
    first = run_sync(state)
    assert first["kind"] == "full" and first["status"] == "succeeded"
    assert first["workspaces_total"] == 80 == first["workspaces_done"]
    docs_total = sum(len(w.docs) for w in ad.workspaces)
    assert state.repo.coverage() == (1, 80, docs_total)
    lib = state.repo.libraries()[0]
    assert lib["watermark"] is not None and lib["last_full_sync"] is not None

    second = run_sync(state)
    assert second["kind"] == "incremental" and second["status"] == "succeeded"
    assert 0 < second["documents_seen"] < docs_total / 10
    restricted = {w.raw.id for w in ad.workspaces if w.restricted}
    assert restricted and not (restricted & state.repo.matter_ids())  # access loss purged

    kinds = [run_sync(state)["kind"] for _ in range(RECONCILE_EVERY)]
    assert "reconcile" in kinds
    # F, I x6, R: the reconcile is the 7th sync after the last full/reconcile
    assert kinds.index("reconcile") == RECONCILE_EVERY - 2
    assert kinds.count("reconcile") == 1


def test_reconcile_removes_deleted_documents(make_app: AppFactory) -> None:
    ad = MockDmsAdapter(now=NOW, n_workspaces=80)
    _, state = make_app(ad)
    run_sync(state, "full")
    deleted = {d for w in ad.workspaces if not w.restricted for d in w.deleted_doc_ids}
    assert deleted
    run_sync(state, "reconcile")
    left = {r[0] for r in state.repo.db.fetchall("SELECT id FROM document")}
    assert not (deleted & left)
    assert state.repo.libraries()[0]["last_reconcile"] is not None


def test_controls_and_snapshots_after_sync(make_app: AppFactory) -> None:
    _, state = make_app()
    run_sync(state)
    n_matters = state.repo.coverage()[1]
    assert state.repo.db.fetchone("SELECT count(*) FROM control_result") == (n_matters * 11,)
    snaps = state.repo.db.fetchall("SELECT taken_at FROM portfolio_snapshot WHERE "
                                   "control_id = 'ALL' ORDER BY taken_at")
    assert len(snaps) == 13  # 12 back-dated (mock only) + 1 real
    assert snaps[0][0].year == NOW.year - 1
    run_sync(state)
    assert state.repo.db.fetchone(
        "SELECT count(*) FROM portfolio_snapshot WHERE control_id = 'ALL'") == (13,)


def test_no_backfill_outside_mock(make_app: AppFactory) -> None:
    _, state = make_app()
    engine = SyncEngine(state.repo, state.adapter, state.controls, lambda: NOW, is_mock=False)
    run_id = state.repo.create_run("full", NOW)
    asyncio.run(engine.run(run_id, "full", None))
    assert state.repo.db.fetchone(
        "SELECT count(*) FROM portfolio_snapshot WHERE control_id = 'ALL'") == (1,)


def test_cancel_then_resume(make_app: AppFactory) -> None:
    ad = SlowMock(now=NOW, n_workspaces=80)
    _, state = make_app(ad)
    state.sync.start("full")
    deadline = time.time() + 30
    while state.sync.current_run() and (state.sync.current_run() or {}).get(
            "workspaces_done", 0) < 15 and time.time() < deadline:
        time.sleep(0.02)
    state.sync.cancel()
    assert state.sync.state in ("cancelling", "idle")
    assert state.sync.wait(60)
    cancelled = state.sync.status()["last"]
    assert cancelled["status"] == "cancelled"
    assert 0 < cancelled["workspaces_done"] < 80

    calls_before = dict(ad.document_listings)
    resumed = run_sync(state)
    assert resumed["kind"] == "full" and resumed["status"] == "succeeded"
    # restricted workspaces vanish on the second listing (access revoked)
    assert resumed["workspaces_done"] == resumed["workspaces_total"] == 80 - sum(
        w.restricted for w in ad.workspaces)
    # workspaces finished before the cancel were not listed again
    relisted = [w for w, n in ad.document_listings.items() if n > calls_before.get(w, 0)]
    assert len(relisted) <= 80 - cancelled["workspaces_done"] + 1
    assert state.repo.resumable_run() is None


def test_crash_mid_sync_resumes_after_restart(make_app: AppFactory, tmp_path) -> None:  # type: ignore[no-untyped-def]
    ad = MockDmsAdapter(now=NOW, n_workspaces=40)
    _, state = make_app(ad)
    run_id = state.repo.create_run("full", NOW)
    state.repo.update_run(run_id, workspaces_done=10, workspaces_total=40, documents_seen=5,
                          checkpoint={"kind": "full", "done": {"MOCK": ["MOCK!ws-0001"]},
                                      "since": {"MOCK": None}})
    state.close()  # simulate the process dying with the run still 'running'
    _, state2 = make_app(ad)
    last = state2.sync.status()["last"]
    assert last["status"] == "failed" and "Interrupted" in last["error"]
    resumable = state2.repo.resumable_run()
    assert resumable is not None and resumable["kind"] == "full"
    done = run_sync(state2)
    assert done["status"] == "succeeded" and done["kind"] == "full"


def test_sync_busy_and_not_signed_in(make_app: AppFactory) -> None:
    app, state = make_app(SlowMock(now=NOW, n_workspaces=40))
    c = signed_in_client(app)
    assert c.post("/api/sync/start").status_code == 202
    r = c.post("/api/sync/start")
    assert r.status_code == 409 and r.json()["code"] == "sync_running"
    assert state.sync.wait(60)
    c.post("/api/auth/sign-out")
    r = c.post("/api/sync/start")
    assert r.status_code == 409 and r.json()["code"] == "not_signed_in"


def test_progress_is_visible_while_running(make_app: AppFactory) -> None:
    app, state = make_app(SlowMock(now=NOW, n_workspaces=60))
    c = signed_in_client(app)
    c.post("/api/sync/start")
    seen: list[int] = []
    while state.sync.state != "idle":
        cur = c.get("/api/sync/status").json()["current"]
        if cur:
            seen.append(cur["workspaces_done"])
        time.sleep(0.05)
    assert len(set(seen)) > 2 and seen == sorted(seen)


def test_wipe_during_sync_and_key_rotation(make_app: AppFactory, backend) -> None:  # type: ignore[no-untyped-def]
    app, state = make_app(SlowMock(now=NOW, n_workspaces=60))
    c = signed_in_client(app)
    run_sync(state)
    key_before = state.secrets.get("db-key")
    c.post("/api/sync/start")
    assert c.post("/api/data/wipe", json={"confirm": True}).status_code == 204
    assert state.sync.state == "idle"
    assert state.repo.coverage() == (0, 0, 0)
    assert state.secrets.get("db-key") != key_before
    assert c.get("/api/session").json()["has_data"] is False
    assert c.post("/api/data/wipe", json={"confirm": True}).status_code == 204  # idempotent
    assert run_sync(state)["status"] == "succeeded"


def test_retention_purge_at_startup(make_app: AppFactory) -> None:
    ad = MockDmsAdapter(now=NOW, n_workspaces=20)
    _, state = make_app(ad)
    run_sync(state)
    state.repo.set_setting("retention_days", "1")
    state.repo.db.execute("UPDATE matter SET synced_at = synced_at - INTERVAL 3 DAY "
                          "WHERE id IN (SELECT id FROM matter ORDER BY id LIMIT 5)")
    state.close()
    _, state2 = make_app(ad)
    assert state2.repo.coverage()[1] == 20 - 5


def test_controls_file_change_is_picked_up(make_app: AppFactory, settings) -> None:  # type: ignore[no-untyped-def]
    from dms_analytics.controls.rules import default_controls_text

    settings.config_dir.mkdir(parents=True, exist_ok=True)
    path = settings.config_dir / "controls.yaml"
    path.write_text(default_controls_text(), encoding="utf-8")
    app, state = make_app()
    c = signed_in_client(app)
    run_sync(state)
    assert c.get("/api/settings").json()["controls_file"] == str(path)
    text = default_controls_text().replace("  bill:               [{ class: \"BILL\" }]\n", "")
    path.write_text(text, encoding="utf-8")
    import os
    os.utime(path, (time.time() + 5, time.time() + 5))
    run_sync(state)
    fe2 = next(x for x in c.get("/api/controls").json() if x["id"] == "FE2")
    assert fe2["configured"] is False
    assert state.repo.db.fetchone(
        "SELECT count(*) FROM document WHERE canonical_type = 'bill'") == (0,)
    path.write_text("version: 9", encoding="utf-8")
    os.utime(path, (time.time() + 10, time.time() + 10))
    r = c.post("/api/sync/start")
    assert r.status_code == 409 and r.json()["code"] == "controls_invalid"


def test_checkpoint_json_roundtrip(make_app: AppFactory) -> None:
    _, state = make_app()
    rid = state.repo.create_run("incremental", NOW, {"done": {"MOCK": ["a"]}})
    row = state.repo.get_run(rid)
    assert row is not None and json.loads(row["checkpoint"])["done"] == {"MOCK": ["a"]}


def test_only_one_sync_thread(make_app: AppFactory) -> None:
    _, state = make_app(SlowMock(now=NOW, n_workspaces=30))
    state.sync.start()
    names = [t.name for t in threading.enumerate() if t.name == "dms-sync"]
    assert len(names) == 1
    state.sync.wait(60)
