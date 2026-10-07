-- 0001: initial schema (data-model.md).
-- Foreign keys are logical only: DuckDB implements UPDATE as delete+insert,
-- which makes declared FKs reject ordinary upserts of parent rows (D101).

CREATE TABLE library (
    id TEXT PRIMARY KEY,
    name TEXT,
    watermark TIMESTAMP,
    last_full_sync TIMESTAMP,
    last_reconcile TIMESTAMP
);

CREATE TABLE person (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    office TEXT,
    is_fee_earner BOOLEAN
);

CREATE TABLE matter (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL,
    client_code TEXT,
    client_name TEXT,
    matter_code TEXT,
    matter_name TEXT,
    practice_area TEXT,
    partner_id TEXT,
    fee_earner_id TEXT,
    office TEXT,
    matter_type TEXT,
    status TEXT NOT NULL,
    opened_at TIMESTAMP NOT NULL,
    closed_at TIMESTAMP,
    key_date DATE,
    last_activity_at TIMESTAMP,
    doc_count INTEGER DEFAULT 0,
    synced_at TIMESTAMP NOT NULL
);

CREATE TABLE document (
    id TEXT PRIMARY KEY,
    matter_id TEXT NOT NULL,
    folder_path TEXT,
    name TEXT,
    doc_class TEXT,
    doc_subclass TEXT,
    canonical_type TEXT,
    author_id TEXT,
    created_at TIMESTAMP NOT NULL,
    edited_at TIMESTAMP NOT NULL,
    version INTEGER,
    size_bytes BIGINT,
    synced_at TIMESTAMP NOT NULL
);

CREATE INDEX document_matter_idx ON document (matter_id);

CREATE TABLE control_result (
    matter_id TEXT NOT NULL,
    control_id TEXT NOT NULL,
    status TEXT NOT NULL,
    due_at TIMESTAMP,
    evidence_at TIMESTAMP,
    days_late INTEGER,
    evidence_doc_ids TEXT[],
    basis TEXT NOT NULL,
    computed_at TIMESTAMP NOT NULL,
    explanation TEXT,          -- addition to data-model.md (D102)
    PRIMARY KEY (matter_id, control_id)
);

CREATE TABLE portfolio_snapshot (
    taken_at TIMESTAMP NOT NULL,
    control_id TEXT NOT NULL,
    applicable INTEGER,
    passing INTEGER,
    readiness DOUBLE,
    PRIMARY KEY (taken_at, control_id)
);

CREATE TABLE sync_run (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    started_at TIMESTAMP NOT NULL,
    finished_at TIMESTAMP,
    status TEXT NOT NULL,
    workspaces_done INTEGER DEFAULT 0,
    workspaces_total INTEGER,
    documents_seen INTEGER DEFAULT 0,
    error TEXT,
    checkpoint JSON
);

CREATE TABLE setting (
    key TEXT PRIMARY KEY,
    value TEXT
);
