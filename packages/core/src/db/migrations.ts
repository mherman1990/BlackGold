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
  {
    id: "0005_research_registry",
    up: `
CREATE TABLE experiments (
  experiment_id              TEXT PRIMARY KEY,
  registered_at              TEXT NOT NULL,
  registered_by              TEXT NOT NULL,
  parent_experiment_id       TEXT REFERENCES experiments (experiment_id),
  supersedes_reason          TEXT,
  definition_json            TEXT NOT NULL,
  definition_hash            TEXT NOT NULL,
  results_viewed_at          TEXT,
  holdout_opened_at          TEXT,
  holdout_opened_by          TEXT,
  holdout_opened_reason      TEXT,
  promotion_evidence_allowed INTEGER NOT NULL DEFAULT 1,
  promotion_evidence_at      TEXT,
  promotion_evidence_by      TEXT,
  labels_json                TEXT NOT NULL
);
CREATE INDEX experiments_parent ON experiments (parent_experiment_id);
CREATE TRIGGER experiments_no_delete BEFORE DELETE ON experiments
BEGIN SELECT RAISE(ABORT, 'experiments are never deleted'); END;
CREATE TRIGGER experiments_frozen BEFORE UPDATE ON experiments
WHEN NEW.definition_hash <> OLD.definition_hash OR NEW.definition_json <> OLD.definition_json
  OR NEW.experiment_id <> OLD.experiment_id OR NEW.registered_at <> OLD.registered_at
  OR NEW.registered_by <> OLD.registered_by OR COALESCE(NEW.parent_experiment_id,'') <> COALESCE(OLD.parent_experiment_id,'')
  OR NEW.labels_json <> OLD.labels_json
BEGIN SELECT RAISE(ABORT, 'experiment definition is frozen at registration'); END;
CREATE TRIGGER experiments_viewed_once BEFORE UPDATE ON experiments
WHEN OLD.results_viewed_at IS NOT NULL AND COALESCE(NEW.results_viewed_at,'') <> OLD.results_viewed_at
BEGIN SELECT RAISE(ABORT, 'results_viewed_at is set once'); END;
CREATE TRIGGER experiments_holdout_once BEFORE UPDATE ON experiments
WHEN OLD.holdout_opened_at IS NOT NULL AND (COALESCE(NEW.holdout_opened_at,'') <> OLD.holdout_opened_at
  OR COALESCE(NEW.holdout_opened_reason,'') <> COALESCE(OLD.holdout_opened_reason,'')
  OR COALESCE(NEW.holdout_opened_by,'') <> COALESCE(OLD.holdout_opened_by,''))
BEGIN SELECT RAISE(ABORT, 'the holdout opens once'); END;

CREATE TABLE trial_ledger (
  trial_id          TEXT PRIMARY KEY,
  experiment_id     TEXT NOT NULL REFERENCES experiments (experiment_id),
  arm               TEXT NOT NULL,
  split             TEXT NOT NULL,
  params_json       TEXT NOT NULL,
  metrics_json      TEXT NOT NULL,
  cost_scenario     TEXT NOT NULL,
  labels_json       TEXT NOT NULL,
  code_commit       TEXT NOT NULL,
  snapshot_ids_json TEXT NOT NULL,
  result_hash       TEXT NOT NULL,
  run_started       TEXT NOT NULL,
  run_finished      TEXT NOT NULL
);
CREATE INDEX trial_ledger_experiment ON trial_ledger (experiment_id);
CREATE TRIGGER trial_ledger_no_update BEFORE UPDATE ON trial_ledger
BEGIN SELECT RAISE(ABORT, 'trial ledger is append-only'); END;
CREATE TRIGGER trial_ledger_no_delete BEFORE DELETE ON trial_ledger
BEGIN SELECT RAISE(ABORT, 'trial ledger is append-only'); END;
`,
  },
  {
    id: "0006_entity_symbols",
    up: `
-- Bitemporal: effective_from/effective_to say WHEN a symbol denoted the entity; known_from and
-- close_known_from say from WHICH INSTANT that fact (and its closing) was knowable. A point-in-time
-- resolution at decision D ignores rows with known_from > D and treats a close with close_known_from > D
-- as not yet having happened, so a later sync can never leak into an earlier decision.
CREATE TABLE entity_symbols (
  id               INTEGER PRIMARY KEY,
  symbol           TEXT NOT NULL,
  effective_from   TEXT NOT NULL,
  effective_to     TEXT,
  entity_id        TEXT NOT NULL,
  source           TEXT NOT NULL,
  registered_at    TEXT NOT NULL,
  known_from       TEXT NOT NULL,
  close_known_from TEXT,
  CHECK ((effective_to IS NULL) = (close_known_from IS NULL))
);
CREATE INDEX entity_symbols_symbol ON entity_symbols (symbol, effective_from);
CREATE INDEX entity_symbols_entity ON entity_symbols (entity_id);
CREATE TRIGGER entity_symbols_no_delete BEFORE DELETE ON entity_symbols
BEGIN SELECT RAISE(ABORT, 'entity symbol ranges are append-only'); END;
CREATE TRIGGER entity_symbols_close_only BEFORE UPDATE ON entity_symbols
WHEN OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL OR NEW.close_known_from IS NULL OR NEW.symbol <> OLD.symbol
  OR NEW.effective_from <> OLD.effective_from OR NEW.entity_id <> OLD.entity_id OR NEW.source <> OLD.source
  OR NEW.registered_at <> OLD.registered_at OR NEW.known_from <> OLD.known_from OR NEW.id <> OLD.id
BEGIN SELECT RAISE(ABORT, 'an open symbol range may only be closed, with the instant the close became known'); END;
`,
  },
  {
    id: "0007_model_calls",
    up: `
-- Append-only archive of every runtime-LLM call (docs/PRODUCT_SPEC.md section 6, "Archive everything").
-- Holds only the redacted call record: model and version hashes, token counts, LLM API cost (never a
-- household dollar total), latency, and the deterministic outcome. No packet content, no secret, no account.
-- Budgets are derived by summing cost_usd over a day or month, so spend survives a process restart.
CREATE TABLE model_calls (
  id                      INTEGER PRIMARY KEY,
  at                      TEXT NOT NULL,
  strategy_version        TEXT NOT NULL,
  candidate_id            TEXT NOT NULL,
  model_id                TEXT NOT NULL,
  served_model_id         TEXT,
  prompt_version          TEXT NOT NULL,
  prompt_hash             TEXT NOT NULL,
  schema_hash             TEXT NOT NULL,
  packet_hash             TEXT NOT NULL,
  input_tokens            INTEGER NOT NULL,
  output_tokens           INTEGER NOT NULL,
  cache_read_input_tokens INTEGER NOT NULL,
  cost_usd                TEXT NOT NULL,
  latency_ms              INTEGER NOT NULL,
  attempts                INTEGER NOT NULL,
  outcome                 TEXT NOT NULL CHECK (outcome IN ('assessed','abstained')),
  abstain_code            TEXT,
  validation              TEXT NOT NULL,
  contamination_label     TEXT,
  run_mode                TEXT
);
CREATE INDEX model_calls_at ON model_calls (at);
CREATE TRIGGER model_calls_no_update BEFORE UPDATE ON model_calls
BEGIN SELECT RAISE(ABORT, 'model call log is append-only'); END;
CREATE TRIGGER model_calls_no_delete BEFORE DELETE ON model_calls
BEGIN SELECT RAISE(ABORT, 'model call log is append-only'); END;
`,
  },
];
