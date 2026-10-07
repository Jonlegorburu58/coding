"""Config loading, paths, launcher guards."""

from __future__ import annotations

from pathlib import Path

import pytest

from dms_analytics import __main__ as launcher
from dms_analytics.adapters.token_store import DevFileBackend
from dms_analytics.config import ConfigError, Settings, load_settings

BACKEND = Path(__file__).resolve().parents[1]


def test_defaults_are_mock_and_loopback(tmp_path: Path) -> None:
    s = load_settings({"DMS_ANALYTICS_CONFIG_DIR": str(tmp_path / "c"),
                       "DMS_ANALYTICS_DATA_DIR": str(tmp_path / "d")})
    assert s.mode == "mock" and s.host == "127.0.0.1" and s.port == 8765 and not s.dev
    assert s.db_path == tmp_path / "d" / "dms-analytics.duckdb"
    assert s.resolved_controls_file == tmp_path / "c" / "controls.yaml"


def test_xdg_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DMS_ANALYTICS_DATA_DIR", raising=False)
    monkeypatch.delenv("DMS_ANALYTICS_CONFIG_DIR", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xd"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xc"))
    s = load_settings({})
    assert s.data_dir == tmp_path / "xd" / "bws-dms-analytics"
    assert s.config_dir == tmp_path / "xc" / "bws-dms-analytics"


def test_example_config_parses_and_has_only_placeholders(tmp_path: Path) -> None:
    text = (BACKEND / "config.example.toml").read_text(encoding="utf-8")
    (tmp_path / "config.toml").write_text(text, encoding="utf-8")
    s = load_settings({"DMS_ANALYTICS_CONFIG_DIR": str(tmp_path)})
    assert s.mode == "mock"
    assert set(s.imanage.placeholders()) == {"base_url", "customer_id", "client_id", "scopes"}


def test_env_overrides_and_validation(tmp_path: Path) -> None:
    env = {"DMS_ANALYTICS_CONFIG_DIR": str(tmp_path), "DMS_ANALYTICS_MODE": "live",
           "DMS_ANALYTICS_DEV": "1", "DMS_ANALYTICS_PORT": "9001"}
    s = load_settings(env)
    assert s.mode == "live" and s.dev and s.port == 9001
    with pytest.raises(ConfigError):
        load_settings({**env, "DMS_ANALYTICS_MODE": "prod"})
    with pytest.raises(ConfigError):
        load_settings({**env, "DMS_ANALYTICS_PORT": "80"})
    (tmp_path / "config.toml").write_text("[app\nmode=", encoding="utf-8")
    with pytest.raises(ConfigError):
        load_settings({"DMS_ANALYTICS_CONFIG_DIR": str(tmp_path)})


def test_launcher_refuses_dev_in_live_mode(monkeypatch: pytest.MonkeyPatch,
                                           tmp_path: Path) -> None:
    monkeypatch.setenv("DMS_ANALYTICS_MODE", "live")
    monkeypatch.setenv("DMS_ANALYTICS_DEV", "1")
    monkeypatch.setenv("DMS_ANALYTICS_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("DMS_ANALYTICS_DATA_DIR", str(tmp_path))
    assert launcher.main() == 2


def test_live_mode_with_placeholders_refuses_to_start(tmp_path: Path) -> None:
    s = Settings(mode="live", data_dir=tmp_path, config_dir=tmp_path)
    with pytest.raises(ConfigError, match="not configured"):
        launcher.make_adapter(s, DevFileBackend(tmp_path / "x.json"))


def test_live_mode_requires_real_keychain(monkeypatch: pytest.MonkeyPatch,
                                          tmp_path: Path) -> None:
    def broken() -> None:
        raise RuntimeError("no keychain")
    monkeypatch.setattr(launcher, "system_backend", broken)
    with pytest.raises(ConfigError):
        launcher.choose_secret_backend(Settings(mode="live", data_dir=tmp_path))
    dev = launcher.choose_secret_backend(Settings(mode="mock", data_dir=tmp_path))
    assert isinstance(dev, DevFileBackend)


def test_dev_file_backend_is_private(tmp_path: Path) -> None:
    b = DevFileBackend(tmp_path / "s.json")
    b.set_password("svc", "k", "v")
    assert b.get_password("svc", "k") == "v"
    assert (tmp_path / "s.json").stat().st_mode & 0o077 == 0
    b.delete_password("svc", "k")
    assert b.get_password("svc", "k") is None
