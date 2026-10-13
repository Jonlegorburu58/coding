"""BWS Risk Desk MCP Server.

A local MCP server that gives Claude Desktop read-only access to the
firm's iManage DMS using the user's own Windows SSO credentials.

Read-only by design:
- Only GET requests are allowed
- Write-related API paths are blocked
- No create, update, move, upload or delete operations exist
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Optional

from mcp.server.fastmcp import FastMCP

from .config import Config
from .imanage import IManageClient, ReadOnlyViolation, AuthenticationError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("bws_risk_mcp")

mcp = FastMCP("bws-risk-desk")
_client: IManageClient | None = None


def get_client() -> IManageClient:
    global _client
    if _client is None:
        config = Config.load()
        _client = IManageClient(config)
    return _client


def safe_call(fn):
    try:
        result = fn()
        return json.dumps(result, indent=2, default=str)
    except ReadOnlyViolation as e:
        return json.dumps({"error": f"BLOCKED (read-only): {e}"})
    except AuthenticationError as e:
        return json.dumps({"error": f"Authentication failed: {e}"})
    except Exception as e:
        logger.exception("Tool call failed")
        return json.dumps({"error": f"{type(e).__name__}: {e}"})


@mcp.tool()
def test_connection() -> str:
    """Test connectivity and authentication to the iManage server. Returns server info and visible libraries if successful."""
    return safe_call(lambda: get_client().test_connection())


@mcp.tool()
def list_libraries() -> str:
    """List all iManage libraries visible to your account."""
    return safe_call(lambda: get_client().list_libraries())


@mcp.tool()
def search_workspaces(
    library: str,
    name: Optional[str] = None,
    custom1: Optional[str] = None,
    custom2: Optional[str] = None,
    custom3: Optional[str] = None,
    offset: int = 0,
    limit: int = 50,
) -> str:
    """Search for workspaces (matters) in a library. Filter by name or custom fields (practice area, partner, status)."""
    custom_fields = {}
    for key, val in [("custom1", custom1), ("custom2", custom2), ("custom3", custom3)]:
        if val:
            custom_fields[key] = val
    return safe_call(lambda: get_client().search_workspaces(
        library, name=name, custom_fields=custom_fields or None, offset=offset, limit=limit,
    ))


@mcp.tool()
def get_workspace(library: str, workspace_id: str) -> str:
    """Get the full profile of a single workspace (matter), including all custom fields."""
    return safe_call(lambda: get_client().get_workspace(library, workspace_id))


@mcp.tool()
def list_workspace_contents(library: str, workspace_id: str, offset: int = 0, limit: int = 100) -> str:
    """List folders and documents inside a workspace."""
    return safe_call(lambda: get_client().get_workspace_children(library, workspace_id, offset=offset, limit=limit))


@mcp.tool()
def list_folder_contents(library: str, folder_id: str, offset: int = 0, limit: int = 100) -> str:
    """List documents and subfolders inside a folder."""
    return safe_call(lambda: get_client().get_folder_children(library, folder_id, offset=offset, limit=limit))


@mcp.tool()
def search_documents(
    library: str,
    name: Optional[str] = None,
    doc_class: Optional[str] = None,
    author: Optional[str] = None,
    workspace_id: Optional[str] = None,
    created_after: Optional[str] = None,
    created_before: Optional[str] = None,
    offset: int = 0,
    limit: int = 50,
) -> str:
    """Search for documents in a library. Filter by name, class, author, workspace, or date range."""
    return safe_call(lambda: get_client().search_documents(
        library, name=name, doc_class=doc_class, author=author,
        workspace_id=workspace_id, created_after=created_after,
        created_before=created_before, offset=offset, limit=limit,
    ))


@mcp.tool()
def get_document_profile(library: str, doc_id: str) -> str:
    """Get the full metadata profile of a document (class, dates, author, custom fields)."""
    return safe_call(lambda: get_client().get_document(library, doc_id))


@mcp.tool()
def get_document_versions(library: str, doc_id: str) -> str:
    """Get the version history of a document."""
    return safe_call(lambda: get_client().get_document_versions(library, doc_id))


@mcp.tool()
def search_all(query: str, scope: str = "all", offset: int = 0, limit: int = 50) -> str:
    """Full-text search across all content in iManage. Searches document names, metadata, and indexed content."""
    return safe_call(lambda: get_client().search(query=query, scope=scope, offset=offset, limit=limit))


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
