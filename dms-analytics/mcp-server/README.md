# BWS Risk Desk MCP Server

A local MCP server that connects Claude Desktop to the firm's iManage DMS
at `dms.byrnewallace.com`, using your own Windows SSO credentials. Read-only
by design — it can search and read, never create, edit, move or delete.

## How it works

- Runs on your laptop as a local process
- Authenticates to iManage using Windows Integrated Authentication
  (the same Kerberos/NTLM credentials your Outlook plugin and browser use)
- Exposes read-only tools to Claude Desktop via the MCP protocol
- No app registration required — it uses your existing domain login
- All data stays on your laptop and in your Claude conversation

## Install (one time, about 2 minutes)

### 1. Install Python (if not already installed)

Open PowerShell and check:
```powershell
python --version
```
If not installed, download from https://www.python.org/downloads/ (3.10+).
Tick "Add to PATH" during install.

### 2. Install the MCP server

```powershell
# Clone or download the repo, then:
cd coding\dms-analytics\mcp-server
pip install .
```

### 3. Configure Claude Desktop

Open your Claude Desktop config file:
```
%APPDATA%\Claude\claude_desktop_config.json
```

Add the server under `mcpServers`:

```json
{
  "mcpServers": {
    "bws-risk-desk": {
      "command": "bws-risk-mcp",
      "args": []
    }
  }
}
```

If the file already has other MCP servers, add `bws-risk-desk` alongside them.

### 4. Restart Claude Desktop

Close and reopen Claude Desktop. You should see "bws-risk-desk" in the
MCP tools list (click the hammer icon).

### 5. Test the connection

In Claude Desktop, ask:
> Test the connection to iManage

Claude will call `test_connection` and show you whether authentication
worked and which libraries are visible.

## Configuration

The server creates a config file at `~/.bws-risk-mcp/config.json` on
first run. Defaults:

```json
{
  "base_url": "https://dms.byrnewallace.com",
  "api_version": "v2",
  "auth_method": "negotiate",
  "verify_ssl": true,
  "timeout_seconds": 30,
  "max_results": 500
}
```

### Auth methods

| Method | When to use |
|--------|-------------|
| `negotiate` (default) | Tries Kerberos first, falls back to NTLM. Works on domain-joined Windows machines. |
| `kerberos` | Forces Kerberos only. Use if Negotiate doesn't work. |
| `ntlm` | Forces NTLM only. Fallback if Kerberos isn't available. |

### If the API version differs

If `v2` returns 404, change `api_version` to `v1` in the config file.

## Available tools

All tools are **read-only**. There are no write operations.

| Tool | What it does |
|------|--------------|
| `test_connection` | Verify auth and list visible libraries |
| `list_libraries` | List all iManage libraries |
| `search_workspaces` | Search matters by name, practice area, partner |
| `get_workspace` | Full profile of one workspace |
| `list_workspace_contents` | Folders and documents in a workspace |
| `list_folder_contents` | Contents of a folder |
| `search_documents` | Find documents by name, class, author, date |
| `get_document_profile` | Full metadata of one document |
| `get_document_versions` | Version history of a document |
| `search_all` | Full-text search across everything |

## Safety

- **GET requests only.** POST, PUT, PATCH and DELETE are blocked in code.
- **API path allow-list.** Only `/work/api/v1/` and `/work/api/v2/` paths
  are permitted.
- **Write path blocking.** URLs containing upload, copy, move, lock,
  checkout or checkin are rejected even as GET.
- **Your credentials only.** The server uses your Windows domain session.
  It never stores, transmits or displays passwords.
- **No document content by default.** The server reads metadata (profiles,
  dates, classes). It does not download document content.

## Troubleshooting

### "Authentication failed"
- Make sure you're signed into the Windows domain (`whoami` should show
  `DOMAIN\username`)
- Check your Kerberos ticket: `klist` in PowerShell
- Try changing `auth_method` to `ntlm` in the config

### "Connection failed"
- Check you can reach `dms.byrnewallace.com` in your browser
- You must be on the firm's network (or VPN)
- Check `verify_ssl` — if the firm uses an internal CA, you may need to set
  this to `false` or point to the CA bundle

### "404 Not Found" on API calls
- Try changing `api_version` from `v2` to `v1` in the config file
- The base URL may differ — check what your browser uses when you open iManage
