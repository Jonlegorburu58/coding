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

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from .config import Config
from .imanage import IManageClient, ReadOnlyViolation, AuthenticationError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("bws_risk_mcp")

app = Server("bws-risk-mcp")
_client: IManageClient | None = None


def get_client() -> IManageClient:
    global _client
    if _client is None:
        config = Config.load()
        _client = IManageClient(config)
    return _client


def ok(data: object) -> list[TextContent]:
    return [TextContent(type="text", text=json.dumps(data, indent=2, default=str))]


def err(msg: str) -> list[TextContent]:
    return [TextContent(type="text", text=json.dumps({"error": msg}))]


# -- Tool definitions --

TOOLS = [
    Tool(
        name="test_connection",
        description=(
            "Test connectivity and authentication to the iManage server. "
            "Returns server info and visible libraries if successful."
        ),
        inputSchema={"type": "object", "properties": {}, "required": []},
    ),
    Tool(
        name="list_libraries",
        description="List all iManage libraries visible to your account.",
        inputSchema={"type": "object", "properties": {}, "required": []},
    ),
    Tool(
        name="search_workspaces",
        description=(
            "Search for workspaces (matters) in a library. "
            "Filter by name or custom fields (practice area, partner, status, etc.)."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "library": {"type": "string", "description": "Library name (e.g. BWS-LIVE)"},
                "name": {"type": "string", "description": "Workspace name filter"},
                "custom1": {"type": "string", "description": "Custom field 1 filter (typically practice area)"},
                "custom2": {"type": "string", "description": "Custom field 2 filter (typically partner)"},
                "custom3": {"type": "string", "description": "Custom field 3 filter"},
                "offset": {"type": "integer", "description": "Pagination offset", "default": 0},
                "limit": {"type": "integer", "description": "Max results (up to 500)", "default": 50},
            },
            "required": ["library"],
        },
    ),
    Tool(
        name="get_workspace",
        description="Get the full profile of a single workspace (matter), including all custom fields.",
        inputSchema={
            "type": "object",
            "properties": {
                "library": {"type": "string", "description": "Library name"},
                "workspace_id": {"type": "string", "description": "Workspace ID"},
            },
            "required": ["library", "workspace_id"],
        },
    ),
    Tool(
        name="list_workspace_contents",
        description="List folders and documents inside a workspace.",
        inputSchema={
            "type": "object",
            "properties": {
                "library": {"type": "string", "description": "Library name"},
                "workspace_id": {"type": "string", "description": "Workspace ID"},
                "offset": {"type": "integer", "default": 0},
                "limit": {"type": "integer", "default": 100},
            },
            "required": ["library", "workspace_id"],
        },
    ),
    Tool(
        name="list_folder_contents",
        description="List documents and subfolders inside a folder.",
        inputSchema={
            "type": "object",
            "properties": {
                "library": {"type": "string", "description": "Library name"},
                "folder_id": {"type": "string", "description": "Folder ID"},
                "offset": {"type": "integer", "default": 0},
                "limit": {"type": "integer", "default": 100},
            },
            "required": ["library", "folder_id"],
        },
    ),
    Tool(
        name="search_documents",
        description=(
            "Search for documents in a library. Filter by name, class, author, "
            "workspace, or date range. Use this to find specific document types "
            "(engagement letters, conflict clearances, CDD, attendance notes, bills)."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "library": {"type": "string", "description": "Library name"},
                "name": {"type": "string", "description": "Document name filter"},
                "doc_class": {"type": "string", "description": "Document class filter"},
                "author": {"type": "string", "description": "Author filter"},
                "workspace_id": {"type": "string", "description": "Limit to a specific workspace"},
                "created_after": {"type": "string", "description": "ISO date, e.g. 2025-01-01"},
                "created_before": {"type": "string", "description": "ISO date"},
                "offset": {"type": "integer", "default": 0},
                "limit": {"type": "integer", "default": 50},
            },
            "required": ["library"],
        },
    ),
    Tool(
        name="get_document_profile",
        description="Get the full metadata profile of a document (class, dates, author, custom fields).",
        inputSchema={
            "type": "object",
            "properties": {
                "library": {"type": "string", "description": "Library name"},
                "doc_id": {"type": "string", "description": "Document ID"},
            },
            "required": ["library", "doc_id"],
        },
    ),
    Tool(
        name="get_document_versions",
        description="Get the version history of a document.",
        inputSchema={
            "type": "object",
            "properties": {
                "library": {"type": "string", "description": "Library name"},
                "doc_id": {"type": "string", "description": "Document ID"},
            },
            "required": ["library", "doc_id"],
        },
    ),
    Tool(
        name="search_all",
        description=(
            "Full-text search across all content in iManage. "
            "Searches document names, metadata, and indexed content."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "scope": {
                    "type": "string",
                    "description": "Search scope: all, workspaces, documents, folders, emails",
                    "default": "all",
                },
                "offset": {"type": "integer", "default": 0},
                "limit": {"type": "integer", "default": 50},
            },
            "required": ["query"],
        },
    ),
]


@app.list_tools()
async def list_tools() -> list[Tool]:
    return TOOLS


@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        client = get_client()

        if name == "test_connection":
            return ok(client.test_connection())

        if name == "list_libraries":
            return ok(client.list_libraries())

        if name == "search_workspaces":
            custom_fields = {}
            for key in ("custom1", "custom2", "custom3"):
                if key in arguments and arguments[key]:
                    custom_fields[key] = arguments[key]
            return ok(
                client.search_workspaces(
                    arguments["library"],
                    name=arguments.get("name"),
                    custom_fields=custom_fields or None,
                    offset=arguments.get("offset", 0),
                    limit=arguments.get("limit", 50),
                )
            )

        if name == "get_workspace":
            return ok(
                client.get_workspace(arguments["library"], arguments["workspace_id"])
            )

        if name == "list_workspace_contents":
            return ok(
                client.get_workspace_children(
                    arguments["library"],
                    arguments["workspace_id"],
                    offset=arguments.get("offset", 0),
                    limit=arguments.get("limit", 100),
                )
            )

        if name == "list_folder_contents":
            return ok(
                client.get_folder_children(
                    arguments["library"],
                    arguments["folder_id"],
                    offset=arguments.get("offset", 0),
                    limit=arguments.get("limit", 100),
                )
            )

        if name == "search_documents":
            return ok(
                client.search_documents(
                    arguments["library"],
                    name=arguments.get("name"),
                    doc_class=arguments.get("doc_class"),
                    author=arguments.get("author"),
                    workspace_id=arguments.get("workspace_id"),
                    created_after=arguments.get("created_after"),
                    created_before=arguments.get("created_before"),
                    offset=arguments.get("offset", 0),
                    limit=arguments.get("limit", 50),
                )
            )

        if name == "get_document_profile":
            return ok(client.get_document(arguments["library"], arguments["doc_id"]))

        if name == "get_document_versions":
            return ok(
                client.get_document_versions(arguments["library"], arguments["doc_id"])
            )

        if name == "search_all":
            return ok(
                client.search(
                    query=arguments["query"],
                    scope=arguments.get("scope", "all"),
                    offset=arguments.get("offset", 0),
                    limit=arguments.get("limit", 50),
                )
            )

        return err(f"Unknown tool: {name}")

    except ReadOnlyViolation as e:
        return err(f"BLOCKED (read-only): {e}")
    except AuthenticationError as e:
        return err(f"Authentication failed: {e}")
    except Exception as e:
        logger.exception("Tool %s failed", name)
        return err(f"{type(e).__name__}: {e}")


def main() -> None:
    import asyncio

    async def run() -> None:
        async with stdio_server() as (read_stream, write_stream):
            await app.run(read_stream, write_stream, app.create_initialization_options())

    asyncio.run(run())


if __name__ == "__main__":
    main()
