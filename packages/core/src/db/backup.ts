import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  backupTo,
  integrityCheck,
  openDatabase,
  type ChainVerdict,
  type Db,
  type UtcInstant,
} from "@blackgold/shared";
import { Ledger, type LedgerSeal } from "../ledger/ledger.ts";

export type BackupResult = { path: string; ok: boolean; bytes: number; messages: string[] };

const BACKUP_FILE_RE = /^blackgold-(\d{4})(\d{2})(\d{2})T(\d{6})Z\.sqlite$/;

/** File name for a backup taken at `now`: blackgold-YYYYMMDDTHHMMSSZ.sqlite */
export function backupFileName(now: UtcInstant): string {
  const compact = now.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `blackgold-${compact}.sqlite`;
}

/** Online backup via VACUUM INTO, then integrity-check the copy before reporting success. */
export function backupDatabase(db: Db, backupsDir: string, now: UtcInstant): BackupResult {
  const path = join(backupsDir, backupFileName(now));
  backupTo(db, path);
  const copy = openDatabase(path, { readOnly: true });
  try {
    const check = integrityCheck(copy);
    return { path, ok: check.ok, bytes: statSync(path).size, messages: check.messages };
  } finally {
    copy.close();
  }
}

export type PruneResult = { kept: string[]; deleted: string[] };

/**
 * Keep the newest backup of each of the most recent `keepDaily` calendar days and of each of the most
 * recent `keepWeekly` ISO weeks; delete other files that match the backup name pattern. Files that do not
 * match the pattern are never touched. This deletes backup FILES only; audit rows are never deleted.
 */
export function pruneBackups(dir: string, keepDaily = 7, keepWeekly = 4): PruneResult {
  const entries = readdirSync(dir)
    .map((name) => ({ name, m: BACKUP_FILE_RE.exec(name) }))
    .filter((e): e is { name: string; m: RegExpExecArray } => e.m !== null)
    .map((e) => ({ name: e.name, day: `${e.m[1] ?? ""}-${e.m[2] ?? ""}-${e.m[3] ?? ""}`, stamp: e.name }))
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0)); // newest first

  const keep = new Set<string>();
  const newestPerDay = new Map<string, string>();
  const newestPerWeek = new Map<string, string>();
  for (const e of entries) {
    if (!newestPerDay.has(e.day)) newestPerDay.set(e.day, e.name);
    const week = isoWeekKey(e.day);
    if (!newestPerWeek.has(week)) newestPerWeek.set(week, e.name);
  }
  for (const name of [...newestPerDay.values()].slice(0, keepDaily)) keep.add(name);
  for (const name of [...newestPerWeek.values()].slice(0, keepWeekly)) keep.add(name);

  const kept: string[] = [];
  const deleted: string[] = [];
  for (const e of entries) {
    if (keep.has(e.name)) {
      kept.push(e.name);
    } else {
      unlinkSync(join(dir, e.name));
      deleted.push(e.name);
    }
  }
  return { kept, deleted };
}

/** ISO-8601 week key (e.g. 2026-W36) for a YYYY-MM-DD date. */
export function isoWeekKey(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dayNum = d.getUTCDay() || 7; // Monday=1 ... Sunday=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${week.toString().padStart(2, "0")}`;
}

export type RestoreReport = {
  ok: boolean;
  backupPath: string;
  integrity: { ok: boolean; messages: string[] };
  chain: ChainVerdict;
  seals: { ok: boolean; mismatches: string[] };
  eventCount: number;
  latestSeal: LedgerSeal | null;
};

/** Restore drill: copy the backup to a temp dir, open it, and verify integrity, the hash chain, and the seals. */
export function verifyRestore(backupPath: string): RestoreReport {
  const dir = mkdtempSync(join(tmpdir(), "blackgold-restore-"));
  const copyPath = join(dir, basename(backupPath));
  copyFileSync(backupPath, copyPath);
  const db = openDatabase(copyPath);
  try {
    const integrity = integrityCheck(db);
    const ledger = new Ledger(db);
    const chain = ledger.verifyChain();
    const seals = ledger.verifySeals();
    return {
      ok: integrity.ok && chain.ok && seals.ok,
      backupPath,
      integrity,
      chain,
      seals,
      eventCount: ledger.count(),
      latestSeal: ledger.latestSeal() ?? null,
    };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
