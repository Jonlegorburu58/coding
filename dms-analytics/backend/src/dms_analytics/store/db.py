"""DuckDB store, encrypted at rest (DECISIONS D4).

The database file is ATTACHed with ``ENCRYPTION_KEY``; the 256-bit key lives
only in the OS keychain (entry ``db-key`` under service ``bws-dms-analytics``).
All access goes through one connection guarded by a re-entrant lock: the sync
thread writes in short batches and API requests read between them.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import shutil
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import date, datetime
from importlib import resources
from pathlib import Path
from typing import Any

import duckdb

from dms_analytics.adapters.token_store import DB_KEY_ENTRY, SecretStore
from dms_analytics.logging import log_event

log = logging.getLogger(__name__)

_KEY_RE = re.compile(r"^[0-9a-f]{64}$")
_JSON_TYPES = {
    "TEXT": '"VARCHAR"', "TIMESTAMP": '"VARCHAR"', "DATE": '"VARCHAR"', "INTEGER": '"BIGINT"',
    "BIGINT": '"BIGINT"', "BOOLEAN": '"BOOLEAN"', "DOUBLE": '"DOUBLE"', "TEXT[]": '["VARCHAR"]',
}


class StoreError(Exception):
    pass


def _json_default(v: Any) -> Any:
    if isinstance(v, datetime | date):
        return v.isoformat()
    raise TypeError(type(v).__name__)


def migrations() -> list[tuple[int, str]]:
    pkg = resources.files("dms_analytics.store.migrations")
    found = []
    for entry in pkg.iterdir():
        m = re.match(r"^(\d{4})_.*\.sql$", entry.name)
        if m:
            found.append((int(m.group(1)), entry.read_text(encoding="utf-8")))
    return sorted(found)


class Database:
    def __init__(self, path: Path, key: str) -> None:
        if not _KEY_RE.match(key):
            raise StoreError("database key has an unexpected format")
        self.path = path
        self._key = key
        self.lock = threading.RLock()
        self._conn: duckdb.DuckDBPyConnection | None = None

    def open(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = duckdb.connect(":memory:")
        quoted = str(self.path).replace("'", "''")
        # key is validated hex above, so it cannot break out of the literal
        conn.execute(f"ATTACH '{quoted}' AS store (ENCRYPTION_KEY '{self._key}')")
        conn.execute("USE store")
        # No outbound calls and no file access beyond the attached store: never
        # download extensions, never read/write other files or URLs from SQL.
        conn.execute("SET autoinstall_known_extensions = false")
        conn.execute("SET autoload_known_extensions = false")
        conn.execute("SET enable_external_access = false")
        conn.execute("SET lock_configuration = true")
        self._conn = conn
        self.migrate()

    @property
    def conn(self) -> duckdb.DuckDBPyConnection:
        if self._conn is None:
            raise StoreError("database is closed")
        return self._conn

    @property
    def is_open(self) -> bool:
        return self._conn is not None

    def close(self) -> None:
        with self.lock:
            if self._conn is not None:
                try:
                    self._conn.execute("USE memory")
                    self._conn.execute("DETACH store")
                finally:
                    self._conn.close()
                    self._conn = None

    def migrate(self) -> None:
        with self.lock:
            c = self.conn
            c.execute("CREATE TABLE IF NOT EXISTS schema_migrations "
                      "(version INTEGER PRIMARY KEY, applied_at TIMESTAMP)")
            row = c.execute("SELECT coalesce(max(version), 0) FROM schema_migrations").fetchone()
            current = int(row[0]) if row else 0
            for version, sql in migrations():
                if version <= current:
                    continue
                c.execute("BEGIN")
                try:
                    c.execute(sql)
                    c.execute("INSERT INTO schema_migrations VALUES (?, now()::TIMESTAMP)",
                              [version])
                    c.execute("COMMIT")
                except Exception:
                    c.execute("ROLLBACK")
                    raise
                log_event(log, "migration_applied", migration=version)

    # ------------------------------------------------------------ helpers

    def execute(self, sql: str, params: Sequence[Any] | None = None) -> duckdb.DuckDBPyConnection:
        with self.lock:
            return self.conn.execute(sql, params or [])

    def fetchall(self, sql: str, params: Sequence[Any] | None = None) -> list[tuple[Any, ...]]:
        with self.lock:
            return self.conn.execute(sql, params or []).fetchall()

    def fetchone(self, sql: str, params: Sequence[Any] | None = None) -> tuple[Any, ...] | None:
        with self.lock:
            return self.conn.execute(sql, params or []).fetchone()

    def fetch_dicts(self, sql: str, params: Sequence[Any] | None = None) -> list[dict[str, Any]]:
        with self.lock:
            cur = self.conn.execute(sql, params or [])
            cols = [d[0] for d in cur.description or []]
            return [dict(zip(cols, row, strict=True)) for row in cur.fetchall()]

    @contextmanager
    def transaction(self) -> Iterator[duckdb.DuckDBPyConnection]:
        with self.lock:
            c = self.conn
            c.execute("BEGIN")
            try:
                yield c
            except BaseException:
                c.execute("ROLLBACK")
                raise
            c.execute("COMMIT")

    def bulk_insert(self, table: str, columns: Sequence[tuple[str, str]],
                    rows: Sequence[Sequence[Any]], conflict: Sequence[str] | None = None,
                    update: Sequence[str] | None = None, set_clause: str | None = None) -> None:
        """Fast bulk insert/upsert: rows travel as one JSON parameter.

        (DuckDB's executemany costs ~1 ms per row; this is ~50x faster.)
        """
        if not rows:
            return
        names = [c for c, _ in columns]
        struct = "{" + ",".join(f'"{n}":{_JSON_TYPES[t]}' for n, t in columns) + "}"
        select = ", ".join(f"r.{n}::{t}" for n, t in columns)
        # table/column names are code constants, never user input
        sql = (f"INSERT INTO {table} ({', '.join(names)}) SELECT {select} FROM "  # noqa: S608
               f"(SELECT unnest(from_json(?::JSON, '[{struct}]')) AS r)")
        if conflict:
            upd = update if update is not None else [n for n in names if n not in conflict]
            sets = set_clause or ", ".join(f"{n} = excluded.{n}" for n in upd)
            sql += f" ON CONFLICT ({', '.join(conflict)}) DO " + (
                f"UPDATE SET {sets}" if sets else "NOTHING")
        objs = [dict(zip(names, row, strict=True)) for row in rows]
        with self.lock:
            for i in range(0, len(objs), 2000):
                payload = json.dumps(objs[i:i + 2000], default=_json_default)
                self.conn.execute(sql, [payload])


class KeyMissingError(StoreError):
    pass


def get_or_create_key(secrets_store: SecretStore, db_path: Path) -> str:
    """Return the DB key, creating one for a new database.

    If the database file exists but its key is gone (keychain reset), the file
    is unreadable. It is only a cache of the DMS, so it is deleted and a new
    database is created (D103).
    """
    key = secrets_store.get(DB_KEY_ENTRY)
    if key and _KEY_RE.match(key):
        return key
    if db_path.exists():
        log_event(log, "db_key_missing_reset", logging.WARNING)
        delete_db_files(db_path)
    key = secrets.token_hex(32)
    secrets_store.set(DB_KEY_ENTRY, key)
    return key


def delete_db_files(db_path: Path) -> None:
    for p in (db_path, db_path.with_name(db_path.name + ".wal"),
              db_path.with_name(db_path.name + ".tmp")):
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        elif p.exists():
            p.unlink()
