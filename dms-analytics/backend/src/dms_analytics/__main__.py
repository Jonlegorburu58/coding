"""Launcher: ``python -m dms_analytics`` (or ``dms-analytics.exe``).

Starts the local API on 127.0.0.1, then opens the default browser at a
single-use launch URL. With ``DMS_ANALYTICS_DEV=1`` (mock mode only) it prints
the launch URL instead and also accepts the fixed code ``dev`` once.
"""

from __future__ import annotations

import logging
import sys
import threading
import webbrowser

from dms_analytics.adapters.base import DmsAdapter
from dms_analytics.adapters.token_store import (
    DevFileBackend,
    SecretBackend,
    SecretStore,
    SecretStoreUnavailable,
    TokenStore,
    system_backend,
)
from dms_analytics.config import KEYRING_SERVICE, ConfigError, Settings, load_settings
from dms_analytics.controls.rules import ControlsConfigError
from dms_analytics.logging import configure_logging, log_event
from dms_analytics.security import DEV_LAUNCH_CODE, assert_loopback_bind

log = logging.getLogger("dms_analytics")


def choose_secret_backend(settings: Settings) -> SecretBackend:
    try:
        backend = system_backend()
        backend.get_password(KEYRING_SERVICE, "probe")
        return backend
    except Exception as exc:
        if settings.mode == "live" or sys.platform == "win32":
            raise ConfigError("No usable OS keychain (Windows Credential Manager) was found. "
                              "Live mode requires it.") from exc
        log_event(log, "dev_file_secret_store", logging.WARNING, mode=settings.mode)
        if not isinstance(exc, SecretStoreUnavailable):
            log_event(log, "keyring_probe_failed", logging.WARNING,
                      error_type=type(exc).__name__)
        return DevFileBackend(settings.data_dir / "dev-secrets.json")


def make_adapter(settings: Settings, backend: SecretBackend) -> DmsAdapter:
    if settings.mode == "mock":
        from dms_analytics.adapters.mock import MockDmsAdapter
        return MockDmsAdapter(seed=settings.mock_seed)
    from dms_analytics.adapters.imanage import IManageAdapter
    missing = settings.imanage.placeholders()
    if missing:
        raise ConfigError("Live mode is not configured yet. Fill in these [imanage] settings "
                          f"in config.toml: {', '.join(missing)}")
    return IManageAdapter(settings.imanage, TokenStore(SecretStore(backend)),
                          redirect_uri=f"http://127.0.0.1:{settings.port}/auth/callback")


def main() -> int:
    configure_logging()
    try:
        settings = load_settings()
        if settings.dev and settings.mode == "live":
            print("Refusing to start: DMS_ANALYTICS_DEV=1 is only allowed in mock mode.",
                  file=sys.stderr)
            return 2
        assert_loopback_bind(settings.host)
        backend = choose_secret_backend(settings)
        adapter = make_adapter(settings, backend)
        from dms_analytics.api.app import create_app
        app = create_app(settings, secret_backend=backend, adapter=adapter)
    except (ConfigError, ControlsConfigError) as exc:
        print(f"Cannot start: {exc}", file=sys.stderr)
        return 2

    import uvicorn

    code = app.state.dms.launch_codes.issue()
    base = f"http://127.0.0.1:{settings.port}"
    url = f"{base}/launch?code={code}"
    log_event(log, "starting", mode=settings.mode, port=settings.port)
    if settings.dev:
        print(f"\n  DMS Analytics (mock, dev) on {base}\n"
              f"  Open: {url}\n"
              f"  or:   {base}/launch?code={DEV_LAUNCH_CODE}   (dev code, works once)\n",
              flush=True)
    if settings.open_browser and not settings.dev:
        threading.Timer(1.5, webbrowser.open, args=(url,)).start()

    uvicorn.run(app, host=settings.host, port=settings.port, access_log=False,
                log_config=None, server_header=False, proxy_headers=False)
    return 0


def dev_main() -> int:
    """``uv run dms-analytics-dev``: mock mode + dev launch code, any OS shell."""
    import os
    os.environ["DMS_ANALYTICS_DEV"] = "1"
    os.environ["DMS_ANALYTICS_MODE"] = "mock"
    return main()


if __name__ == "__main__":
    sys.exit(main())
