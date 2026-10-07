"""The source-adapter interface (ARCHITECTURE §2).

Adapters return *raw* records shaped like the DMS's own profile data: a few
core fields plus a ``profile`` dict of DMS field names (for iManage:
``custom1``, ``custom1_description``...). Mapping to canonical fields is done
by ``controls.rules.FieldMapper`` from ``controls.yaml``, so nothing about a
firm's configuration is hard-coded in an adapter.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Protocol


class AdapterError(Exception):
    """A source error. The message must be safe to log and show (no titles/tokens)."""


class NotSignedInError(AdapterError):
    pass


class AccessLostError(AdapterError):
    """The user can no longer see this container (403/404)."""


@dataclass(frozen=True)
class Library:
    id: str
    name: str


@dataclass(frozen=True)
class UserInfo:
    id: str
    display_name: str


@dataclass(frozen=True)
class Capabilities:
    history: bool = False
    versions: bool = False
    server_side_since_filter: bool = False
    max_concurrency: int = 1


@dataclass(frozen=True)
class RawWorkspace:
    id: str
    library_id: str
    name: str
    owner_id: str | None
    owner_name: str | None
    created_at: datetime
    edited_at: datetime
    profile: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RawFolder:
    id: str
    workspace_id: str
    name: str
    path: str


@dataclass(frozen=True)
class RawDocument:
    id: str
    workspace_id: str
    folder_path: str
    name: str
    doc_class: str | None
    doc_subclass: str | None
    author_id: str | None
    author_name: str | None
    created_at: datetime
    edited_at: datetime
    version: int
    size_bytes: int


@dataclass(frozen=True)
class RawVersion:
    document_id: str
    version: int
    edited_at: datetime


@dataclass(frozen=True)
class SignInResult:
    status: Literal["browser_opened", "device_code", "signed_in"]
    verification_url: str | None = None
    user_code: str | None = None


class DmsAdapter(Protocol):
    """Read-only access to a DMS. All iterators yield *pages* (lists)."""

    source_name: str

    def capabilities(self) -> Capabilities: ...

    def is_signed_in(self) -> bool: ...

    async def sign_in(self) -> SignInResult: ...

    async def sign_out(self) -> None: ...

    async def current_user(self) -> UserInfo | None: ...

    async def list_libraries(self) -> list[Library]: ...

    def iter_workspaces(
        self, library_id: str, since: datetime | None
    ) -> AsyncIterator[list[RawWorkspace]]: ...

    def iter_folders(
        self, library_id: str, workspace_id: str
    ) -> AsyncIterator[list[RawFolder]]: ...

    def iter_documents(
        self, library_id: str, workspace_id: str, since: datetime | None
    ) -> AsyncIterator[list[RawDocument]]: ...

    async def get_versions(self, library_id: str, document_id: str) -> list[RawVersion]: ...

    async def aclose(self) -> None: ...
