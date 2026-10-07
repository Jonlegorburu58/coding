# Data model (DuckDB)

Metadata only. **PD** = personal data. **Conf** = client-confidential
identifier. Keep only what the controls and analytics use.

## Tables

### `library`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | iManage library ID |
| name | TEXT | |
| watermark | TIMESTAMP | Incremental sync point |
| last_full_sync | TIMESTAMP | |
| last_reconcile | TIMESTAMP | |

### `person`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | iManage user ID (PD) |
| display_name | TEXT | PD |
| office | TEXT | |
| is_fee_earner | BOOLEAN | From the mapping, if available |

### `matter` (one per iManage workspace)
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | Workspace ID |
| library_id | TEXT FK | |
| client_code | TEXT | Conf |
| client_name | TEXT | Conf |
| matter_code | TEXT | Conf |
| matter_name | TEXT | Conf |
| practice_area | TEXT | |
| partner_id | TEXT FK person | Responsible partner |
| fee_earner_id | TEXT FK person | Responsible fee earner / workspace owner |
| office | TEXT | |
| matter_type | TEXT | Used for AML exemptions |
| status | TEXT | `open` or `closed` |
| opened_at | TIMESTAMP | Workspace creation date, or the mapped open-date field |
| closed_at | TIMESTAMP NULL | |
| key_date | DATE NULL | Mapped critical-date field, if any |
| last_activity_at | TIMESTAMP | max(document edit_date) |
| doc_count | INTEGER | |
| synced_at | TIMESTAMP | |

### `document`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | iManage document ID (for example `LIB!123.1`) |
| matter_id | TEXT FK | |
| folder_path | TEXT | Folder names joined with ` / ` |
| name | TEXT | Conf. Used only for `signed_name_patterns` matching and evidence display |
| doc_class | TEXT | |
| doc_subclass | TEXT NULL | |
| canonical_type | TEXT NULL | Result of the `controls.yaml` mapping (for example `cdd`, `engagement_letter`) |
| author_id | TEXT FK person | PD |
| created_at | TIMESTAMP | |
| edited_at | TIMESTAMP | |
| version | INTEGER | |
| size_bytes | BIGINT | |
| synced_at | TIMESTAMP | |

### `control_result`
| Column | Type | Notes |
|--------|------|-------|
| matter_id | TEXT | PK (with control_id) |
| control_id | TEXT | For example `EL1` |
| status | TEXT | pass, late, missing, stale, pending, not_applicable, unknown |
| due_at | TIMESTAMP NULL | When the evidence was due |
| evidence_at | TIMESTAMP NULL | When the evidence was filed |
| days_late | INTEGER NULL | |
| evidence_doc_ids | TEXT[] | |
| basis | TEXT | `imanage_filing` in phase 1 |
| computed_at | TIMESTAMP | |

### `portfolio_snapshot` (for trends)
| Column | Type | Notes |
|--------|------|-------|
| taken_at | TIMESTAMP | PK (with control_id) |
| control_id | TEXT | `ALL` for the overall figure |
| applicable | INTEGER | |
| passing | INTEGER | |
| readiness | DOUBLE | |

### `sync_run`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| kind | TEXT | full, incremental or reconcile |
| started_at | TIMESTAMP | |
| finished_at | TIMESTAMP NULL | |
| status | TEXT | running, succeeded, failed or cancelled |
| workspaces_done | INTEGER | |
| workspaces_total | INTEGER NULL | |
| documents_seen | INTEGER | |
| error | TEXT NULL | Redacted message only |
| checkpoint | JSON | For resuming |

### `setting`
Key/value: `retention_days` (default 30), `sample_per_fee_earner`
(default 2), `last_sample_seed`.

## Retention and wiping

- Any matter whose `synced_at` is older than `retention_days` is purged at
  startup.
- A wipe deletes the database file, the key and the checkpoints.
- Revoked access is purged during reconciliation (ARCHITECTURE §5).

## `controls.yaml` (shape)

```yaml
version: 1
field_map:            # iManage profile field -> canonical field
  client_code: custom1
  matter_code: custom2
  practice_area: custom3
  partner: custom4
  office: custom5
  matter_type: custom6
  status: custom7      # value mapping below
  key_date: custom21   # optional; omit to mark CD1 as unknown
status_values: { open: ["OPEN", "Active"], closed: ["CLOSED"] }
doc_types:            # canonical type -> list of match rules (any rule matches)
  file_opening:       [{ class: "FILEOPEN" }]
  conflict_clearance: [{ class: "CONFLICT" }]
  cdd:                [{ class: "AML" }, { class: "KYC" }]
  engagement_letter:  [{ class: "ENGAGE" }]
  engagement_signed:  [{ class: "ENGAGE", subclass: "SIGNED" }]
  s150_notice:        [{ class: "S150" }]
  attendance_note:    [{ class: "ATTNOTE" }]
  costs_update:       [{ class: "COSTS" }]
  bill:               [{ class: "BILL" }]
intake_classes: [FILEOPEN, CONFLICT, AML, KYC, ENGAGE, S150]
signed_name_patterns: ["(?i)\\bsigned\\b", "(?i)countersigned"]
aml_exempt_matter_types: []
thresholds:
  FO1_days: 5
  EL1_days: 14
  AML2_months: 36
  AN1_days: 90
  FE1_months: 12
  FE2_months: 6
  HY1_months: 12
severity: { FO1: 2, CF1: 3, AML1: 3, AML2: 2, EL1: 3, EL2: 2, AN1: 1, CD1: 2, FE1: 2, FE2: 1, HY1: 1 }
```

The class codes above are **placeholders**. The real values come from
BWS's iManage admin (V6). Rules may also use `name_regex` or `folder`
matchers.
