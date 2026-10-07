"""Secret storage: OS keychain via `keyring`, with chunking.

Windows Credential Manager limits a credential blob to 2,560 bytes, and
`keyring` stores UTF-16, so long values (refresh tokens) are split into
chunks of ``CHUNK_CHARS`` characters across several entries:

    <name>          -> "chunks:<n>"
    <name>#0..n-1   -> the pieces

The backend is injectable (``SecretBackend``) so tests use an in-memory fake
and never touch a real keychain.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any, Protocol

from dms_analytics.config import KEYRING_SERVICE

CHUNK_CHARS = 1000
_HEADER = "chunks:"


class SecretBackend(Protocol):
    def get_password(self, service: str, username: str) -> str | None: ...
    def set_password(self, service: str, username: str, password: str) -> None: ...
    def delete_password(self, service: str, username: str) -> None: ...


class SecretStoreUnavailable(Exception):
    """No usable OS keychain."""


class MemoryBackend:
    """In-memory fake keychain for tests."""

    def __init__(self) -> None:
        self.data: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, username: str) -> str | None:
        return self.data.get((service, username))

    def set_password(self, service: str, username: str, password: str) -> None:
        if len(password) > 1280:  # mimic Credential Manager's UTF-16 limit
            raise ValueError("credential too large")
        self.data[(service, username)] = password

    def delete_password(self, service: str, username: str) -> None:
        if (service, username) not in self.data:
            raise KeyError(username)
        del self.data[(service, username)]


class DevFileBackend:
    """DEVELOPMENT ONLY, mock mode only, non-Windows only.

    Used when a Linux/macOS dev box has no keyring backend. Stores secrets in a
    0600 JSON file in the data directory. Live mode refuses to use it.
    """

    def __init__(self, path: Path) -> None:
        self.path = path

    def _load(self) -> dict[str, str]:
        if not self.path.exists():
            return {}
        data: dict[str, str] = json.loads(self.path.read_text(encoding="utf-8"))
        return data

    def _save(self, data: dict[str, str]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data), encoding="utf-8")
        os.chmod(self.path, stat.S_IRUSR | stat.S_IWUSR)

    def get_password(self, service: str, username: str) -> str | None:
        return self._load().get(f"{service}/{username}")

    def set_password(self, service: str, username: str, password: str) -> None:
        data = self._load()
        data[f"{service}/{username}"] = password
        self._save(data)

    def delete_password(self, service: str, username: str) -> None:
        data = self._load()
        if f"{service}/{username}" not in data:
            raise KeyError(username)
        del data[f"{service}/{username}"]
        self._save(data)


def system_backend() -> SecretBackend:
    """The real OS keychain. Raises if only the 'fail' backend is available."""
    import keyring
    from keyring.backends import fail

    backend: Any = keyring.get_keyring()
    if isinstance(backend, fail.Keyring) or "fail" in type(backend).__module__:
        raise SecretStoreUnavailable("no OS keychain backend available")
    return backend  # type: ignore[no-any-return]


class SecretStore:
    """Chunked secret storage under one keyring service."""

    def __init__(self, backend: SecretBackend, service: str = KEYRING_SERVICE) -> None:
        self.backend = backend
        self.service = service

    def _safe_delete(self, username: str) -> None:
        try:
            self.backend.delete_password(self.service, username)
        except Exception:  # noqa: S110 - absent entries are fine (idempotent)
            pass

    def get(self, name: str) -> str | None:
        head = self.backend.get_password(self.service, name)
        if head is None:
            return None
        if not head.startswith(_HEADER):
            return head
        n = int(head[len(_HEADER):])
        parts: list[str] = []
        for i in range(n):
            piece = self.backend.get_password(self.service, f"{name}#{i}")
            if piece is None:
                return None  # torn write: treat as absent
            parts.append(piece)
        return "".join(parts)

    def set(self, name: str, value: str) -> None:
        self.delete(name)
        chunks = [value[i:i + CHUNK_CHARS] for i in range(0, len(value), CHUNK_CHARS)] or [""]
        for i, piece in enumerate(chunks):
            self.backend.set_password(self.service, f"{name}#{i}", piece)
        # header last, so a crash mid-write leaves no readable partial value
        self.backend.set_password(self.service, name, f"{_HEADER}{len(chunks)}")

    def delete(self, name: str) -> None:
        head = None
        try:
            head = self.backend.get_password(self.service, name)
        except Exception:  # noqa: S110
            pass
        n = 0
        if head and head.startswith(_HEADER):
            try:
                n = int(head[len(_HEADER):])
            except ValueError:
                n = 0
        self._safe_delete(name)
        for i in range(max(n, 1) + 8):  # also sweep stale extra chunks
            if self.backend.get_password(self.service, f"{name}#{i}") is None and i >= n:
                break
            self._safe_delete(f"{name}#{i}")


TOKENS_ENTRY = "imanage-tokens"
DB_KEY_ENTRY = "db-key"


class TokenStore:
    """OAuth tokens for the DMS, as JSON in the keychain."""

    def __init__(self, secrets: SecretStore) -> None:
        self.secrets = secrets

    def load(self) -> dict[str, Any] | None:
        raw = self.secrets.get(TOKENS_ENTRY)
        if not raw:
            return None
        try:
            data: dict[str, Any] = json.loads(raw)
        except json.JSONDecodeError:
            return None
        return data

    def save(self, tokens: dict[str, Any]) -> None:
        self.secrets.set(TOKENS_ENTRY, json.dumps(tokens, separators=(",", ":")))

    def clear(self) -> None:
        self.secrets.delete(TOKENS_ENTRY)
