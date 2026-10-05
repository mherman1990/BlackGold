import { addMs, Dec, ZERO, type Arm, type IsoDate, type UtcInstant } from "@blackgold/shared";
import { processingDelayOverridesMs, type AppConfig } from "../config/schema.ts";
import type { ExchangeCalendar } from "../calendar/types.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { PointInTimeRepository } from "../data/pit/repository.ts";
import { loadCharterFile } from "../strategy/charter.ts";
import { costsFromCharter } from "../research/backtest.ts";
import { sealsProspectiveDecisions, type ProspectiveDecisionRecord } from "./decision-record.ts";
import { appendShadowFillRecord, counterfactualFills, fillWindowObserved, shadowFillRecords, type ShadowFillRecord } from "./shadow-fills.ts";
import { DEFAULT_MAX_FILL_BARS } from "../research/simulator.ts";
import { fillDueSession, fillOwedSession, reconcileShadow } from "./shadow-reconcile.ts";
import { closesAt, loadShadowReplayInputs, replayShadowArm } from "./shadow-book.ts";
import { shadowJobOffsetMinutes } from "./shadow-job.ts";

/**
 * The mode-gated `after_close` counterfactual fill + reconcile job (D-53 slice 3b): the scheduler seam that
 * turns each SEALED prospective decision record into its deterministic simulated outcome, and continuously
 * measures the shadow ledgers for breaks. Composes only existing deterministic machinery - the backtest's own
 * execution-series loader, the internal simulator via `counterfactualFills`, and the NAV replay - and touches
 * no broker, order, account, or model (threat model T-05).
 *
 *  - **Query-driven catch-up, not session-keyed work.** Each run processes EVERY sealed decision of the
 *    configured charter whose fill-due session has completed and which has no fill record yet. A decision
 *    sealed late (multi-day decision offsets), a skipped run, or a down host is caught up on the next run;
 *    the fill ledger's unique index, not the scheduler's idempotency key, is what prevents double-recording.
 *  - **The book is replayed, never carried.** The synthetic shadow book at each decision mark is derived from
 *    the append-only fill records plus the point-in-time corporate actions through the same `dailyNavSeries`
 *    replay the backtest's accounting uses (splits before same-day fills, dividends on pay date). No mutable
 *    book state is persisted anywhere.
 *  - **Fills are outcomes, so they read AFTER the decision on purpose.** The execution series is loaded as of
 *    the run's scheduled instant, exactly as `runBacktest` loads it as of the window end; the temporal
 *    invariant here is that no fill may precede its decision, which the simulator's delay enforces.
 *  - **Reconciliation always runs** once anything is sealed, whether or not new fills were recorded, and the
 *    breaks land in the ledger (`shadow.reconciled`; plus one `shadow.incident` event when any break exists).
 *    Breaks are recorded, not auto-acted-on: feeding them into the next decision's halt input is a later,
 *    explicitly-reviewed step, because an automatic feedback loop between the two shadow jobs is itself a
 *    financial-critical change.
 */

export const SHADOW_FILLS_RECORDED = "shadow.fills_recorded";
export const SHADOW_RECONCILED = "shadow.reconciled";
export const SHADOW_INCIDENT = "shadow.incident";

/** The arms the shadow loop seals (prospectiveTargetBooks): a session is complete only when each is present. */
const SHADOW_ARMS: readonly Arm[] = ["B0_PASSIVE", "B1_DETERMINISTIC"];

type SealedRow = { decision_at: UtcInstant; arm: Arm; record_json: string; record_hash: string };

/**
 * Register the shadow counterfactual fill job. Gated exactly like the shadow decision job: a configured
 * shadow charter AND a mode that seals prospective decisions - RESEARCH/BACKTEST processes never carry it.
 */
export function registerShadowFillJob(scheduler: Scheduler, deps: { config: AppConfig; calendar: ExchangeCalendar }): void {
  const { config, calendar } = deps;
  const charterPath = config.shadow.charterPath;
  if (charterPath === undefined || charterPath === "") return;
  if (!sealsProspectiveDecisions(config.mode)) return;

  // The schedule offset is derived from the charter EXACTLY like the decision job's (Codex P2, PR #102): a
  // fixed 150-minute offset would run reconciliation BEFORE a charter with decision_offset_minutes > 120 has
  // sealed that session's records, emitting a phantom MISSING_DECISION_RECORD incident every decision week.
  // With equal offsets the scheduler executes same-instant runs in jobId order, and "shadow_decision" sorts
  // before "shadow_fill", so the decision run always precedes this one.
  const registeredOffsetMinutes = loadCharterFile(charterPath).charter.rules.decision_offset_minutes;
  const jobOffsetMinutes = shadowJobOffsetMinutes(registeredOffsetMinutes);

  scheduler.register({
    jobId: "shadow_fill",
    name: "Record counterfactual fills for sealed shadow decisions and reconcile the shadow ledgers",
    schedule: { kind: "after_close", offsetMs: jobOffsetMinutes * 60_000 },
    deadlineMs: 10 * 60_000,
    handler: (ctx) => {
      if (!sealsProspectiveDecisions(config.mode)) return;

      // The originating session, by inverting the schedule (never from the run time; Codex P2, round 7 on the
      // decision job). Work selection is query-driven, so this session only bounds "which fills are due".
      const session = calendar.previousSession(addMs(ctx.scheduledFor, -jobOffsetMinutes * 60_000));

      const loaded = loadCharterFile(charterPath);
      const charter = loaded.charter;
      const offsetMinutes = charter.rules.decision_offset_minutes;
      // Same guard as the decision job: a charter file replaced mid-process with a different offset would both
      // desynchronize this job from the decision job's schedule and mis-invert the session above. Fail loudly;
      // the remedy is a restart, which re-derives both schedules from the charter.
      if (offsetMinutes !== registeredOffsetMinutes) {
        throw new Error(
          `charter decision_offset_minutes changed from ${registeredOffsetMinutes} (the registered schedule) to ${offsetMinutes}; ` +
            "restart the process so the schedule matches the charter",
        );
      }
      const costs = costsFromCharter(charter, "base");
      const bandPctPoints = new Dec(charter.rules.rebalance_band_pct_points);

      // Every sealed decision of THIS charter (the hash scopes strategy id and version with it).
      const sealedRows = ctx.db
        .prepare("SELECT decision_at, arm, record_json, record_hash FROM decision_records WHERE charter_hash = ? ORDER BY decision_at, arm")
        .all(loaded.charterHash) as SealedRow[];
      if (sealedRows.length === 0) return; // nothing sealed yet: nothing to fill, nothing to reconcile

      // The decision session is recovered by inverting the sealed instant with the record's own charter offset
      // (the hash filter guarantees the loaded offset IS the sealing charter's).
      const decisionSessionOf = (decisionAt: UtcInstant): IsoDate => calendar.previousSession(addMs(decisionAt, -offsetMinutes * 60_000));

      const strategyId = charter.strategy_id;
      const strategyVersion = charter.charter_version;
      const priorFills = shadowFillRecords(ctx.db, strategyId, strategyVersion);
      const recorded = new Set(priorFills.map((f) => `${f.arm}|${f.decisionAt}`));

      const pending = sealedRows.filter((r) => !recorded.has(`${r.arm}|${r.decision_at}`) && fillDueSession(calendar, decisionSessionOf(r.decision_at), costs.delayBars) <= session);

      // The entity universe the replay and the pending fills touch: every target the sealed records carry plus
      // everything a prior fill ever traded. Loaded through the backtest's OWN execution-series loader, as of
      // the run's scheduled instant (shadow-book.ts, shared with the decision job).
      const entities = new Set<string>();
      for (const row of sealedRows) {
        const rec = JSON.parse(row.record_json) as ProspectiveDecisionRecord;
        for (const w of rec.targetWeights) entities.add(w.entityId);
      }
      for (const f of priorFills) for (const fill of f.fills) entities.add(fill.entityId);

      const replayInputs = loadShadowReplayInputs({
        pit: new PointInTimeRepository(ctx.db, { processingDelayOverrides: processingDelayOverridesMs(config.sources) }),
        calendar,
        entities,
        from: decisionSessionOf(sealedRows[0]?.decision_at ?? ctx.scheduledFor),
        to: session,
        asOf: ctx.scheduledFor,
      });
      const replayArm = (fillsForArm: readonly ShadowFillRecord[], toSession: IsoDate) => replayShadowArm(replayInputs, fillsForArm, toSession);
      const bars = new Map([...replayInputs.series].map(([entityId, es]) => [entityId, es.bars] as const));

      const allFills = [...priorFills];
      const newRecords: { arm: Arm; decisionAt: UtcInstant; hash: string; fills: number; suppressed: number; unfilled: number }[] = [];

      ctx.db.transaction(() => {
        // Oldest decision first, so each replay sees every earlier outcome, including ones from this run. Once
        // one of an arm's decisions is deferred, that arm's LATER pending decisions must wait too: their book
        // replay would otherwise miss the deferred decision's eventual fills and seal a mark derived from a
        // history that is still changing.
        const deferredArms = new Set<Arm>();
        for (const row of [...pending].sort((a, b) => (a.decision_at < b.decision_at ? -1 : a.decision_at > b.decision_at ? 1 : a.arm < b.arm ? -1 : 1))) {
          if (deferredArms.has(row.arm)) continue;
          const record = JSON.parse(row.record_json) as ProspectiveDecisionRecord;
          const decisionSession = decisionSessionOf(row.decision_at);
          const armFills = allFills.filter((f) => f.arm === row.arm);
          const replay = replayArm(armFills, decisionSession);
          const mark = replay.points.find((p) => p.session === decisionSession) ?? replay.points.at(-1);
          const positions = new Map<string, Dec>();
          for (const [entityId, pos] of replay.portfolio.positions) if (!pos.quantity.isZero()) positions.set(entityId, pos.quantity);
          const fillRecord = counterfactualFills({
            record,
            decisionRecordHash: row.record_hash,
            decisionSession,
            computedAt: ctx.now,
            book: { positions, cash: replay.portfolio.cash, nav: mark?.nav ?? ZERO },
            bars,
            prices: closesAt(replayInputs, decisionSession),
            costs,
            bandPctPoints,
            splits: replayInputs.splits,
            maxFillBars: DEFAULT_MAX_FILL_BARS,
          });
          // Defer a record whose remainder later bars could still fill: a LIQUIDITY or NO_BARS remainder is only
          // final once the entity's OWN bars cover the simulator's window (Codex P1, PR #102 round 3 - the
          // simulator advances over bars, not sessions), or once the shared owed bound is reached, after which
          // the remainder is sealed as a break rather than stalling the arm forever. A CASH remainder is the
          // book's own arithmetic - more bars cannot change it, so it finalizes immediately. The query-driven
          // selection re-processes a deferred decision on a later run; nothing is persisted for it now.
          const windowOpen = fillRecord.unfilled.some((u) => u.reason !== "CASH" && !fillWindowObserved(bars.get(u.entityId), decisionSession, costs.delayBars, DEFAULT_MAX_FILL_BARS));
          if (windowOpen && fillOwedSession(calendar, decisionSession, costs.delayBars, DEFAULT_MAX_FILL_BARS) > session) {
            deferredArms.add(row.arm);
            continue;
          }
          const { hash } = appendShadowFillRecord(ctx.db, fillRecord);
          allFills.push(fillRecord);
          newRecords.push({ arm: row.arm, decisionAt: row.decision_at, hash, fills: fillRecord.fills.length, suppressed: fillRecord.suppressedEntries.length, unfilled: fillRecord.unfilled.length });
        }

        if (newRecords.length > 0) {
          ctx.ledger.append(
            SHADOW_FILLS_RECORDED,
            { scheduledFor: ctx.scheduledFor, session, strategyId, strategyVersion, charterHash: loaded.charterHash, recorded: newRecords },
            ctx.now,
          );
        }

        // Reconcile over the WHOLE ledger state including this run's records, every run.
        const bookCash = new Map<string, { session: IsoDate; cash: Dec }[]>();
        for (const arm of SHADOW_ARMS) {
          const points = replayArm(allFills.filter((f) => f.arm === arm), session).points;
          bookCash.set(arm, points.map((p) => ({ session: p.session, cash: p.cash })));
        }
        const breaks = reconcileShadow({
          calendar,
          arms: SHADOW_ARMS,
          sealed: sealedRows.map((r) => ({ arm: r.arm, decisionAt: r.decision_at, decisionSession: decisionSessionOf(r.decision_at) })),
          fillRecords: allFills,
          throughSession: session,
          delayBars: costs.delayBars,
          maxFillBars: DEFAULT_MAX_FILL_BARS,
          bookCash,
        });
        ctx.ledger.append(
          SHADOW_RECONCILED,
          { scheduledFor: ctx.scheduledFor, session, strategyId, strategyVersion, charterHash: loaded.charterHash, breaks, sealedCount: sealedRows.length, fillRecordCount: allFills.length },
          ctx.now,
        );
        if (breaks.length > 0) {
          ctx.ledger.append(SHADOW_INCIDENT, { scheduledFor: ctx.scheduledFor, session, strategyId, strategyVersion, kind: "SHADOW_RECONCILE_BREAKS", breaks }, ctx.now);
        }
      });
    },
  });
}
