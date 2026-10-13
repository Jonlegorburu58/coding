"""Read-only iManage REST API client using Windows SSO authentication.

Uses the same domain credentials that the Outlook plugin and browser use.
Supports Negotiate (Kerberos/NTLM), pure NTLM, and pure Kerberos.
"""

from __future__ import annotations

import logging
from typing import Any

import requests
from requests_ntlm import HttpNtlmAuth

from .config import Config

logger = logging.getLogger("bws_risk_mcp.imanage")

SAFE_PREFIXES = (
    "/work/api/v1/",
    "/work/api/v2/",
)

BLOCKED_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

WRITE_PATH_FRAGMENTS = frozenset({
    "/upload",
    "/copy",
    "/move",
    "/lock",
    "/unlock",
    "/checkout",
    "/checkin",
})


class ReadOnlyViolation(Exception):
    pass


class AuthenticationError(Exception):
    pass


class IManageClient:
    """Read-only iManage client with Windows Integrated Authentication."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.session = requests.Session()
        self.session.verify = config.verify_ssl
        self.session.headers["Accept"] = "application/json"
        self._configure_auth()

    def _configure_auth(self) -> None:
        method = self.config.auth_method.lower()

        if method in ("negotiate", "sspi"):
            # The only method that signs in as the current Windows user
            # with no password, via SSPI. This is true Windows SSO.
            if self._setup_sspi():
                return
            logger.warning("SSPI unavailable, falling back to Kerberos")
            if self._setup_kerberos():
                return
            logger.warning("Kerberos unavailable, falling back to NTLM")
            self._setup_ntlm()
        elif method == "kerberos":
            if not self._setup_kerberos():
                raise AuthenticationError(
                    "Kerberos requested but requests_kerberos is not installed"
                )
        elif method == "ntlm":
            self._setup_ntlm()
        else:
            raise AuthenticationError(f"Unknown auth method: {method}")

    def _setup_sspi(self) -> bool:
        try:
            from requests_negotiate_sspi import HttpNegotiateAuth
        except ImportError:
            return False
        # Uses the current logged-in Windows account token. No password.
        self.session.auth = HttpNegotiateAuth()
        logger.info("Using Negotiate (SSPI) as the current Windows user")
        return True

    def _setup_kerberos(self) -> bool:
        try:
            from requests_kerberos import HTTPKerberosAuth, OPTIONAL
        except ImportError:
            return False
        self.session.auth = HTTPKerberosAuth(mutual_authentication=OPTIONAL)
        logger.info("Using Kerberos authentication")
        return True

    def _setup_ntlm(self) -> None:
        import getpass
        import os
        domain = os.environ.get("USERDOMAIN", "")
        user = os.environ.get("USERNAME", getpass.getuser())
        ntlm_user = f"{domain}\\{user}" if domain else user
        # Note: NTLM here needs real credentials; a blank password does not
        # pass through the Windows session. Prefer "negotiate" (SSPI) above.
        self.session.auth = HttpNtlmAuth(ntlm_user, "")
        logger.info("Using NTLM authentication as %s", ntlm_user)

    def _guard_read_only(self, method: str, path: str) -> None:
        if method.upper() in BLOCKED_METHODS:
            raise ReadOnlyViolation(
                f"Blocked: {method} is not allowed (read-only mode)"
            )
        if any(frag in path.lower() for frag in WRITE_PATH_FRAGMENTS):
            raise ReadOnlyViolation(
                f"Blocked: path contains write operation ({path})"
            )

    def _guard_path(self, path: str) -> None:
        if not any(path.startswith(p) for p in SAFE_PREFIXES):
            raise ReadOnlyViolation(
                f"Blocked: path outside API scope ({path})"
            )

    def get(self, endpoint: str, params: dict[str, Any] | None = None) -> Any:
        path = f"/work/api/{self.config.api_version}/{endpoint.lstrip('/')}"
        self._guard_path(path)
        self._guard_read_only("GET", path)

        url = f"{self.config.base_url}{path}"
        logger.debug("GET %s", url)

        resp = self.session.get(
            url,
            params=params,
            timeout=self.config.timeout_seconds,
        )

        if resp.status_code == 401:
            raise AuthenticationError(
                "Authentication failed. Check that you are signed into the "
                "Windows domain and your Kerberos ticket is valid "
                "(run 'klist' to check)."
            )
        resp.raise_for_status()
        return resp.json()

    def test_connection(self) -> dict[str, Any]:
        """Test connectivity and authentication. Returns server info."""
        try:
            result = self.get("libraries")
            libs = result.get("data", result) if isinstance(result, dict) else result
            lib_names = []
            if isinstance(libs, list):
                lib_names = [
                    lib.get("name", lib.get("database", "unknown"))
                    for lib in libs[:20]
                ]
            return {
                "status": "connected",
                "server": self.config.base_url,
                "auth_method": self.config.auth_method,
                "libraries_visible": len(lib_names),
                "library_names": lib_names,
            }
        except AuthenticationError as e:
            return {"status": "auth_failed", "error": str(e)}
        except requests.ConnectionError as e:
            return {"status": "connection_failed", "error": str(e)}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    # -- Library operations --

    def list_libraries(self) -> list[dict[str, Any]]:
        result = self.get("libraries")
        return result.get("data", result) if isinstance(result, dict) else result

    # -- Workspace operations --

    def search_workspaces(
        self,
        library: str,
        *,
        name: str | None = None,
        custom_fields: dict[str, str] | None = None,
        offset: int = 0,
        limit: int = 50,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"offset": offset, "limit": min(limit, self.config.max_results)}
        if name:
            params["name"] = name
        if custom_fields:
            for k, v in custom_fields.items():
                params[k] = v
        return self.get(f"libraries/{library}/workspaces", params)

    def get_workspace(self, library: str, workspace_id: str) -> dict[str, Any]:
        return self.get(f"libraries/{library}/workspaces/{workspace_id}")

    def get_workspace_children(
        self,
        library: str,
        workspace_id: str,
        *,
        offset: int = 0,
        limit: int = 100,
    ) -> dict[str, Any]:
        params = {"offset": offset, "limit": min(limit, self.config.max_results)}
        return self.get(
            f"libraries/{library}/workspaces/{workspace_id}/children",
            params,
        )

    # -- Folder operations --

    def get_folder_children(
        self,
        library: str,
        folder_id: str,
        *,
        offset: int = 0,
        limit: int = 100,
    ) -> dict[str, Any]:
        params = {"offset": offset, "limit": min(limit, self.config.max_results)}
        return self.get(
            f"libraries/{library}/folders/{folder_id}/children",
            params,
        )

    def search_folders(
        self,
        library: str,
        *,
        name: str | None = None,
        parent_id: str | None = None,
        offset: int = 0,
        limit: int = 50,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"offset": offset, "limit": min(limit, self.config.max_results)}
        if name:
            params["name"] = name
        if parent_id:
            params["parent_id"] = parent_id
        return self.get(f"libraries/{library}/folders", params)

    # -- Document operations --

    def search_documents(
        self,
        library: str,
        *,
        name: str | None = None,
        doc_class: str | None = None,
        author: str | None = None,
        workspace_id: str | None = None,
        created_after: str | None = None,
        created_before: str | None = None,
        offset: int = 0,
        limit: int = 50,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"offset": offset, "limit": min(limit, self.config.max_results)}
        if name:
            params["name"] = name
        if doc_class:
            params["class"] = doc_class
        if author:
            params["author"] = author
        if workspace_id:
            params["workspace_id"] = workspace_id
        if created_after:
            params["create_date>"] = created_after
        if created_before:
            params["create_date<"] = created_before
        return self.get(f"libraries/{library}/documents", params)

    def get_document(self, library: str, doc_id: str) -> dict[str, Any]:
        return self.get(f"libraries/{library}/documents/{doc_id}")

    def get_document_versions(self, library: str, doc_id: str) -> dict[str, Any]:
        return self.get(f"libraries/{library}/documents/{doc_id}/versions")

    # -- General search --

    def search(
        self,
        *,
        query: str,
        scope: str = "all",
        offset: int = 0,
        limit: int = 50,
    ) -> dict[str, Any]:
        params = {
            "query": query,
            "scope": scope,
            "offset": offset,
            "limit": min(limit, self.config.max_results),
        }
        return self.get("search", params)
