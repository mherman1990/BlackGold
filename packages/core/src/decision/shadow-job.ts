import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addDays, addMs, sha256Hex, type IsoDate } from "@blackgold/shared";
import { processingDelayOverridesMs, RestrictedListConfigSchema, RiskConfigSchema, ThemeMembershipConfigSchema, type AppConfig } from "../config/schema.ts";
import { parseYamlConfig } from "../config/load.ts";
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

/**
 * One operative policy file, read ONCE: the same bytes are parsed and hashed (Codex P2 - two reads could
 * straddle an operator replacing a bind-mounted file, sealing a decision under one byte-state while recording
 * the hash of another; the whole point of the hash is exact attribution).
 */
function readPolicyFile<T>(dir: string, file: string, parse: (text: string, label: string) => T): { value: T; hash: string } {
  const path = join(dir, file);
  const bytes = readFileSync(path);
  return { value: parse(bytes.toString("utf8"), path), hash: `sha256:${sha256Hex(bytes)}` };
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

  // The schedule offset is DERIVED from the charter (Codex P2): a fixed offset smaller than the charter's
  // decision_offset_minutes would fire before the decision instant, consume the scheduler's idempotency key on
  // a successful skip, and leave that week's records permanently missing. Loading here also fails a
  // misconfigured path loudly at startup instead of at the first close. The 150-minute floor keeps the job
  // behind the nightly ingest (close + 90 min); the +30 buffer absorbs scheduler polling delay.
  const registeredOffsetMinutes = loadCharterFile(charterPath).charter.rules.decision_offset_minutes;
  const jobOffsetMinutes = Math.max(150, registeredOffsetMinutes + 30);

  scheduler.register({
    jobId: "shadow_decision",
    name: "Seal the prospective shadow decision records for the configured charter",
    schedule: { kind: "after_close", offsetMs: jobOffsetMinutes * 60_000 },
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

      // Rung order is enforced in code, not prose (Codex P1, round 3): ALPHA_CHARTER section 14.2 dates the
      // prospective record "from registration", and D-53 says rung-2 sealing cannot precede the rung-1
      // experiment. No experiment registered for THIS charter hash means no sealing - the job skips, visibly.
      // (Whether sealing should additionally wait for the owner's ACTIVE acceptance - the section 17 reading -
      // is the open clock-start question in docs/analysis/2026-09-21-rung5-decision-packet.md; tightening this
      // gate to that reading is one line once the owner decides. This gate only ever fails closed vs. none.)
      const registeredExperiments = (
        ctx.db.prepare("SELECT COUNT(*) AS n FROM experiments WHERE json_extract(definition_json, '$.charter_hash') = ?").get(loaded.charterHash) as { n: number }
      ).n;
      if (registeredExperiments === 0) {
        ctx.ledger.append(
          SHADOW_DECISION_SKIPPED,
          { scheduledFor: ctx.scheduledFor, session, charterHash: loaded.charterHash, reason: "no registered experiment for this charter hash; rung-2 sealing cannot precede the rung-1 registration (D-53)" },
          ctx.now,
        );
        return;
      }

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
      const risk = readPolicyFile(config.shadow.policyDir, "risk.yaml", (t, l) => parseYamlConfig(t, RiskConfigSchema, l));
      const restricted = readPolicyFile(config.shadow.policyDir, "restricted-list.yaml", (t, l) => parseYamlConfig(t, RestrictedListConfigSchema, l));
      const membership = readPolicyFile(config.shadow.policyDir, "theme-membership.yaml", (t, l) => parseYamlConfig(t, ThemeMembershipConfigSchema, l));

      const pit = new PointInTimeRepository(ctx.db, { processingDelayOverrides: processingDelayOverridesMs(config.sources) });
      const entityMap = new EntityMap(ctx.db);
      entityMap.syncFromRepository(pit, decisionAt);
      // Bring the map up to date from the ingested corporate-action observations first (Codex P1): in
      // production, symbol changes arrive as `corporate_action.SYMBOL_CHANGE` rows, and a map that is never
      // synced resolves nothing - which would silently drop the very ticker history identity relies on. The
      // sync is knowledge-scoped to the decision instant, so a change recorded later cannot reach back.

      // Identity carries the entity's FULL ticker history known by the decision instant, not just today's
      // symbol (Codex P1): the compliance engine matches restricted-list entries by identifier, and a list
      // keyed by an issuer's old ticker must still catch it after a symbol change. The resolved stable id and
      // the aliases go into `identifiers`, NOT into `SymbolIdentity.entityId`: the decision gate binds
      // compliance coverage by canonical key (`entityId ?? symbol`), and the target book is keyed by the
      // charter symbol - an entity id differing from the book key would make every mapped holding read as
      // MISSING_COMPLIANCE and block clean new risk (Codex P1, round 2).
      const identity = (symbol: string): SymbolIdentity => {
        const stableId = entityMap.resolve(symbol, session, { knownAt: decisionAt });
        const aliases = stableId === undefined ? [] : entityMap.symbolsFor(stableId, { knownAt: decisionAt });
        return { identifiers: [...new Set([symbol, ...aliases, ...(stableId === undefined ? [] : [stableId])])].sort(), entityId: undefined };
      };
      const lookThrough = storedLookThroughResolver(pit, membership.value, restricted.value, {
        decisionAt,
        lookThroughScope: charter.universe.look_through_flagged,
        resolveEntityId: entityMapResolver(entityMap, decisionAt),
      });

      // Unapproved policy content is missing owner content, not an operative policy (Codex P1, round 3): the
      // baked examples are fake, and a restricted list that restricts nothing REAL would otherwise let B1 clear
      // the gate on placeholder compliance. Each unapproved file enters the halt machine as a stale input, so
      // every arm seals with new risk blocked and the reason on the record - honest, and it lifts the moment
      // the owner's signed files replace the examples (a config act, no code change).
      const unapprovedPolicies: string[] = [];
      if (risk.value.approvedBy === null) unapprovedPolicies.push("policy_unapproved:risk.yaml");
      if (restricted.value.approvedBy === null) unapprovedPolicies.push("policy_unapproved:restricted-list.yaml");
      if (membership.value.approvedBy === null) unapprovedPolicies.push("policy_unapproved:theme-membership.yaml");

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
        ...(unapprovedPolicies.length === 0 ? {} : { staleInputs: unapprovedPolicies }),
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
          unapprovedPolicies,
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
