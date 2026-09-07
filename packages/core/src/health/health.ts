import { statSync, statfsSync } from "node:fs";
import { isLiveMode, type ChainVerdict, type Db, type IsoDate, type Mode, type UtcInstant } from "@blackgold/shared";
import type { AppConfig } from "../config/schema.ts";
import type { ExchangeCalendar } from "../calendar/types.ts";
import { Ledger, sealThroughDate, type LedgerSeal } from "../ledger/ledger.ts";
import { FULL_VERIFICATION_STALE_MS, readLastFullVerification, type FullVerification } from "./integrity.ts";
import { CORE_VERSION } from "../version.ts";

export type HealthCheck = { component: string; ok: boolean; detail: string };

export type HealthReport = {
  ok: boolean;
  version: string;
  mode: Mode;
  /** Hard-coded false: this build contains no live trading path. */
  liveCapable: false;
  at: UtcInstant;
  /** DB integrity as of the last full verification (moved off the hot path); pending until the first run. */
  dbIntegrity: { ok: boolean; messages: string[] };
  /** Hot-path verdict: the unsealed tail only (`Ledger.verifyChainSinceLastSeal`). The frozen prefix is covered by `lastFullVerification`. */
  ledgerChain: ChainVerdict;
  /** Last scheduled/startup full verification (whole chain + seals + DB integrity), or null before the first run. */
  lastFullVerification: FullVerification | null;
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
  const ledger = new Ledger(db);

  // Hot path: verify only the unsealed tail. The full chain + seals + DB integrity_check are O(store size) and
  // this probe runs on every request (the container healthcheck every 60 s), which becomes a restart-loop-class
  // cost at volume (HANDOFF.md §7). The full suite runs on a schedule and at serve() startup and is reported
  // below via `lastFullVerification`; a tamper in the sealed prefix is still caught there, only less often.
  const ledgerChain = ledger.verifyChainSinceLastSeal();
  const ledgerEvents = ledger.count();
  checks.push({
    component: "ledger_chain",
    ok: ledgerChain.ok,
    detail: ledgerChain.ok ? `${ledgerEvents} events; unsealed tail intact` : `broken at seq ${ledgerChain.brokenAt}: ${ledgerChain.reason}`,
  });

  const lastFull = readLastFullVerification(db);
  const fullStale = lastFull !== null && Date.parse(now) - Date.parse(lastFull.at) > FULL_VERIFICATION_STALE_MS;
  // A genuine recorded failure stays fatal to the probe, exactly as the inline full check was before this
  // split. A missing record (fresh install, before the first run) or a stale one (the job stopped) is
  // reported but not fatal: failing the container probe on it would restart-loop the app rather than surface
  // the problem - the same reasoning the seal-backlog check documents below. The unsealed tail, which is the
  // live "new risk" surface, is still checked fatally above.
  checks.push({
    component: "full_verification",
    ok: lastFull === null ? true : lastFull.ok,
    detail:
      lastFull === null
        ? "no full verification recorded yet (runs at startup and daily)"
        : `${lastFull.ok ? "clear" : "FAILED"} at ${lastFull.at}${fullStale ? " (stale)" : ""}: ${lastFull.detail}`,
  });
  const dbIntegrity =
    lastFull === null
      ? { ok: true, messages: ["no full verification recorded yet"] }
      : { ok: lastFull.integrityOk, messages: [`db integrity from full verification at ${lastFull.at}`] };
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
    lastFullVerification: lastFull,
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
