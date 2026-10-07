# Instruction to BWS IT: technical set-up for read-only iManage risk analytics

**From:** General Counsel (authorising officer)
**Status:** draft for the GC to issue

## 1. Authorisation

I have authorised the build and use of a read-only risk-analytics tool on
my firm laptop. It uses **my own iManage access**. It covers file opening,
conflicts clearance, AML/CDD, engagement letters and s.150 notices,
attendance notes, critical dates, costs updates and Lexcel readiness.

This note sets out the technical steps that need iManage administrator
or device-management rights, which I don't hold on my own account.

## 2. What the tool does and does not do

- It **reads metadata only**: workspace profile fields and document
  class, date and author. It never reads document content.
- It **never writes**. It does not edit, move, upload, check out or
  delete anything. A GET-only allow-list is enforced in code and tested.
- It **uses my credentials only** and sees exactly what I see in iManage,
  with ethical walls respected. It uses no service account and no shared
  credentials.
- It has **no cloud, AI or telemetry**. Its only network traffic is to
  iManage and the sign-in service. It listens on `127.0.0.1` only.

## 3. Please action

1. **Send me platform details**: whether we're on iManage Cloud or
   on-premises, the Work Server version, the base URL, and the customer and
   library IDs.
2. **Register the OAuth application for iManage Work**:
   - On iManage Cloud: submit the **iManage OAuth application request
     form**, then add the app in **Control Center → Applications**.
   - On-premises: **Control Center → Settings → Applications → Add
     Application → Configure Manually**.
   - Type: a public or native client (no client secret).
   - Grant: authorization code with PKCE, with redirect URI
     `http://127.0.0.1:8765/auth/callback`. Use device code if that isn't
     supported.
   - Scope: read-only.
   - **Allow Refresh Token**: yes. Refresh token expiry 14 days, access
     token expiry 60 minutes, or the firm's standard.
   - User access: **Custom**, my account only.
   - Send me the **API key / client ID**.
3. **Tell me about rate limits**, or any preferred time window for the
   first full sync, which may take a few hours.
4. **Send me the profile-field and document-class configuration**: which
   custom fields hold client, matter, practice area, partner, office,
   matter type, status and any key or critical date; and the document
   classes and subclasses used for file opening, conflicts, AML/KYC,
   engagement letters, s.150 notices, attendance notes, costs updates and
   bills.
5. **Install the app**: deploy `dms-analytics.exe` (a PyInstaller folder,
   no admin rights needed at runtime) to my laptop through Intune or
   Company Portal, after your usual malware scan and code signing.

## 4. Data handling on the laptop

| Item | Handling |
|------|----------|
| Where it is stored | `%LOCALAPPDATA%\BWS\DmsAnalytics\` (my user profile) |
| Encryption | DuckDB database encryption, with the key in Windows Credential Manager, on top of BitLocker |
| Tokens | Windows Credential Manager only, never in files or logs |
| What is held | Workspace profile fields, document IDs, names, classes, dates, authors. **No document content** |
| Retention | Data not refreshed within 30 days is purged automatically. "Wipe local data" deletes everything, including the key |
| Logs | Redacted: no client or matter names, document titles or tokens |
| Revoked access | Workspaces I can no longer see are deleted locally at the next reconciliation |

## 5. Record for the firm's GDPR file

The local store contains personal data (staff names as authors and fee
earners, and client identifiers). The purpose is regulatory compliance and
risk management. Data is minimised to metadata, held locally with
encryption, and has short retention. This section is the processing
record. The GC decides whether a DPIA screening is needed.

## 6. Go-live

The tool was built and tested on synthetic data only. Go-live steps:

1. IT installs it.
2. I sign in.
3. A first sync runs against one library.
4. I spot-check a handful of known matters.
5. The document-class mapping is tuned.
6. It is extended to all libraries.
