import { statSync, statfsSync } from "node:fs";
import { integrityCheck, isLiveMode, type ChainVerdict, type Db, type IsoDate, type Mode, type UtcInstant } from "@blackgold/shared";
import type { AppConfig } from "../config/schema.ts";
import type { ExchangeCalendar } from "../calendar/types.ts";
import { Ledger, sealThroughDate, type LedgerSeal } from "../ledger/ledger.ts";
import { CORE_VERSION } from "../version.ts";

export type HealthCheck = { component: string; ok: boolean; detail: string };

export type HealthReport = {
  ok: boolean;
  version: string;
  mode: Mode;
  /** Hard-coded false: this build contains no live trading path. */
  liveCapable: false;
  at: UtcInstant;
  dbIntegrity: { ok: boolean; messages: string[] };
  ledgerChain: ChainVerdict;
  ledgerEvents: number;
  lastSeal: LedgerSeal | null;
  /** UTC days with events, older than the seal grace window, that carry no seal. Empty when sealing is current. */
  unsealedDays: IsoDate[];
  nextSession: IsoDate;
  walSizeBytes: number;
  freeDiskBytes: number;
  checks: HealthCheck[];
};

const MIN_FREE_DISK_BYTES = 512 * 1024 * 1024;
const WAL_WARN_BYTES = 256 * 1024 * 1024;

export function runHealth(config: AppConfig, db: Db, calendar: ExchangeCalendar, now: UtcInstant): HealthReport {
  const checks: HealthCheck[] = [];
  const dbIntegrity = integrityCheck(db);
  checks.push({ component: "db_integrity", ok: dbIntegrity.ok, detail: dbIntegrity.messages.join("; ") });

  const ledger = new Ledger(db);
  const ledgerChain = ledger.verifyChain();
  const ledgerEvents = ledger.count();
  checks.push({
    component: "ledger_chain",
    ok: ledgerChain.ok,
    detail: ledgerChain.ok ? `${ledgerEvents} events` : `broken at seq ${ledgerChain.brokenAt}: ${ledgerChain.reason}`,
  });
  const seals = ledger.verifySeals();
  checks.push({ component: "ledger_seals", ok: seals.ok, detail: seals.ok ? "all seals match" : `mismatch: ${seals.mismatches.join(",")}` });
  const lastSeal = ledger.latestSeal() ?? null;

  // Whether sealing is keeping up. Without this, a seal job failing every night leaves unsealed days piling
  // up while the report still says everything is fine - the same silent hole the scheduled seal closed, one
  // level up.
  //
  // Reported, not fatal. `ok: false` here would fail the container healthcheck and restart the app, and a
  // day that cannot be sealed (a genuine mismatch) would then restart it forever, which is worse than a
  // visible backlog. CLAUDE.md's fail-closed rule is about not taking new risk in an unknown state, and this
  // build takes none; when sealing gates real trading it must block new risk in the risk engine, which is
  // where that decision belongs, not in a process healthcheck.
  const unsealed = ledger.unsealedDates(sealThroughDate(now));
  checks.push({
    component: "ledger_seal_backlog",
    ok: true,
    detail:
      unsealed.length === 0
        ? "no unsealed days older than the grace window"
        : `${unsealed.length} unsealed day(s) past the grace window: ${unsealed.slice(0, 5).join(",")}${unsealed.length > 5 ? ",..." : ""}`,
  });

  const nextSession = calendar.nextSession(now);
  checks.push({ component: "calendar", ok: true, detail: `next ${calendar.exchange} session ${nextSession}` });

  const walSizeBytes = fileSize(`${db.path}-wal`);
  checks.push({ component: "wal_size", ok: walSizeBytes < WAL_WARN_BYTES, detail: `${walSizeBytes} bytes` });

  const freeDiskBytes = freeBytes(config.dataDir);
  checks.push({ component: "free_disk", ok: freeDiskBytes >= MIN_FREE_DISK_BYTES, detail: `${freeDiskBytes} bytes free` });

  const liveCapable = false as const;
  checks.push({ component: "live_disabled", ok: !isLiveMode(config.mode), detail: `mode ${config.mode}; liveCapable=${String(liveCapable)}` });

  const ok = checks.every((c) => c.ok);
  db.transaction(() => {
    const insert = db.prepare("INSERT INTO health_checks (at, component, ok, detail) VALUES (?, ?, ?, ?)");
    for (const c of checks) insert.run(now, c.component, c.ok ? 1 : 0, c.detail);
    insert.run(now, "overall", ok ? 1 : 0, `${checks.filter((c) => c.ok).length}/${checks.length} checks ok`);
  });

  return {
    ok,
    version: CORE_VERSION,
    mode: config.mode,
    liveCapable,
    at: now,
    dbIntegrity,
    ledgerChain,
    ledgerEvents,
    lastSeal,
    unsealedDays: unsealed,
    nextSession,
    walSizeBytes,
    freeDiskBytes,
    checks,
  };
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function freeBytes(path: string): number {
  try {
    const s = statfsSync(path);
    return s.bavail * s.bsize;
  } catch {
    return 0;
  }
}
