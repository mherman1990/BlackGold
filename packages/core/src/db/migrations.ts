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
];
