"""Store: migrations, encryption at rest, key handling, retention."""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta
from pathlib import Path

import duckdb
import pytest

from dms_analytics.adapters.token_store import DB_KEY_ENTRY, MemoryBackend, SecretStore
from dms_analytics.controls.rules import MappedMatter
from dms_analytics.store.db import Database, StoreError, get_or_create_key, migrations
from dms_analytics.store.repo import Repo

NOW = datetime(2026, 10, 7, 12)


def open_db(path: Path, key: str | None = None) -> Database:
    db = Database(path, key or secrets.token_hex(32))
    db.open()
    return db


def test_migrations_apply_once(tmp_path: Path) -> None:
    db = open_db(tmp_path / "a.duckdb")
    tables = {r[0] for r in db.fetchall("SELECT table_name FROM information_schema.tables "
                                        "WHERE table_catalog = 'store'")}
    assert {"library", "person", "matter", "document", "control_result", "portfolio_snapshot",
            "sync_run", "setting", "schema_migrations"} <= tables
    db.migrate()
    assert db.fetchone("SELECT count(*) FROM schema_migrations") == (len(migrations()),)
    db.close()


def test_database_file_is_encrypted(tmp_path: Path) -> None:
    path = tmp_path / "enc.duckdb"
    key = secrets.token_hex(32)
    db = open_db(path, key)
    Repo(db).set_setting("probe", "Example Holdings Ltd (fictional)")
    db.close()
    raw = path.read_bytes()
    assert b"Example Holdings" not in raw
    with pytest.raises(duckdb.Error):
        duckdb.connect(":memory:").execute(f"ATTACH '{path}' AS s")
    with pytest.raises(duckdb.Error):
        duckdb.connect(":memory:").execute(
            f"ATTACH '{path}' AS s (ENCRYPTION_KEY '{secrets.token_hex(32)}')")
    db2 = open_db(path, key)
    assert Repo(db2).get_setting("probe") == "Example Holdings Ltd (fictional)"
    db2.close()


def test_key_must_be_hex(tmp_path: Path) -> None:
    with pytest.raises(StoreError):
        Database(tmp_path / "x.duckdb", "abc'; DROP")


def test_key_is_created_once_and_kept_in_keychain(tmp_path: Path) -> None:
    store = SecretStore(MemoryBackend())
    k1 = get_or_create_key(store, tmp_path / "db.duckdb")
    assert store.get(DB_KEY_ENTRY) == k1
    assert get_or_create_key(store, tmp_path / "db.duckdb") == k1


def test_lost_key_resets_unreadable_database(tmp_path: Path) -> None:
    store = SecretStore(MemoryBackend())
    path = tmp_path / "db.duckdb"
    db = open_db(path, get_or_create_key(store, path))
    db.close()
    store.delete(DB_KEY_ENTRY)
    new_key = get_or_create_key(store, path)
    assert not path.exists()
    open_db(path, new_key).close()


def _matter(mid: str) -> MappedMatter:
    return MappedMatter(mid, "LIB", "C1", "Client (fictional)", "C1-1", "Matter (fictional)",
                        None, None, None, None, None, None, None, "open", NOW, None, None)


def test_retention_purge(tmp_path: Path) -> None:
    db = open_db(tmp_path / "r.duckdb")
    repo = Repo(db)
    repo.upsert_matters([_matter("old")], NOW - timedelta(days=40))
    repo.upsert_matters([_matter("fresh")], NOW - timedelta(days=2))
    assert repo.purge_retention(30, NOW) == 1
    assert repo.matter_ids() == {"fresh"}
    db.close()


def test_bulk_insert_handles_odd_text(tmp_path: Path) -> None:
    db = open_db(tmp_path / "t.duckdb")
    odd = ["<script>alert('x')</script>", "'; DROP TABLE matter;--", "Zero​width",
           "RTL ‮abc", "emoji 📁", 'quote " back\\slash', "tab\tnew\nline"]
    db.bulk_insert("setting", [("key", "TEXT"), ("value", "TEXT")],
                   [(f"k{i}", v) for i, v in enumerate(odd)])
    got = dict(db.fetchall("SELECT key, value FROM setting"))
    assert [got[f"k{i}"] for i in range(len(odd))] == odd
    db.close()


def test_sql_cannot_reach_files_or_network(tmp_path: Path) -> None:
    db = open_db(tmp_path / "x.duckdb")
    for sql in (f"SELECT * FROM read_csv('{tmp_path}/nope.csv')",
                "SELECT * FROM read_json('https://example.invalid/x.json')",
                f"COPY (SELECT 1) TO '{tmp_path}/out.csv'",
                "SET enable_external_access = true",
                "INSTALL httpfs"):
        with pytest.raises(duckdb.Error):
            db.execute(sql)
    assert not (tmp_path / "out.csv").exists()
    db.close()
