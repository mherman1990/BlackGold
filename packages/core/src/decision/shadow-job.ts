import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addDays, addMs, sha256Hex, type IsoDate } from "@blackgold/shared";
import { processingDelayOverridesMs, RestrictedListConfigSchema, RiskConfigSchema, ThemeMembershipConfigSchema, type AppConfig } from "../config/schema.ts";
import { loadYamlConfig } from "../config/load.ts";
import type { ExchangeCalendar } from "../calendar/types.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { PointInTimeRepository } from "../data/pit/repository.ts";
import { EntityMap } from "../market/entity-map.ts";
import { loadCharterFile } from "../strategy/charter.ts";
import { weeklyDecisionSessions } from "../research/backtest.ts";
import { entityMapResolver, storedLookThroughResolver } from "../compliance/theme-membership.ts";
import { sealsProspectiveDecisions } from "./decision-record.ts";
import { appendDecisionRecord, DecisionAlreadySealedError } from "./decision-record.ts";
import { shadowDecisionRecords, type SymbolIdentity } from "./shadow-decision.ts";

/**
 * The mode-gated `after_close` shadow decision job (D-53 slice 2c): the scheduler seam that resolves what the
 * pure slice-2b function (`shadowDecisionRecords`) deliberately takes as inputs - the charter, the operative
 * policy files, the point-in-time read surface, and the decision instant - and persists each sealed record.
 *
 * Everything financially meaningful stays in the pure layers this job composes; the job itself only decides
 * WHEN to run and WHAT to load:
 *
 *  - **Mode-gated twice.** The job is registered only when the running mode seals prospective decisions
 *    (SHADOW/PAPER), and the handler re-checks before doing anything - `appendDecisionRecord`'s own mode guard
 *    is still behind both. RESEARCH and BACKTEST processes never even register it.
 *  - **Opt-in.** `BLACKGOLD_SHADOW_CHARTER` names the charter; unset, nothing is registered. Both the mode and
 *    the charter path are environment-only configuration (compose-level, the owner's), never `secrets.env`.
 *  - **The operative policy files are baked into the image** at a fixed directory (Matt's 2026-09-14 call):
 *    the Dockerfile ships `config/examples` at `config/examples` in the image and `BLACKGOLD_POLICY_DIR`
 *    points there by default. The tracked examples are FAKE, so an image run without the owner's real content
 *    still fails closed for B1 new risk (placeholder restricted list + theme membership block, they never
 *    admit). Each run hashes the three files it read and records the hashes in the ledger event, so every
 *    sealed decision is attributable to an exact policy byte-state - the same discipline `LIVE_AUTHORIZATION`
 *    applies to `risk_yaml`.
 *  - **The charter's own cadence decides the instant.** Decisions seal only on a weekly decision session (the
 *    last session of the exchange week, `weeklyDecisionSessions` - the identical rule `runBacktest` uses), at
 *    `sessionClose + rules.decision_offset_minutes`: the registered decision instant, not the time the job
 *    happened to run. Every read is `asOf` that instant, so running late never lets later data in.
 *  - **Append-only, idempotent.** A record already sealed for the instant is recorded as skipped, never
 *    overwritten (`DecisionAlreadySealedError`); a re-run after a crash cannot rewrite history.
 *
 * No broker, no order, no account, no model anywhere in this path (threat model T-05).
 */

/** Where the shadow job's ledger events land. */
export const SHADOW_DECISION_SEALED = "shadow.decision_sealed";
export const SHADOW_DECISION_SKIPPED = "shadow.decision_skipped";

/**
 * True when `session` is a weekly decision session: the last session of its exchange week, by the exact rule
 * the backtest uses. The two-week window guarantees the following session is present for the comparison.
 */
export function isWeeklyDecisionSession(calendar: ExchangeCalendar, session: IsoDate): boolean {
  return weeklyDecisionSessions(calendar, session, addDays(session, 13))[0] === session;
}

/** One operative policy file: its parsed config is used, its raw bytes are hashed for the ledger record. */
function readPolicyFile<T>(dir: string, file: string, parse: (path: string) => T): { value: T; hash: string } {
  const path = join(dir, file);
  const value = parse(path);
  return { value, hash: `sha256:${sha256Hex(readFileSync(path))}` };
}

/**
 * Register the shadow decision job. No-op unless a shadow charter is configured AND the mode seals prospective
 * decisions - a RESEARCH or BACKTEST process must not even carry the job. Runs after each session close, late
 * enough (150 min) that the nightly incremental ingest (close + 90 min) has landed; the decision instant itself
 * stays the charter's registered `close + decision_offset_minutes` regardless of when the job runs.
 */
export function registerShadowDecisionJob(scheduler: Scheduler, deps: { config: AppConfig; calendar: ExchangeCalendar }): void {
  const { config, calendar } = deps;
  const charterPath = config.shadow.charterPath;
  if (charterPath === undefined || charterPath === "") return;

  if (!sealsProspectiveDecisions(config.mode)) return;

  scheduler.register({
    jobId: "shadow_decision",
    name: "Seal the prospective shadow decision records for the configured charter",
    schedule: { kind: "after_close", offsetMs: 150 * 60_000 },
    deadlineMs: 10 * 60_000,
    handler: (ctx) => {
      // Defence in depth: the registration gate above already excludes non-sealing modes, and the sealer
      // itself refuses them, but a job must never rely on its registration site alone.
      if (!sealsProspectiveDecisions(config.mode)) return;

      const session = calendar.previousSession(ctx.scheduledFor);
      if (!isWeeklyDecisionSession(calendar, session)) {
        // Not the charter's cadence: nothing to seal. Silent by design - a ledger row per non-decision session
        // would be noise; "zero missing decision records" is checked against the weekly schedule, not job runs.
        return;
      }

      const loaded = loadCharterFile(charterPath);
      const charter = loaded.charter;
      const decisionAt = addMs(calendar.sessionClose(session), charter.rules.decision_offset_minutes * 60_000);
      if (ctx.now < decisionAt) {
        // The job fired before the charter's decision instant (offsets misconfigured). Sealing now would
        // timestamp-lock reads to an instant that has not happened; fail closed and say so.
        ctx.ledger.append(
          SHADOW_DECISION_SKIPPED,
          { scheduledFor: ctx.scheduledFor, session, decisionAt, reason: "job ran before the charter's decision instant; check the schedule offset" },
          ctx.now,
        );
        return;
      }

      // The operative policy files, from the fixed baked-in directory, hashed as read.
      const risk = readPolicyFile(config.shadow.policyDir, "risk.yaml", (p) => loadYamlConfig(p, RiskConfigSchema));
      const restricted = readPolicyFile(config.shadow.policyDir, "restricted-list.yaml", (p) => loadYamlConfig(p, RestrictedListConfigSchema));
      const membership = readPolicyFile(config.shadow.policyDir, "theme-membership.yaml", (p) => loadYamlConfig(p, ThemeMembershipConfigSchema));

      const pit = new PointInTimeRepository(ctx.db, { processingDelayOverrides: processingDelayOverridesMs(config.sources) });
      const entityMap = new EntityMap(ctx.db);
      // Identity carries the entity's FULL ticker history known by the decision instant, not just today's
      // symbol (Codex P1): the compliance engine matches restricted-list entries by identifier, and a list
      // keyed by an issuer's old ticker must still catch it after a symbol change.
      const identity = (symbol: string): SymbolIdentity => {
        const entityId = entityMap.resolve(symbol, session, { knownAt: decisionAt });
        const aliases = entityId === undefined ? [] : entityMap.symbolsFor(entityId, { knownAt: decisionAt });
        return { identifiers: [...new Set([symbol, ...aliases])].sort(), entityId };
      };
      const lookThrough = storedLookThroughResolver(pit, membership.value, restricted.value, {
        decisionAt,
        lookThroughScope: charter.universe.look_through_flagged,
        resolveEntityId: entityMapResolver(entityMap, decisionAt),
      });

      const records = shadowDecisionRecords(charter, {
        mode: config.mode,
        charterHash: loaded.charterHash,
        risk: risk.value,
        restrictedList: restricted.value,
        deps: { pit, calendar },
        decisionAt,
        sealedAt: ctx.now,
        identity,
        lookThrough,
      });

      // Seal all arms and the ledger event in ONE transaction (Codex P1): the scheduler claims the
      // (jobId, scheduledFor) key up front, so a crash between the first insert and the second would otherwise
      // leave one arm permanently missing with no retry. Atomicity makes the run all-or-nothing; the
      // already-sealed skip below then covers an instant sealed by some OTHER writer, not a partial self.
      const sealed: { arm: string; hash: string; newRiskAllowed: boolean }[] = [];
      const alreadySealed: string[] = [];
      ctx.db.transaction(() => {
      for (const record of records) {
        try {
          const { hash } = appendDecisionRecord(ctx.db, record);
          sealed.push({ arm: record.arm, hash, newRiskAllowed: record.gate.newRiskAllowed });
        } catch (err) {
          if (err instanceof DecisionAlreadySealedError) {
            // The instant is immutable: something already sealed this arm (e.g. an operator run). Record the
            // skip and continue with the remaining arms rather than failing the whole run.
            alreadySealed.push(record.arm);
            continue;
          }
          throw err;
        }
      }
      ctx.ledger.append(
        SHADOW_DECISION_SEALED,
        {
          scheduledFor: ctx.scheduledFor,
          session,
          decisionAt,
          mode: config.mode,
          strategyId: charter.strategy_id,
          charterVersion: charter.charter_version,
          charterHash: loaded.charterHash,
          policyHashes: { risk_yaml: risk.hash, restricted_list_yaml: restricted.hash, theme_membership_yaml: membership.hash },
          policyVersions: { risk_yaml: risk.value.version },
          sealed,
          alreadySealed,
        },
        ctx.now,
      );
      });
    },
  });
}
