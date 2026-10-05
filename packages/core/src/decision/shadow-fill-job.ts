import { addMs, Dec, ZERO, type Arm, type IsoDate, type UtcInstant } from "@blackgold/shared";
import { processingDelayOverridesMs, type AppConfig } from "../config/schema.ts";
import type { ExchangeCalendar } from "../calendar/types.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { PointInTimeRepository } from "../data/pit/repository.ts";
import { loadCharterFile } from "../strategy/charter.ts";
import { costsFromCharter, loadExecutionSeries, type EntitySeries, type ExecutionSeriesInput } from "../research/backtest.ts";
import { dailyNavSeries, type PortfolioEvent } from "../research/nav.ts";
import { sealsProspectiveDecisions, type ProspectiveDecisionRecord } from "./decision-record.ts";
import {
  appendShadowFillRecord,
  counterfactualFills,
  shadowFillRecords,
  SHADOW_INITIAL_CASH,
  type ShadowFillRecord,
} from "./shadow-fills.ts";
import { DEFAULT_MAX_FILL_BARS } from "../research/simulator.ts";
import { fillDueSession, reconcileShadow } from "./shadow-reconcile.ts";

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
  const jobOffsetMinutes = Math.max(150, registeredOffsetMinutes + 30);

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

      // The simulator works a remainder across up to DEFAULT_MAX_FILL_BARS bars starting at the first fill
      // attempt; the last of those is this many sessions after the decision. A record finalized before the
      // whole window has completed could seal a LIQUIDITY remainder bars it never saw might have filled - and
      // the append-only ledger forbids correcting it (Codex P1, PR #102). Finalization is therefore deferred
      // for a remainder that more bars could still change; see below.
      const fillWindowEnd = (decisionSession: IsoDate): IsoDate => fillDueSession(calendar, decisionSession, costs.delayBars + DEFAULT_MAX_FILL_BARS - 1);

      // The entity universe the replay and the pending fills touch: every target the sealed records carry plus
      // everything a prior fill ever traded. Loaded through the backtest's OWN execution-series loader, as of
      // the run's scheduled instant.
      const entities = new Set<string>();
      for (const row of sealedRows) {
        const rec = JSON.parse(row.record_json) as ProspectiveDecisionRecord;
        for (const w of rec.targetWeights) entities.add(w.entityId);
      }
      for (const f of priorFills) for (const fill of f.fills) entities.add(fill.entityId);

      const firstSession = decisionSessionOf(sealedRows[0]?.decision_at ?? ctx.scheduledFor);
      const seriesInput: ExecutionSeriesInput = {
        pit: new PointInTimeRepository(ctx.db, { processingDelayOverrides: processingDelayOverridesMs(config.sources) }),
        calendar,
        from: firstSession,
        to: session,
        // The default bars source, exactly like the decision job's feature reads (no override is configured).
      };
      const series = new Map<string, EntitySeries>();
      for (const e of [...entities].sort()) series.set(e, loadExecutionSeries(seriesInput, e, ctx.scheduledFor));

      const closesAt = (s: IsoDate): Map<string, Dec> => {
        const m = new Map<string, Dec>();
        for (const [entityId, es] of series) {
          let found: Dec | undefined;
          for (const b of es.bars) {
            if (b.session <= s) found = b.close;
            else break;
          }
          if (found !== undefined) m.set(entityId, found);
        }
        return m;
      };

      // Corporate-action identity, split, and delisting events, exactly as runBacktest emits them. Dividends
      // are NOT emitted here: their credit depends on the arm's own ex-date holding, so they are built per arm
      // inside `replayArm` with the entitlement attached.
      const actionEvents: PortfolioEvent[] = [];
      const dividends: { entityId: string; amountPerShare: Dec; exDate: IsoDate; payDate: IsoDate }[] = [];
      const splits: { entityId: string; ratio: Dec; exDate: IsoDate }[] = [];
      for (const [entityId, es] of series) {
        for (const a of es.actions) {
          if (a.kind === "CASH_DIVIDEND") dividends.push({ entityId, amountPerShare: a.amount, exDate: a.exDate, payDate: a.payDate });
          if (a.kind === "SPLIT") {
            actionEvents.push({ type: "SPLIT", entityId, ratio: a.ratio, exDate: a.exDate });
            splits.push({ entityId, ratio: a.ratio, exDate: a.exDate });
          }
          if (a.kind === "DELISTING") actionEvents.push({ type: "DELISTING", entityId, finalPrice: a.finalPrice, session: a.lastTradeDate });
        }
      }

      // The quantity an arm held going INTO `exDate` (fills and splits strictly before it, splits first on a
      // shared date), which is the dividend-entitled quantity. Passing the pay-date position instead would
      // credit income to shares bought between ex and pay dates and strip it from shares sold there
      // (Codex P1, PR #102) - `dailyNavSeries` only defaults that way when no entitlement is supplied.
      const entitledQuantity = (fillsForArm: readonly ShadowFillRecord[], entityId: string, exDate: IsoDate): Dec => {
        const evs: { date: IsoDate; rank: number; apply: (q: Dec) => Dec }[] = [];
        for (const f of fillsForArm) {
          for (const fill of f.fills) {
            if (fill.entityId !== entityId) continue;
            const qty = new Dec(fill.quantity);
            evs.push({ date: fill.session, rank: 1, apply: (q) => (fill.side === "BUY" ? q.plus(qty) : q.minus(qty)) });
          }
        }
        for (const s of splits) {
          // A same-date split applies before the fill, matching the replay's own ordering (post-split units).
          if (s.entityId === entityId) evs.push({ date: s.exDate, rank: 0, apply: (q) => q.times(s.ratio) });
        }
        evs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.rank - b.rank));
        let q = ZERO;
        for (const e of evs) {
          if (e.date >= exDate) break;
          q = e.apply(q);
        }
        return q;
      };

      /** Replay one arm's synthetic book from its append-only fill records, through `toSession` inclusive. */
      const replayArm = (arm: Arm, fillsForArm: readonly ShadowFillRecord[], toSession: IsoDate) => {
        const events: PortfolioEvent[] = [...actionEvents];
        for (const d of dividends) {
          events.push({ type: "DIVIDEND", entityId: d.entityId, amountPerShare: d.amountPerShare, payDate: d.payDate, entitledQuantity: entitledQuantity(fillsForArm, d.entityId, d.exDate) });
        }
        for (const f of fillsForArm) {
          for (const fill of f.fills) {
            events.push({ type: "FILL", entityId: fill.entityId, side: fill.side, quantity: new Dec(fill.quantity), price: new Dec(fill.price), fees: new Dec(fill.fees), session: fill.session });
          }
        }
        const sessions = calendar.sessionDates(firstSession, toSession);
        return dailyNavSeries({ initialCash: SHADOW_INITIAL_CASH, events, sessions, closes: closesAt });
      };

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
          const replay = replayArm(row.arm, armFills, decisionSession);
          const mark = replay.points.find((p) => p.session === decisionSession) ?? replay.points.at(-1);
          const positions = new Map<string, Dec>();
          for (const [entityId, pos] of replay.portfolio.positions) if (!pos.quantity.isZero()) positions.set(entityId, pos.quantity);
          const bars = new Map([...series].map(([entityId, es]) => [entityId, es.bars] as const));
          const fillRecord = counterfactualFills({
            record,
            decisionRecordHash: row.record_hash,
            decisionSession,
            computedAt: ctx.now,
            book: { positions, cash: replay.portfolio.cash, nav: mark?.nav ?? ZERO },
            bars,
            prices: closesAt(decisionSession),
            costs,
            bandPctPoints,
          });
          // Defer a record whose remainder later bars could still fill: LIQUIDITY and NO_BARS remainders are
          // only final once the simulator's whole fill window has completed (a CASH remainder is the book's
          // own arithmetic - more bars cannot change it, so it finalizes immediately). The query-driven
          // selection re-processes the decision on a later run; nothing is persisted for it now.
          if (fillRecord.unfilled.some((u) => u.reason !== "CASH") && fillWindowEnd(decisionSession) > session) {
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
          const points = replayArm(arm, allFills.filter((f) => f.arm === arm), session).points;
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
