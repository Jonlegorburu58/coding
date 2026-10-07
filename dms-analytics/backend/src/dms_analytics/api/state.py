"""Process-wide application state shared by the routes."""

from __future__ import annotations

import logging
import shutil
import threading
from collections.abc import Callable
from datetime import UTC, datetime

from dms_analytics.adapters.base import DmsAdapter
from dms_analytics.adapters.token_store import DB_KEY_ENTRY, SecretBackend, SecretStore
from dms_analytics.analytics import Frame, load_frame
from dms_analytics.config import Settings
from dms_analytics.controls.rules import ControlsConfig, FieldMapper, load_controls
from dms_analytics.logging import log_event
from dms_analytics.security import LaunchCodes, Sessions
from dms_analytics.store.db import Database, delete_db_files, get_or_create_key
from dms_analytics.store.repo import Repo
from dms_analytics.sync.engine import SyncManager, evaluate_all

log = logging.getLogger(__name__)

DEFAULT_RETENTION_DAYS = 30
DEFAULT_SAMPLE_PER_FE = 2


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None, microsecond=0)


class AppState:
    def __init__(self, settings: Settings, secret_backend: SecretBackend, adapter: DmsAdapter,
                 clock: Callable[[], datetime] = utcnow) -> None:
        self.settings = settings
        self.secrets = SecretStore(secret_backend)
        self.adapter = adapter
        self.clock = clock
        self.launch_codes = LaunchCodes(dev=settings.dev and settings.mode == "mock")
        self.sessions = Sessions()
        self._lock = threading.RLock()
        self.data_version = 0
        self._frame: tuple[int, Frame] | None = None
        self.controls: ControlsConfig = load_controls(settings.resolved_controls_file)
        self._controls_mtime = self._mtime()
        self.db: Database | None = None
        self.repo: Repo = self._open_store()
        self.sync = SyncManager(lambda: self.repo, adapter, self.controls_for_sync, clock,
                                is_mock=settings.mode == "mock", on_finished=self.bump)
        self.startup_maintenance()

    # ------------------------------------------------------------ store

    def _open_store(self) -> Repo:
        key = get_or_create_key(self.secrets, self.settings.db_path)
        db = Database(self.settings.db_path, key)
        db.open()
        self.db = db
        return Repo(db)

    def startup_maintenance(self) -> None:
        now = self.clock()
        interrupted = self.repo.mark_interrupted_runs(now)
        purged = self.repo.purge_retention(self.retention_days, now)
        self._apply_controls_digest()
        if self.repo.coverage()[1] > 0:
            evaluate_all(self.repo, self.controls, now)
        self.bump()
        log_event(log, "startup_maintenance", count=interrupted, purged=purged)

    def _apply_controls_digest(self) -> None:
        if self.repo.get_setting("controls_digest") != self.controls.digest:
            self.repo.recompute_canonical_types(FieldMapper(self.controls))
            self.repo.set_setting("controls_digest", self.controls.digest)

    def _mtime(self) -> float | None:
        p = self.settings.resolved_controls_file
        try:
            return p.stat().st_mtime if p.exists() else None
        except OSError:
            return None

    def controls_for_sync(self) -> ControlsConfig:
        """Reload controls.yaml if it changed on disk (raises if now invalid)."""
        with self._lock:
            mtime = self._mtime()
            if mtime != self._controls_mtime:
                self.controls = load_controls(self.settings.resolved_controls_file)
                self._controls_mtime = mtime
                self._apply_controls_digest()
                log_event(log, "controls_reloaded")
            return self.controls

    # ------------------------------------------------------------ settings

    @property
    def retention_days(self) -> int:
        return self.repo.get_int_setting("retention_days", DEFAULT_RETENTION_DAYS)

    @property
    def sample_per_fee_earner(self) -> int:
        return self.repo.get_int_setting("sample_per_fee_earner", DEFAULT_SAMPLE_PER_FE)

    # ------------------------------------------------------------ analytics cache

    def bump(self) -> None:
        with self._lock:
            self.data_version += 1

    def frame(self) -> Frame:
        with self._lock:
            version = self.data_version
            if self._frame is None or self._frame[0] != version:
                self._frame = (version, load_frame(self.repo, self.controls))
            return self._frame[1]

    # ------------------------------------------------------------ wipe

    def wipe(self) -> None:
        """Delete the database, checkpoints and the DB key; start empty."""
        # Do not hold self._lock while waiting: the sync thread takes it in bump().
        self.sync.blocked = True
        try:
            if self.sync.state != "idle":
                try:
                    self.sync.cancel()
                except Exception:  # noqa: S110 - finished in between
                    pass
                self.sync.wait(60)
            with self._lock:
                self._wipe_files()
        finally:
            self.sync.blocked = False

    def _wipe_files(self) -> None:
        if self.db is not None:
            self.db.close()
        delete_db_files(self.settings.db_path)
        shutil.rmtree(self.settings.checkpoint_dir, ignore_errors=True)
        self.secrets.delete(DB_KEY_ENTRY)
        self.repo = self._open_store()
        self.repo.set_setting("controls_digest", self.controls.digest)
        self._frame = None
        self.bump()
        log_event(log, "local_data_wiped")

    def close(self) -> None:
        if self.sync.state != "idle":
            try:
                self.sync.cancel()
            except Exception:  # noqa: S110
                pass
            self.sync.wait(30)
        if self.db is not None:
            self.db.close()
