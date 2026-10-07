"""Application settings and filesystem locations.

Windows (the target): data in %LOCALAPPDATA%\\BWS\\DmsAnalytics, config in
%APPDATA%\\BWS\\DmsAnalytics. Elsewhere (developer machines only) the XDG
directories are used. Every location can be overridden with an environment
variable so that tests can run in a temporary directory.
"""

from __future__ import annotations

import os
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

APP_VERSION = "1.0.0"
DEFAULT_PORT = 8765
LOOPBACK_HOST = "127.0.0.1"
KEYRING_SERVICE = "bws-dms-analytics"

Mode = Literal["mock", "live"]


class ConfigError(Exception):
    """Raised for an invalid configuration. The message is safe to show the user."""


def _env_path(name: str) -> Path | None:
    value = os.environ.get(name)
    return Path(value) if value else None


def default_data_dir() -> Path:
    override = _env_path("DMS_ANALYTICS_DATA_DIR")
    if override:
        return override
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "BWS" / "DmsAnalytics"
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "bws-dms-analytics"


def default_config_dir() -> Path:
    override = _env_path("DMS_ANALYTICS_CONFIG_DIR")
    if override:
        return override
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "BWS" / "DmsAnalytics"
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "bws-dms-analytics"


@dataclass(frozen=True)
class IManageSettings:
    """Live-mode settings. Every value is a placeholder until IT supplies it (V1-V3)."""

    base_url: str = "<IMANAGE_BASE_URL>"
    auth_base_url: str = ""  # defaults to base_url
    customer_id: str = "<CUSTOMER_ID>"
    library_ids: tuple[str, ...] = ()
    client_id: str = "<CLIENT_ID>"
    scopes: tuple[str, ...] = ("<READ_ONLY_SCOPE>",)
    auth_flow: Literal["pkce", "device_code"] = "pkce"
    max_concurrency: int = 4
    page_size: int = 500

    @property
    def effective_auth_base_url(self) -> str:
        return self.auth_base_url or self.base_url

    def placeholders(self) -> list[str]:
        """Names of settings that still hold a `<PLACEHOLDER>` value."""
        bad: list[str] = []
        for name in ("base_url", "customer_id", "client_id"):
            if str(getattr(self, name)).startswith("<"):
                bad.append(name)
        if any(s.startswith("<") for s in self.scopes):
            bad.append("scopes")
        return bad


@dataclass(frozen=True)
class Settings:
    mode: Mode = "mock"
    dev: bool = False
    host: str = LOOPBACK_HOST
    port: int = DEFAULT_PORT
    data_dir: Path = field(default_factory=default_data_dir)
    config_dir: Path = field(default_factory=default_config_dir)
    controls_file: Path | None = None
    mock_seed: int = 42
    imanage: IManageSettings = field(default_factory=IManageSettings)
    open_browser: bool = True

    @property
    def db_path(self) -> Path:
        return self.data_dir / "dms-analytics.duckdb"

    @property
    def checkpoint_dir(self) -> Path:
        return self.data_dir / "checkpoints"

    @property
    def resolved_controls_file(self) -> Path:
        return self.controls_file or (self.config_dir / "controls.yaml")


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def load_settings(env: dict[str, str] | None = None) -> Settings:
    """Load `config.toml` (if present) and apply environment overrides."""
    env = dict(os.environ) if env is None else env
    config_dir = Path(env["DMS_ANALYTICS_CONFIG_DIR"]) if env.get(
        "DMS_ANALYTICS_CONFIG_DIR") else default_config_dir()
    data_dir = Path(env["DMS_ANALYTICS_DATA_DIR"]) if env.get(
        "DMS_ANALYTICS_DATA_DIR") else default_data_dir()

    raw: dict[str, Any] = {}
    cfg_file = config_dir / "config.toml"
    if cfg_file.exists():
        try:
            raw = tomllib.loads(cfg_file.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as exc:
            raise ConfigError(f"config.toml is not valid TOML: {exc}") from exc

    app = raw.get("app", {})
    im = raw.get("imanage", {})
    mode = env.get("DMS_ANALYTICS_MODE") or app.get("mode", "mock")
    if mode not in ("mock", "live"):
        raise ConfigError("mode must be 'mock' or 'live'")
    port = int(env.get("DMS_ANALYTICS_PORT") or app.get("port", DEFAULT_PORT))
    if not 1024 <= port <= 65535:
        raise ConfigError("port must be between 1024 and 65535")
    controls = env.get("DMS_ANALYTICS_CONTROLS_FILE") or app.get("controls_file")

    flow = im.get("auth_flow", "pkce")
    if flow not in ("pkce", "device_code"):
        raise ConfigError("imanage.auth_flow must be 'pkce' or 'device_code'")
    imanage = IManageSettings(
        base_url=str(im.get("base_url", "<IMANAGE_BASE_URL>")).rstrip("/"),
        auth_base_url=str(im.get("auth_base_url", "")).rstrip("/"),
        customer_id=str(im.get("customer_id", "<CUSTOMER_ID>")),
        library_ids=tuple(str(x) for x in im.get("library_ids", [])),
        client_id=str(im.get("client_id", "<CLIENT_ID>")),
        scopes=tuple(str(x) for x in im.get("scopes", ["<READ_ONLY_SCOPE>"])),
        auth_flow=flow,
        max_concurrency=max(1, min(8, int(im.get("max_concurrency", 4)))),
        page_size=max(1, min(500, int(im.get("page_size", 500)))),
    )
    return Settings(
        mode="live" if mode == "live" else "mock",
        dev=_truthy(env.get("DMS_ANALYTICS_DEV")),
        port=port,
        data_dir=data_dir,
        config_dir=config_dir,
        controls_file=Path(controls) if controls else None,
        mock_seed=int(env.get("DMS_ANALYTICS_MOCK_SEED") or app.get("mock_seed", 42)),
        imanage=imanage,
        open_browser=not _truthy(env.get("DMS_ANALYTICS_NO_BROWSER")),
    )
