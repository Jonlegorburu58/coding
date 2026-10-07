"""Data access for the sync engine, the controls engine and the analytics layer."""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from dms_analytics.adapters.base import RawDocument
from dms_analytics.controls.engine import BASIS, ControlOutcome, DocFacts, MatterFacts
from dms_analytics.controls.rules import MappedMatter
from dms_analytics.store.db import Database

MATTER_COLS: list[tuple[str, str]] = [
    ("id", "TEXT"), ("library_id", "TEXT"), ("client_code", "TEXT"), ("client_name", "TEXT"),
    ("matter_code", "TEXT"), ("matter_name", "TEXT"), ("practice_area", "TEXT"),
    ("partner_id", "TEXT"), ("fee_earner_id", "TEXT"), ("office", "TEXT"),
    ("matter_type", "TEXT"), ("status", "TEXT"), ("opened_at", "TIMESTAMP"),
    ("closed_at", "TIMESTAMP"), ("key_date", "DATE"), ("synced_at", "TIMESTAMP"),
]
DOC_COLS: list[tuple[str, str]] = [
    ("id", "TEXT"), ("matter_id", "TEXT"), ("folder_path", "TEXT"), ("name", "TEXT"),
    ("doc_class", "TEXT"), ("doc_subclass", "TEXT"), ("canonical_type", "TEXT"),
    ("author_id", "TEXT"), ("created_at", "TIMESTAMP"), ("edited_at", "TIMESTAMP"),
    ("version", "INTEGER"), ("size_bytes", "BIGINT"), ("synced_at", "TIMESTAMP"),
]
RESULT_COLS: list[tuple[str, str]] = [
    ("matter_id", "TEXT"), ("control_id", "TEXT"), ("status", "TEXT"), ("due_at", "TIMESTAMP"),
    ("evidence_at", "TIMESTAMP"), ("days_late", "INTEGER"), ("evidence_doc_ids", "TEXT[]"),
    ("basis", "TEXT"), ("computed_at", "TIMESTAMP"), ("explanation", "TEXT"),
]


@dataclass
class Person:
    id: str
    display_name: str
    office: str | None
    is_fee_earner: bool


class Repo:
    def __init__(self, db: Database) -> None:
        self.db = db

    # ------------------------------------------------------------ settings

    def get_setting(self, key: str) -> str | None:
        row = self.db.fetchone("SELECT value FROM setting WHERE key = ?", [key])
        return None if row is None else row[0]

    def set_setting(self, key: str, value: str) -> None:
        self.db.execute("INSERT INTO setting VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET "
                        "value = excluded.value", [key, value])

    def get_int_setting(self, key: str, default: int) -> int:
        v = self.get_setting(key)
        try:
            return int(v) if v is not None else default
        except ValueError:
            return default

    # ------------------------------------------------------------ library

    def upsert_library(self, lib_id: str, name: str) -> None:
        self.db.execute("INSERT INTO library (id, name) VALUES (?, ?) ON CONFLICT (id) DO "
                        "UPDATE SET name = excluded.name", [lib_id, name])

    def get_library(self, lib_id: str) -> dict[str, Any] | None:
        rows = self.db.fetch_dicts("SELECT * FROM library WHERE id = ?", [lib_id])
        return rows[0] if rows else None

    def update_library(self, lib_id: str, *, watermark: datetime | None,
                       full: bool, reconcile: bool, now: datetime) -> None:
        self.db.execute(
            "UPDATE library SET watermark = greatest(coalesce(watermark, ?::TIMESTAMP), "
            "coalesce(?::TIMESTAMP, watermark)), "
            "last_full_sync = CASE WHEN ? THEN ?::TIMESTAMP ELSE last_full_sync END, "
            "last_reconcile = CASE WHEN ? THEN ?::TIMESTAMP ELSE last_reconcile END "
            "WHERE id = ?", [watermark, watermark, full, now, reconcile, now, lib_id])

    def libraries(self) -> list[dict[str, Any]]:
        return self.db.fetch_dicts("SELECT * FROM library ORDER BY id")

    # ------------------------------------------------------------ people/matters

    def upsert_persons(self, people: Iterable[Person]) -> None:
        rows = {p.id: p for p in people}
        if not rows:
            return
        # is_fee_earner is sticky: once seen as a fee earner, stays one
        self.db.bulk_insert(
            "person", [("id", "TEXT"), ("display_name", "TEXT"), ("office", "TEXT"),
                       ("is_fee_earner", "BOOLEAN")],
            [(p.id, p.display_name, p.office, p.is_fee_earner) for p in rows.values()],
            conflict=["id"],
            set_clause="display_name = excluded.display_name, "
                       "office = coalesce(excluded.office, person.office), "
                       "is_fee_earner = person.is_fee_earner OR excluded.is_fee_earner")

    def upsert_matters(self, matters: Sequence[MappedMatter], synced_at: datetime) -> None:
        self.db.bulk_insert("matter", MATTER_COLS, [
            (m.id, m.library_id, m.client_code, m.client_name, m.matter_code, m.matter_name,
             m.practice_area, m.partner_id, m.fee_earner_id, m.office, m.matter_type, m.status,
             m.opened_at, m.closed_at, m.key_date, synced_at) for m in matters
        ], conflict=["id"])

    def touch_matters(self, ids: Sequence[str], synced_at: datetime) -> None:
        if ids:
            self.db.execute("UPDATE matter SET synced_at = ? WHERE list_contains(?, id)",
                            [synced_at, list(ids)])

    def matter_ids(self, library_id: str | None = None) -> set[str]:
        if library_id is None:
            rows = self.db.fetchall("SELECT id FROM matter")
        else:
            rows = self.db.fetchall("SELECT id FROM matter WHERE library_id = ?", [library_id])
        return {r[0] for r in rows}

    def delete_matters(self, ids: Iterable[str]) -> int:
        id_list = list(ids)
        if not id_list:
            return 0
        with self.db.transaction() as c:
            for table, col in (("control_result", "matter_id"), ("document", "matter_id"),
                               ("matter", "id")):
                c.execute(f"DELETE FROM {table} WHERE list_contains(?, {col})",  # noqa: S608
                          [id_list])
        return len(id_list)

    # ------------------------------------------------------------ documents

    def upsert_documents(self, docs: Sequence[RawDocument], canonical: Sequence[str | None],
                         synced_at: datetime) -> None:
        self.db.bulk_insert("document", DOC_COLS, [
            (d.id, d.workspace_id, d.folder_path, d.name, d.doc_class, d.doc_subclass, ct,
             d.author_id, d.created_at, d.edited_at, d.version, d.size_bytes, synced_at)
            for d, ct in zip(docs, canonical, strict=True)
        ], conflict=["id"])

    def delete_documents_not_in(self, matter_id: str, keep_ids: Sequence[str]) -> int:
        row = self.db.fetchone(
            "SELECT count(*) FROM document WHERE matter_id = ? AND NOT list_contains(?, id)",
            [matter_id, list(keep_ids)])
        n = int(row[0]) if row else 0
        if n:
            self.db.execute("DELETE FROM document WHERE matter_id = ? AND NOT list_contains(?, id)",
                            [matter_id, list(keep_ids)])
        return n

    def refresh_rollups(self) -> None:
        self.db.execute(
            "UPDATE matter SET doc_count = coalesce(s.n, 0), last_activity_at = s.last "
            "FROM (SELECT m.id AS mid, count(d.id) AS n, max(d.edited_at) AS last FROM matter m "
            "LEFT JOIN document d ON d.matter_id = m.id GROUP BY m.id) s WHERE matter.id = s.mid "
            "AND (matter.doc_count IS DISTINCT FROM coalesce(s.n, 0) OR "
            "matter.last_activity_at IS DISTINCT FROM s.last)")

    def max_edited_at(self, library_id: str) -> datetime | None:
        row = self.db.fetchone(
            "SELECT max(d.edited_at) FROM document d JOIN matter m ON m.id = d.matter_id "
            "WHERE m.library_id = ?", [library_id])
        return row[0] if row else None

    def recompute_canonical_types(self, mapper: Any) -> int:
        rows = self.db.fetchall("SELECT id, doc_class, doc_subclass, name, folder_path, "
                                "canonical_type FROM document")
        changes = []
        for doc_id, cls, sub, name, folder, current in rows:
            new = mapper.config.canonical_type(cls, sub, name or "", folder or "")
            if new != current:
                changes.append((doc_id, new))
        if changes:
            with self.db.lock:
                self.db.execute("CREATE OR REPLACE TEMP TABLE ct_update (id TEXT, ct TEXT)")
                self.db.bulk_insert("temp.ct_update", [("id", "TEXT"), ("ct", "TEXT")], changes)
                self.db.execute("UPDATE document SET canonical_type = u.ct FROM temp.ct_update u "
                                "WHERE document.id = u.id")
                self.db.execute("DROP TABLE temp.ct_update")
        return len(changes)

    # ------------------------------------------------------------ evaluation input

    def load_facts(self) -> tuple[list[MatterFacts], dict[str, list[DocFacts]]]:
        mrows = self.db.fetchall("SELECT id, status, matter_type, opened_at, closed_at, key_date "
                                 "FROM matter ORDER BY id")
        matters = [MatterFacts(*r) for r in mrows]
        drows = self.db.fetchall("SELECT matter_id, id, name, doc_class, canonical_type, "
                                 "created_at, edited_at FROM document ORDER BY matter_id, "
                                 "created_at, id")
        docs: dict[str, list[DocFacts]] = {}
        for mid, *rest in drows:
            docs.setdefault(mid, []).append(DocFacts(*rest))
        return matters, docs

    def replace_control_results(self, results: dict[str, list[ControlOutcome]],
                                computed_at: datetime) -> None:
        rows = [
            (mid, o.control_id, o.status, o.due_at, o.evidence_at, o.days_late,
             o.evidence_doc_ids, BASIS, computed_at, o.explanation)
            for mid, outcomes in results.items() for o in outcomes
        ]
        with self.db.transaction() as c:
            c.execute("DELETE FROM control_result")
            self.db.bulk_insert("control_result", RESULT_COLS, rows)

    def insert_snapshot(self, taken_at: datetime,
                        rows: Sequence[tuple[str, int, int, float | None]]) -> None:
        self.db.bulk_insert(
            "portfolio_snapshot",
            [("taken_at", "TIMESTAMP"), ("control_id", "TEXT"), ("applicable", "INTEGER"),
             ("passing", "INTEGER"), ("readiness", "DOUBLE")],
            [(taken_at, cid, a, p, r) for cid, a, p, r in rows],
            conflict=["taken_at", "control_id"])

    def snapshot_count(self) -> int:
        row = self.db.fetchone("SELECT count(*) FROM portfolio_snapshot")
        return int(row[0]) if row else 0

    # ------------------------------------------------------------ sync runs

    def create_run(self, kind: str, started_at: datetime,
                   checkpoint: dict[str, Any] | None = None) -> str:
        run_id = f"run_{uuid.uuid4().hex[:12]}"
        self.db.execute(
            "INSERT INTO sync_run (id, kind, started_at, status, workspaces_done, "
            "documents_seen, checkpoint) VALUES (?, ?, ?, 'running', 0, 0, ?)",
            [run_id, kind, started_at, json.dumps(checkpoint or {})])
        return run_id

    def update_run(self, run_id: str, *, workspaces_done: int, workspaces_total: int | None,
                   documents_seen: int, checkpoint: dict[str, Any] | None = None) -> None:
        if checkpoint is None:
            self.db.execute("UPDATE sync_run SET workspaces_done = ?, workspaces_total = ?, "
                            "documents_seen = ? WHERE id = ?",
                            [workspaces_done, workspaces_total, documents_seen, run_id])
        else:
            self.db.execute("UPDATE sync_run SET workspaces_done = ?, workspaces_total = ?, "
                            "documents_seen = ?, checkpoint = ? WHERE id = ?",
                            [workspaces_done, workspaces_total, documents_seen,
                             json.dumps(checkpoint), run_id])

    def finish_run(self, run_id: str, status: str, finished_at: datetime,
                   error: str | None = None, clear_checkpoint: bool = False) -> None:
        if clear_checkpoint:
            self.db.execute("UPDATE sync_run SET status = ?, finished_at = ?, error = ?, "
                            "checkpoint = NULL WHERE id = ?",
                            [status, finished_at, error, run_id])
        else:
            self.db.execute("UPDATE sync_run SET status = ?, finished_at = ?, error = ? "
                            "WHERE id = ?", [status, finished_at, error, run_id])

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        rows = self.db.fetch_dicts("SELECT * FROM sync_run WHERE id = ?", [run_id])
        return rows[0] if rows else None

    def last_finished_run(self) -> dict[str, Any] | None:
        rows = self.db.fetch_dicts("SELECT * FROM sync_run WHERE status <> 'running' "
                                   "ORDER BY started_at DESC, rowid DESC LIMIT 1")
        return rows[0] if rows else None

    def last_successful_sync_at(self) -> datetime | None:
        row = self.db.fetchone("SELECT max(finished_at) FROM sync_run WHERE status = 'succeeded'")
        return row[0] if row else None

    def mark_interrupted_runs(self, now: datetime) -> int:
        """At startup: a 'running' row means the process died mid-sync."""
        row = self.db.fetchone("SELECT count(*) FROM sync_run WHERE status = 'running'")
        n = int(row[0]) if row else 0
        if n:
            self.db.execute("UPDATE sync_run SET status = 'failed', finished_at = ?, error = "
                            "'Interrupted (the app stopped during the sync). It will resume.' "
                            "WHERE status = 'running'", [now])
        return n

    def resumable_run(self) -> dict[str, Any] | None:
        """The latest run, if it failed or was cancelled with a checkpoint to resume from."""
        rows = self.db.fetch_dicts("SELECT * FROM sync_run "
                                   "ORDER BY started_at DESC, rowid DESC LIMIT 1")
        if not rows:
            return None
        run = rows[0]
        if run["status"] in ("failed", "cancelled") and run["checkpoint"]:
            cp = json.loads(run["checkpoint"]) if isinstance(run["checkpoint"], str) else None
            if cp and cp.get("done"):
                run["checkpoint"] = cp
                return run
        return None

    def successful_runs_since_reconcile(self) -> int | None:
        """Successful runs after the latest successful full/reconcile run
        (insertion order, not timestamps). None if there has never been one."""
        row = self.db.fetchone("SELECT max(rowid) FROM sync_run WHERE status = 'succeeded' "
                               "AND kind IN ('full', 'reconcile')")
        if row is None or row[0] is None:
            return None
        n = self.db.fetchone("SELECT count(*) FROM sync_run WHERE status = 'succeeded' "
                             "AND rowid > ?", [row[0]])
        return int(n[0]) if n else 0

    # ------------------------------------------------------------ coverage / retention

    def coverage(self) -> tuple[int, int, int]:
        row = self.db.fetchone("SELECT (SELECT count(*) FROM library), "
                               "(SELECT count(*) FROM matter), (SELECT count(*) FROM document)")
        assert row is not None
        return int(row[0]), int(row[1]), int(row[2])

    def purge_retention(self, retention_days: int, now: datetime) -> int:
        cutoff = now - timedelta(days=retention_days)
        ids = [r[0] for r in self.db.fetchall("SELECT id FROM matter WHERE synced_at < ?",
                                              [cutoff])]
        return self.delete_matters(ids)
