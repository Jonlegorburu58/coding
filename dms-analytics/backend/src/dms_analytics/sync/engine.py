"""Sync engine (ARCHITECTURE §5) and the background sync manager.

Kinds:
- ``full``: list every workspace and every document; delete local records
  that are no longer listed (access lost / deleted).
- ``incremental``: workspaces changed since the watermark, plus changed
  documents in every known workspace (one container listing each, which also
  confirms the user can still see it).
- ``reconcile``: a full re-listing that records ``last_reconcile``; chosen
  automatically on every 7th sync.

Each run checkpoints the workspaces it has finished, so a crashed or cancelled
run resumes where it stopped. After a successful run the controls engine
re-evaluates every matter (time-based controls change daily even without new
documents) and a ``portfolio_snapshot`` is written.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from dms_analytics.adapters.base import AccessLostError, AdapterError, DmsAdapter, RawDocument
from dms_analytics.controls.engine import (
    ControlOutcome,
    MatterFacts,
    add_months,
    as_of,
    evaluate_matter,
)
from dms_analytics.controls.rules import CONTROL_IDS, ControlsConfig, FieldMapper
from dms_analytics.controls.scoring import Tally, mean_readiness, risk_score
from dms_analytics.logging import log_event
from dms_analytics.store.repo import Person, Repo

log = logging.getLogger(__name__)

WATERMARK_OVERLAP = timedelta(hours=1)
RECONCILE_EVERY = 7
CHECKPOINT_EVERY = 10


class SyncCancelled(Exception):
    pass


class SyncBusyError(Exception):
    pass


class SyncNotRunningError(Exception):
    pass


@dataclass
class Progress:
    run_id: str
    kind: str
    started_at: datetime
    workspaces_done: int = 0
    workspaces_total: int | None = None
    documents_seen: int = 0
    deleted: int = 0


# ---------------------------------------------------------------------------
# Evaluation and snapshots (also used at startup and after config changes)


def evaluate_all(repo: Repo, cfg: ControlsConfig, now: datetime
                 ) -> tuple[list[MatterFacts], dict[str, list[ControlOutcome]]]:
    matters, docs = repo.load_facts()
    results = {m.id: evaluate_matter(m, docs.get(m.id, []), cfg, now) for m in matters}
    repo.replace_control_results(results, now)
    return matters, results


def snapshot_rows(matters: list[MatterFacts], results: dict[str, list[ControlOutcome]],
                  cfg: ControlsConfig) -> list[tuple[str, int, int, float | None]]:
    """Snapshot over open matters. ``applicable`` = assessed (pass+late+missing+stale)."""
    tallies = {cid: Tally(cid) for cid in CONTROL_IDS}
    scores: list[float | None] = []
    for m in matters:
        if m.status != "open":
            continue
        outcomes = results.get(m.id, [])
        for o in outcomes:
            tallies[o.control_id].add(o.status)
        scores.append(risk_score({o.control_id: o.status for o in outcomes}, cfg.severity))
    rows: list[tuple[str, int, int, float | None]] = []
    total_assessed = total_pass = 0
    for cid, t in tallies.items():
        rate = t.compliance_rate
        rows.append((cid, t.assessed, t.pass_, None if rate is None else round(rate * 100, 1)))
        total_assessed += t.assessed
        total_pass += t.pass_
    rows.append(("ALL", total_assessed, total_pass, mean_readiness(scores)))
    return rows


def backfill_mock_snapshots(repo: Repo, cfg: ControlsConfig, now: datetime,
                            months: int = 12) -> int:
    """MOCK MODE ONLY. Writes 12 months of back-dated snapshots so trend charts
    have data on a fresh install. Each one re-evaluates the controls as of a
    past date using only documents that existed then. Never used in live mode:
    live trends start from the first real sync.
    """
    matters, docs = repo.load_facts()
    written = 0
    for k in range(months, 0, -1):
        when = add_months(now, -k)
        past_matters: list[MatterFacts] = []
        past_results: dict[str, list[ControlOutcome]] = {}
        for m in matters:
            state = as_of(m, docs.get(m.id, []), when)
            if state is None:
                continue
            pm, pdocs = state
            past_matters.append(pm)
            past_results[pm.id] = evaluate_matter(pm, pdocs, cfg, when)
        repo.insert_snapshot(when, snapshot_rows(past_matters, past_results, cfg))
        written += 1
    return written


# ---------------------------------------------------------------------------
# Engine


class SyncEngine:
    def __init__(self, repo: Repo, adapter: DmsAdapter, cfg: ControlsConfig,
                 clock: Callable[[], datetime], is_mock: bool,
                 cancel: threading.Event | None = None) -> None:
        self.repo = repo
        self.adapter = adapter
        self.cfg = cfg
        self.mapper = FieldMapper(cfg)
        self.clock = clock
        self.is_mock = is_mock
        self.cancel = cancel or threading.Event()
        self.progress: Progress | None = None

    def _check_cancel(self) -> None:
        if self.cancel.is_set():
            raise SyncCancelled()

    async def _list_docs(self, lib_id: str, ws_id: str,
                         since: datetime | None) -> list[RawDocument] | None:
        docs: list[RawDocument] = []
        try:
            async for page in self.adapter.iter_documents(lib_id, ws_id, since):
                docs.extend(page)
        except AccessLostError:
            return None
        return docs

    async def run(self, run_id: str, kind: str, checkpoint: dict[str, Any] | None) -> Progress:
        repo, now = self.repo, self.clock()
        cp: dict[str, Any] = {"kind": kind, "done": {}, "since": {}, **(checkpoint or {})}
        progress = Progress(run_id, kind, now)
        self.progress = progress
        resumed = bool(checkpoint)
        log_event(log, "sync_started", run_id=run_id, kind=kind, resumed=resumed)

        libs = await self.adapter.list_libraries()
        plan: list[tuple[str, datetime | None, list[str]]] = []
        for lib in libs:
            self._check_cancel()
            repo.upsert_library(lib.id, lib.name)
            info = repo.get_library(lib.id) or {}
            since: datetime | None = None
            if kind == "incremental":
                if lib.id in cp["since"]:
                    since = datetime.fromisoformat(cp["since"][lib.id]) if cp["since"][
                        lib.id] else None
                elif info.get("watermark"):
                    since = info["watermark"] - WATERMARK_OVERLAP
            cp["since"][lib.id] = since.isoformat() if since else None
            listed = []
            async for page in self.adapter.iter_workspaces(lib.id, since):
                self._check_cancel()
                listed.extend(page)
            mapped = [self.mapper.map_workspace(w) for w in listed]
            people: list[Person] = []
            for m in mapped:
                if m.partner_id:
                    people.append(Person(m.partner_id, m.partner_name or m.partner_id, None,
                                         False))
                if m.fee_earner_id:
                    people.append(Person(m.fee_earner_id, m.fee_earner_name or m.fee_earner_id,
                                         m.office, True))
            repo.upsert_persons(people)
            repo.upsert_matters(mapped, now)
            listed_ids = {m.id for m in mapped}
            if since is None:
                gone = repo.matter_ids(lib.id) - listed_ids
                if gone:
                    progress.deleted += repo.delete_matters(gone)
                    log_event(log, "access_reconciled", deleted=len(gone))
                targets = sorted(listed_ids)
            else:
                targets = sorted(repo.matter_ids(lib.id))
            plan.append((lib.id, since, targets))

        progress.workspaces_total = sum(len(t) for _, _, t in plan)
        done_sets = {lib_id: set(cp["done"].get(lib_id, [])) for lib_id, _, _ in plan}
        progress.workspaces_done = sum(len(done_sets[lib] & set(t)) for lib, _, t in plan)
        concurrency = max(1, self.adapter.capabilities().max_concurrency)

        for lib_id, since, targets in plan:
            done = done_sets[lib_id]
            todo = [w for w in targets if w not in done]
            touched: list[str] = []
            for i in range(0, len(todo), concurrency):
                self._check_cancel()
                chunk = todo[i:i + concurrency]
                listings = await asyncio.gather(
                    *(self._list_docs(lib_id, ws_id, since) for ws_id in chunk))
                for ws_id, docs in zip(chunk, listings, strict=True):
                    if docs is None:  # access lost
                        progress.deleted += repo.delete_matters([ws_id])
                    else:
                        self._store_docs(ws_id, docs, full_listing=since is None, now=now)
                        progress.documents_seen += len(docs)
                        touched.append(ws_id)
                    done.add(ws_id)
                    progress.workspaces_done += 1
                if progress.workspaces_done % CHECKPOINT_EVERY < len(chunk) or i + len(
                        chunk) >= len(todo):
                    repo.touch_matters(touched, now)
                    touched = []
                    cp["done"][lib_id] = sorted(done)
                    repo.update_run(run_id, workspaces_done=progress.workspaces_done,
                                    workspaces_total=progress.workspaces_total,
                                    documents_seen=progress.documents_seen, checkpoint=cp)
            repo.update_library(lib_id, watermark=repo.max_edited_at(lib_id),
                                full=kind == "full", reconcile=kind in ("full", "reconcile"),
                                now=now)

        repo.refresh_rollups()
        matters, results = evaluate_all(repo, self.cfg, now)
        snapshots = 0
        if self.is_mock and repo.snapshot_count() == 0:
            snapshots = backfill_mock_snapshots(repo, self.cfg, now)  # MOCK ONLY
        repo.insert_snapshot(now, snapshot_rows(matters, results, self.cfg))
        log_event(log, "sync_finished", run_id=run_id, kind=kind,
                  workspaces_done=progress.workspaces_done,
                  documents_seen=progress.documents_seen, deleted=progress.deleted,
                  snapshots=snapshots + 1)
        return progress

    def _store_docs(self, ws_id: str, docs: list[RawDocument], full_listing: bool,
                    now: datetime) -> None:
        canonical = [self.mapper.canonical_type(d) for d in docs]
        self.repo.upsert_documents(docs, canonical, now)
        authors = {d.author_id: d.author_name for d in docs if d.author_id}
        if authors:
            self.repo.upsert_persons(Person(a, n or a, None, False) for a, n in authors.items())
        if full_listing:
            self.repo.delete_documents_not_in(ws_id, [d.id for d in docs])


# ---------------------------------------------------------------------------
# Background manager


def _run_dict(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {k: row.get(k) for k in ("id", "kind", "status", "started_at", "finished_at",
                                     "workspaces_done", "workspaces_total", "documents_seen",
                                     "error")}


class SyncManager:
    """Runs one sync at a time on a background thread with its own event loop."""

    def __init__(self, repo_provider: Callable[[], Repo], adapter: DmsAdapter,
                 controls_provider: Callable[[], ControlsConfig],
                 clock: Callable[[], datetime], is_mock: bool,
                 on_finished: Callable[[], None] | None = None) -> None:
        self.repo_provider = repo_provider
        self.adapter = adapter
        self.controls_provider = controls_provider
        self.clock = clock
        self.is_mock = is_mock
        self.on_finished = on_finished
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._cancel = threading.Event()
        self._engine: SyncEngine | None = None
        self._run_id: str | None = None
        self.blocked = False  # set while local data is being wiped

    @property
    def state(self) -> str:
        if self._thread is None or not self._thread.is_alive():
            return "idle"
        return "cancelling" if self._cancel.is_set() else "running"

    def resolve_kind(self, requested: str) -> tuple[str, dict[str, Any] | None]:
        repo = self.repo_provider()
        resumable = repo.resumable_run()
        if resumable and requested in ("auto", resumable["kind"]):
            return str(resumable["kind"]), resumable["checkpoint"]
        if requested in ("full", "reconcile"):
            return requested, None
        libs = repo.libraries()
        if not libs or any(lib["last_full_sync"] is None for lib in libs):
            return "full", None
        since_reconcile = repo.successful_runs_since_reconcile()
        if since_reconcile is None or since_reconcile >= RECONCILE_EVERY - 1:
            return "reconcile", None
        return "incremental", None

    def start(self, requested: str = "auto") -> dict[str, Any]:
        with self._lock:
            if self.state != "idle" or self.blocked:
                raise SyncBusyError()
            if not self.adapter.is_signed_in():
                raise AdapterError("not_signed_in")
            kind, checkpoint = self.resolve_kind(requested)
            repo = self.repo_provider()
            run_id = repo.create_run(kind, self.clock(), checkpoint)
            self._cancel = threading.Event()
            self._run_id = run_id
            cfg = self.controls_provider()
            self._engine = SyncEngine(repo, self.adapter, cfg, self.clock, self.is_mock,
                                      self._cancel)
            self._thread = threading.Thread(target=self._main, args=(run_id, kind, checkpoint),
                                            name="dms-sync", daemon=True)
            self._thread.start()
            return self.current_run() or {}

    def _main(self, run_id: str, kind: str, checkpoint: dict[str, Any] | None) -> None:
        engine = self._engine
        assert engine is not None
        repo = engine.repo
        try:
            asyncio.run(self._run_and_close(engine, run_id, kind, checkpoint))
            repo.finish_run(run_id, "succeeded", self.clock(), clear_checkpoint=True)
        except SyncCancelled:
            self._persist_progress(engine, run_id)
            repo.finish_run(run_id, "cancelled", self.clock(), "Cancelled by the user.")
            log_event(log, "sync_cancelled", run_id=run_id)
        except AdapterError as exc:
            self._persist_progress(engine, run_id)
            repo.finish_run(run_id, "failed", self.clock(), str(exc)[:300])
            log_event(log, "sync_failed", logging.WARNING, run_id=run_id,
                      error_type=type(exc).__name__)
        except Exception as exc:
            try:
                self._persist_progress(engine, run_id)
                repo.finish_run(run_id, "failed", self.clock(),
                                f"Unexpected error ({type(exc).__name__}). See the log.")
            except Exception:  # noqa: S110 - DB may have been wiped/closed
                pass
            log_event(log, "sync_failed", logging.ERROR, run_id=run_id,
                      error_type=type(exc).__name__)
        finally:
            if self.on_finished:
                try:
                    self.on_finished()
                except Exception:  # noqa: S110
                    pass

    async def _run_and_close(self, engine: SyncEngine, run_id: str, kind: str,
                             checkpoint: dict[str, Any] | None) -> None:
        try:
            await engine.run(run_id, kind, checkpoint)
        finally:
            await self.adapter.aclose()  # HTTP clients are per event loop

    @staticmethod
    def _persist_progress(engine: SyncEngine, run_id: str) -> None:
        p = engine.progress
        if p is not None:
            engine.repo.update_run(run_id, workspaces_done=p.workspaces_done,
                                   workspaces_total=p.workspaces_total,
                                   documents_seen=p.documents_seen)

    def cancel(self) -> None:
        with self._lock:
            if self.state == "idle":
                raise SyncNotRunningError()
            self._cancel.set()

    def wait(self, timeout: float | None = None) -> bool:
        t = self._thread
        if t is not None:
            t.join(timeout)
            return not t.is_alive()
        return True

    def current_run(self) -> dict[str, Any] | None:
        if self.state == "idle" or self._run_id is None:
            return None
        row = self.repo_provider().get_run(self._run_id)
        run = _run_dict(row)
        p = self._engine.progress if self._engine else None
        if run is not None and p is not None and p.run_id == self._run_id:
            run.update(workspaces_done=p.workspaces_done, workspaces_total=p.workspaces_total,
                       documents_seen=p.documents_seen)
        if run is not None:
            run["status"] = "running"
        return run

    def status(self) -> dict[str, Any]:
        state = self.state
        current = self.current_run() if state != "idle" else None
        last = _run_dict(self.repo_provider().last_finished_run())
        return {"state": state, "current": current, "last": last}
