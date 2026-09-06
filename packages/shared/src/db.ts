import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Thin wrapper over node:sqlite with the invariants Black Gold requires:
 * WAL mode, foreign keys on, busy timeout, a single writer per process, and forward-only migrations.
 * Both core and the broker gateway use this; neither imports the other.
 */
export type Migration = { id: string; up: string };

export type Db = {
  raw: DatabaseSync;
  path: string;
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  transaction<T>(fn: () => T): T;
  close(): void;
};

export function openDatabase(path: string, opts: { readOnly?: boolean } = {}): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path, { readOnly: opts.readOnly ?? false });
  if (!opts.readOnly) {
    raw.exec("PRAGMA journal_mode = WAL;");
    raw.exec("PRAGMA synchronous = FULL;");
  }
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec("PRAGMA busy_timeout = 5000;");
  return {
    raw,
    path,
    exec: (sql) => {
      raw.exec(sql);
    },
    prepare: (sql) => raw.prepare(sql),
    transaction: <T>(fn: () => T): T => {
      raw.exec("BEGIN IMMEDIATE;");
      try {
        const result = fn();
        raw.exec("COMMIT;");
        return result;
      } catch (err) {
        raw.exec("ROLLBACK;");
        throw err;
      }
    },
    close: () => {
      raw.close();
    },
  };
}

/** Apply migrations in order. Each id is applied at most once; a changed body for an applied id is an error. */
export function migrate(db: Db, migrations: readonly Migration[]): { applied: string[] } {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, body_sha256 TEXT NOT NULL, applied_at TEXT NOT NULL);",
  );
  const applied: string[] = [];
  const seen = db.prepare("SELECT body_sha256 FROM schema_migrations WHERE id = ?");
  const record = db.prepare("INSERT INTO schema_migrations (id, body_sha256, applied_at) VALUES (?, ?, ?)");
  for (const m of migrations) {
    const bodyHash = createHash("sha256").update(m.up).digest("hex");
    const row = seen.get(m.id) as { body_sha256: string } | undefined;
    if (row) {
      if (row.body_sha256 !== bodyHash) throw new Error(`Migration ${m.id} was modified after being applied`);
      continue;
    }
    db.transaction(() => {
      db.exec(m.up);
      record.run(m.id, bodyHash, new Date().toISOString());
    });
    applied.push(m.id);
  }
  return { applied };
}

export function integrityCheck(db: Db): { ok: boolean; messages: string[] } {
  const rows = db.prepare("PRAGMA integrity_check;").all() as { integrity_check: string }[];
  const messages = rows.map((r) => r.integrity_check);
  return { ok: messages.length === 1 && messages[0] === "ok", messages };
}

/** WAL-safe online backup. VACUUM INTO writes a consistent snapshot without stopping writers. */
export function backupTo(db: Db, destinationPath: string): void {
  mkdirSync(dirname(destinationPath), { recursive: true });
  db.prepare("VACUUM INTO ?").run(destinationPath);
}

export function walCheckpoint(db: Db): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
}
