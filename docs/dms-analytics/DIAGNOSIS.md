# Diagnosis: reaching BWS iManage for risk analytics

Status: design. Nothing here has been run against the live DMS.
Prepared for: the General Counsel / firm risk lead (the "user").

## 1. What we were asked to do

Give the General Counsel a **read-only, portfolio-level view of risk
controls** across the firm's matters. The controls in scope are:

- file opening
- conflicts
- AML / customer due diligence (CDD)
- engagement letters and s.150 costs notices
- attendance notes
- critical date management
- fee management
- Lexcel audit readiness

The app must connect, review, and never edit or upload anything.

## 2. Facts established (from the user)

| Item | Answer |
|------|--------|
| DMS | iManage Work |
| Laptop | Windows, IT-managed (installs go through IT) |
| User role | General Counsel and risk lead. Wants every view that is appropriate for the risk function |
| Mode | Read-only, portfolio-level analysis |

## 3. Access route: the official iManage Work REST API with delegated OAuth 2.0

**Verified from iManage documentation:**

- iManage Work supports OAuth 2.0 for applications that integrate with it.
  Applications are registered by an administrator in **iManage Control
  Center → Settings → Applications**, and each one gets a name and an
  API key (client ID).
  ([iManage Control Center: Applications](https://docs.imanage.com/cc-help/10.4.0/en/Applications.html))
- On **iManage Cloud**, a new application must first be requested from
  iManage (through the "Tech Partner Journey" or the **iManage OAuth
  application request form**). Only after that can the firm's admin add it,
  choose which users or groups may use it, and set **Allow Refresh Token**,
  **Refresh Token Expiry** and **Access Token Expiry**.
  ([iManage Cloud: Adding an application](https://docs.imanage.com/cloud/cc-help/en-US/Adding_an_application.html))
- iManage's own Windows clients keep OAuth refresh tokens encrypted in
  **Windows Credential Manager**, so our design follows the same pattern.
  ([Persisting the OAuth2 refresh token](https://docs.imanage.com/wdw-custom-help/10.9.5/en/Persisting_the_oAuth2_refresh_token.html))
- The Work API can search workspaces, folders and documents, list the
  contents of a container (up to 500 items per call), and return a
  document's full version history with metadata.
  ([iManage MCP server tools reference](https://docs.imanage.com/ai/mcpserver-user-help/en-US/Tools_for_iManage_Work_connector.html),
  [Microsoft connector reference](https://learn.microsoft.com/en-us/connectors/imanagework/))

**Not yet verified. IT or iManage must confirm (see `IT-SETUP.md`):**

| # | Question | Why it matters |
|---|----------|----------------|
| V1 | Is BWS on iManage Cloud or on-premises/private cloud, and which Work Server version? | Decides the base URL, how the app is registered, and which API features are available |
| V2 | Which grant types the registered app may use: authorization code with PKCE and a loopback redirect (preferred), or device code | Decides the sign-in flow. The design supports both behind one interface |
| V3 | Exact read-only scope names | Least privilege |
| V4 | Rate limits and the paging limits per endpoint | Sync pacing |
| V5 | Whether document **history/audit events** (who opened or edited what, when) are exposed to a normal user via the API | Some activity metrics depend on it. The design degrades gracefully without it |
| V6 | How BWS has configured profile fields: which custom fields hold client, matter, practice area, partner, office and matter status; and the document **class/subclass** lists | Every control check depends on this mapping. It lives in a config file, not in code |

## 4. The most important finding: the controls live in more than one system

iManage holds **documents and their metadata**. It is not the system of
record for most risk controls. At most firms:

| Control | System of record (typical) | What iManage alone can show |
|---------|----------------------------|-----------------------------|
| File opening | Practice management / intake (e.g. Intapp Intake, Elite 3E, Aderant) | Whether a file-opening form exists in the workspace, and when |
| Conflicts | Conflicts system (e.g. Intapp Conflicts) | Whether a conflict clearance record is filed, and whether it pre-dates the first substantive work |
| AML / CDD | Intake or AML system, or the workspace | Whether CDD/ID documents are filed, when, and how old they are |
| Engagement letter / s.150 notice | The workspace | Whether one exists, when (relative to opening and first work), and whether a signed or returned version exists |
| Attendance notes | The workspace | Frequency and gaps relative to matter activity, by fee earner |
| Critical dates | Docketing or calendar (e.g. Outlook, Intapp, CompuLaw) | Only indirect signals (court documents, deadline-class documents) unless BWS stores key dates in workspace fields |
| Fee management | Practice management / billing (WIP, estimates, bills) | Whether costs updates, revised s.150 notices and bills are filed |
| Lexcel audit readiness | All of the above | A composite per-matter file-review score, plus file-review sampling |

**Consequence:** phase 1 (iManage only) measures **whether the evidence of
each control is on the file, and whether it was filed on time.** That is
exactly what a Lexcel or regulatory file review checks, so it is valuable
in its own right. But it cannot prove that the underlying process happened
(for example, that the conflict search itself was run). The design
therefore has a **pluggable source-adapter layer**, so that the practice
management, conflicts and docketing systems can be added in phase 2
without a rewrite. Every control result in the app shows its **evidence
basis** ("based on iManage filing evidence") so that nobody over-reads it.

## 5. Scope of visibility: a decision for the firm, not for the app

The app sees **exactly what the user's own iManage account can see**.
A portfolio view is only firm-wide if the user's account has firm-wide read
access. Matters behind ethical walls or security restrictions that exclude
the user will **not** appear.

- The app reports its **coverage** on every screen (for example "you can
  see 1,240 workspaces in library X") so that partial visibility is never
  mistaken for the whole firm.
- If the GC needs firm-wide coverage beyond what the account sees today,
  that access must be granted inside iManage itself, through the GC's
  authority under the firm's governance. The app will never try to widen
  access, and it will never use another person's credentials.

## 6. Alternatives considered

| Option | Verdict |
|--------|---------|
| **Custom read-only app on the iManage Work API (this design)** | Recommended. Bulk portfolio metrics, local and controlled, extensible to other systems |
| iManage's own connector for Claude / its MCP server ([listing](https://claude.com/marketplace/connectors/imanage)) | Good **complement** for ad-hoc questions about individual matters, under the firm's AI approvals. Not suited to sweeping thousands of workspaces for portfolio metrics |
| An iManage reporting or analytics module, or an IT-run export or data warehouse | A good fallback if IT won't register a new app. The adapter layer can read an export file instead of the API |
| Direct SQL against the iManage database, screen-scraping, copied browser sessions | **Rejected.** Unsupported, and it bypasses security controls and the firm's policies |

## 7. Regulatory notes that shape the design (Ireland)

- **Legal Services Regulation Act 2015, s.150**: legal costs must be
  disclosed in a notice at the outset, or as soon as practicable, and
  updated when costs change materially. This drives the engagement-letter
  and fee checks.
- **Criminal Justice (Money Laundering and Terrorist Financing) Act 2010**
  (as amended): CDD must be completed before the business relationship is
  established, subject to limited exceptions, and records must be kept for
  5 years after the relationship ends. This drives the AML checks and is
  one reason the app keeps **metadata only**.
- **GDPR / Data Protection Act 2018**: the local store holds staff names and
  client and matter identifiers, which are personal data. The design
  minimises fields, encrypts at rest, applies retention, and recommends DPIA
  screening.
- **Lexcel** (the Law Society of England and Wales practice-management
  standard, held by some Irish firms): file-review sampling and evidence of
  file-opening controls are core assessment items.

The GC should confirm these characterisations. They are design inputs,
not legal advice.
