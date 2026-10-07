# Decision records

Short records: decision, alternatives considered, reason. Builders append
new records (D100+ for the backend, D200+ for the frontend) rather than
silently deviating from the design.

**D1: Use the official iManage Work REST API with delegated OAuth.**
Alternatives: direct database access, scraping, an IT export. The API is
supported, it respects the user's permissions and ethical walls, and IT can
audit it. An IT export remains the fallback, and the adapter layer allows
it.

**D2: Metadata only in phase 1. No document content and no AI.**
Alternative: reading content for classification and summaries. Metadata is
enough for evidence-on-file controls, it carries far less confidentiality
and GDPR risk, it gets IT approval faster, and it removes the risk of
prompt injection from document text. Content or AI features would need
their own approval and design.

**D3: A single local process. Python backend serves a static React UI in
the default browser.**
Alternatives: Electron, Tauri. On an IT-managed Windows laptop, one
PyInstaller bundle is the easiest thing for IT to package and approve.
There's no extra runtime (Electron) and no Rust or WebView toolchain
(Tauri). Edge is already present.

**D4: A DuckDB store, encrypted with a key held in Windows Credential
Manager.**
Alternatives: SQLite plus SQLCipher (needs native builds on Windows), or
relying on BitLocker alone. DuckDB is fast for portfolio aggregations, and
version 1.4 or later supports database encryption at `ATTACH`. If the
backend agent finds the encryption unusable, the fallback is BitLocker
plus the profile folder's ACLs. That fallback must be recorded here as
D1xx and called out in `IT-SETUP.md`.

**D5: Local API authentication uses a launch code, then an `HttpOnly`
`SameSite=Strict` cookie, plus a custom header, plus a `Host` check.**
Alternative: a bearer token in `localStorage`. A token in `localStorage`
can be read by any script. The cookie, header and Host combination defeats
CSRF and DNS-rebinding attacks from other web pages, without CORS.

**D6: Packaging with PyInstaller (a one-folder build), deployed by IT
through Intune.**
Alternative: a Python install on the laptop. The user can't install
software, and a self-contained bundle gives IT one artefact to scan and
sign.

**D7: Controls are defined in a configuration file (`controls.yaml`), not
in code.**
Alternative: hard-coding BWS's document classes. Class lists, thresholds
and field mappings are firm-specific and will be tuned by the risk team.
The engine stays generic.

**D8: Every result carries an evidence basis and the coverage is always
shown.**
This prevents over-reading: "missing on file" is not the same as "did not
happen", and "your visible workspaces" is not the same as "the whole firm".

**D9: Mock-first development.** Both builders work only against
`MockDmsAdapter` or contract mocks. No firm data enters the repository,
CI, or any agent's context.

**D10: The frontend uses React, Vite, TypeScript and Recharts, with an API
client typed from the contract.**
Recharts is mature, has no network dependencies, and is accessible enough
with the labels we specify. The frontend builder may record a different
choice as D2xx.
