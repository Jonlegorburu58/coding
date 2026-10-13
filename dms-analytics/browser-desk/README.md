# BWS DMS Desk

A local Python web interface and stdio MCP server for saved iManage metadata.
Python 3.10+ is required; the application has no external Python dependencies.

## Run

```sh
python launch.py
```

On Windows, `python launch.py --app` opens an Edge app-style window when Edge
is installed. `Start DMS Desk.cmd` uses the current user's bundled Codex Python.
The server listens at `http://127.0.0.1:8768` and binds only to loopback.

## Data and scope

Import a browser-collected folder JSON through the interface. Captures and the
SQLite database stay under `inbox/` and `data/`; neither directory is committed.
The importer validates the source host, page counts, duplicate pages/documents,
dates and metadata shape. Incomplete captures are labelled as partial.

The question box supports a limited set of metadata questions. It is not a
general language model, live autonomous search service, or document-content
retrieval API. Unsupported content questions are labelled as requiring retrieval.
The optional bookmarklet reads visible folder metadata; it has not been verified
end to end in every browser and may be blocked by the DMS Content Security Policy.

Live investigations may be conducted separately through the user's authenticated
browser. A locally generated `data/research.html` can be viewed at `/research`.
Such reports remain local and do not imply the web app itself controls the DMS.
No browser cookies, auth tokens, passwords or machine-specific Claude settings
are included in this source backup.

## Claude MCP

Configure a local MCP entry with your Python executable as `command` and
`["/absolute/path/to/app.py", "mcp"]` as `args`. Restart the MCP client after
changing its configuration. Tools expose saved metadata and local imports only.

## Test

```sh
python test_app.py
```

Tests use synthetic metadata and temporary databases. Private captures, live
search results, document names, screenshots and machine configuration are
excluded from this repository.
