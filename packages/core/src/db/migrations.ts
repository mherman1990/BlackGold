import type { Migration } from "@blackgold/shared";

/**
 * Core schema, forward-only. Never edit an applied migration; add a new one.
 * ledger_events and ledger_seals are append-only: triggers abort any UPDATE or DELETE.
 */
export const CORE_MIGRATIONS: readonly Migration[] = [
  {
    id: "0001_ledger",
    up: `
CREATE TABLE ledger_events (
  seq       INTEGER PRIMARY KEY,
  at        TEXT NOT NULL,
  kind      TEXT NOT NULL,
  payload   TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL UNIQUE
);
CREATE INDEX ledger_events_at ON ledger_events (at);
CREATE TRIGGER ledger_events_no_update BEFORE UPDATE ON ledger_events
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER ledger_events_no_delete BEFORE DELETE ON ledger_events
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

CREATE TABLE ledger_seals (
  date      TEXT PRIMARY KEY,
  first_seq INTEGER,
  last_seq  INTEGER,
  root_hash TEXT NOT NULL,
  sealed_at TEXT NOT NULL
);
CREATE TRIGGER ledger_seals_no_update BEFORE UPDATE ON ledger_seals
BEGIN SELECT RAISE(ABORT, 'ledger seals are append-only'); END;
CREATE TRIGGER ledger_seals_no_delete BEFORE DELETE ON ledger_seals
BEGIN SELECT RAISE(ABORT, 'ledger seals are append-only'); END;
`,
  },
  {
    id: "0002_jobs",
    up: `
CREATE TABLE jobs (
  job_id        TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  schedule_kind TEXT NOT NULL,
  spec          TEXT NOT NULL,
  deadline_ms   INTEGER NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE job_runs (
  idempotency_key TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL,
  scheduled_for   TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  status          TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','missed','skipped_duplicate')),
  attempt         INTEGER NOT NULL DEFAULT 1,
  error           TEXT
);
CREATE INDEX job_runs_job_scheduled ON job_runs (job_id, scheduled_for);
`,
  },
  {
    id: "0003_kv_health",
    up: `
CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE health_checks (
  at        TEXT NOT NULL,
  component TEXT NOT NULL,
  ok        INTEGER NOT NULL,
  detail    TEXT
);
CREATE INDEX health_checks_at ON health_checks (at);
`,
  },
  {
    id: "0004_pit_observations_artifacts",
    up: `
CREATE TABLE observations (
  id                 INTEGER PRIMARY KEY,
  source_id          TEXT NOT NULL,
  source_locator     TEXT NOT NULL,
  entity_id          TEXT,
  observed_at        TEXT,
  effective_at       TEXT,
  available_at       TEXT NOT NULL,
  vintage_at         TEXT,
  ingested_at        TEXT NOT NULL,
  raw_content_hash   TEXT NOT NULL,
  adapter_version    TEXT NOT NULL,
  parser_version     TEXT NOT NULL,
  value_json         TEXT NOT NULL,
  quality_flags_json TEXT NOT NULL,
  value_hash         TEXT NOT NULL
);
CREATE INDEX observations_decision ON observations (source_id, entity_id, available_at);
CREATE INDEX observations_effective ON observations (source_id, entity_id, effective_at, vintage_at);
CREATE INDEX observations_identity ON observations (source_id, source_locator, parser_version);
CREATE INDEX observations_hash ON observations (raw_content_hash);
CREATE TRIGGER observations_no_update BEFORE UPDATE ON observations
BEGIN SELECT RAISE(ABORT, 'observations are append-only; corrections are new rows'); END;
CREATE TRIGGER observations_no_delete BEFORE DELETE ON observations
BEGIN SELECT RAISE(ABORT, 'observations are append-only'); END;

CREATE TABLE pit_snapshots (
  snapshot_id        TEXT PRIMARY KEY,
  dataset            TEXT NOT NULL,
  description        TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  max_observation_id INTEGER NOT NULL
);
CREATE TRIGGER pit_snapshots_no_update BEFORE UPDATE ON pit_snapshots
BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;
CREATE TRIGGER pit_snapshots_no_delete BEFORE DELETE ON pit_snapshots
BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;

CREATE TABLE artifacts (
  hash              TEXT PRIMARY KEY,
  bytes_raw         INTEGER NOT NULL,
  bytes_compressed  INTEGER NOT NULL,
  mime              TEXT NOT NULL,
  first_locator     TEXT NOT NULL,
  first_ingested_at TEXT NOT NULL,
  last_verified_at  TEXT,
  etag              TEXT,
  last_modified     TEXT,
  retention_class   TEXT NOT NULL,
  path              TEXT NOT NULL
);
CREATE TRIGGER artifacts_no_delete BEFORE DELETE ON artifacts
BEGIN SELECT RAISE(ABORT, 'artifact metadata is append-only'); END;
`,
  },
];
