import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addDays, addMs, canonicalJson, sha256Hex, type IsoDate } from "@blackgold/shared";
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

      // The originating session is recovered by INVERTING the schedule, never reconstructed from the shifted
      // timestamp (Codex P2, round 7): `scheduledFor` is exactly `sessionClose(session) + jobOffset`, so
      // subtracting the offset lands on that close and `previousSession` (last session whose close <= instant)
      // returns the session that generated the run. `previousSession(ctx.scheduledFor)` instead returns
      // whatever session closed most recently before the RUN - for a schema-valid decision offset that carries
      // the run past a later session's close (the offset is unbounded), that is the wrong session, and the
      // weekly gate would silently drop the Friday decision forever.
      const session = calendar.previousSession(addMs(ctx.scheduledFor, -jobOffsetMinutes * 60_000));
      if (!isWeeklyDecisionSession(calendar, session)) {
        // Not the charter's cadence: nothing to seal. Silent by design - a ledger row per non-decision session
        // would be noise; "zero missing decision records" is checked against the weekly schedule, not job runs.
        return;
      }

      const loaded = loadCharterFile(charterPath);
      const charter = loaded.charter;

      const decisionAt = addMs(calendar.sessionClose(session), charter.rules.decision_offset_minutes * 60_000);

      // Rung order is enforced in code, not prose (Codex P1, round 3): ALPHA_CHARTER section 14.2 dates the
      // prospective record "from registration", and D-53 says rung-2 sealing cannot precede the rung-1
      // experiment. The registration must exist AT the decision instant, not merely by the time the delayed
      // job runs (Codex P1, round 5) - a registration landing between close+offset and the run would otherwise
      // retroactively manufacture a prospective record timestamped before rung 1 began. No qualifying
      // registration means no sealing - the job skips, visibly.
      // (Whether sealing should additionally wait for the owner's ACTIVE acceptance - the section 17 reading -
      // is the open clock-start question in docs/analysis/2026-09-21-rung5-decision-packet.md; tightening this
      // gate to that reading is one line once the owner decides. This gate only ever fails closed vs. none.)
      const registeredExperiments = (
        ctx.db
          .prepare("SELECT COUNT(*) AS n FROM experiments WHERE json_extract(definition_json, '$.charter.charter_hash') = ? AND registered_at <= ?")
          .get(loaded.charterHash, decisionAt) as { n: number }
      ).n;
      if (registeredExperiments === 0) {
        ctx.ledger.append(
          SHADOW_DECISION_SKIPPED,
          { scheduledFor: ctx.scheduledFor, session, decisionAt, charterHash: loaded.charterHash, reason: "no experiment registered for this charter hash at the decision instant; rung-2 sealing cannot precede the rung-1 registration (D-53)" },
          ctx.now,
        );
        return;
      }

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
      // Approval means a real signature KNOWN AT THE DECISION INSTANT: a non-empty signer AND a timestamp that
      // exists and is not after decisionAt (Codex P1, rounds 4-5). Comparing against the run instant instead
      // would let an approval landing between close+offset and the delayed run count for a decision that is
      // timestamp-locked to before it existed. Compared as parsed instants, not strings: lexically,
      // "T21:00:00Z" sorts AFTER the equal instant "T21:00:00.000Z", so a string compare would reject an
      // approval signed at exactly the decision instant just for omitting fractional seconds (Codex P2, round 6).
      const decisionAtMs = Date.parse(decisionAt);
      const approved = (v: { approvedBy: string | null; approvedAt: string | null }): boolean =>
        v.approvedBy !== null && v.approvedBy.trim().length > 0 && v.approvedAt !== null && Date.parse(v.approvedAt) <= decisionAtMs;
      const unapprovedPolicies: string[] = [];
      if (!approved(risk.value)) unapprovedPolicies.push("policy_unapproved:risk.yaml");
      if (!approved(restricted.value)) unapprovedPolicies.push("policy_unapproved:restricted-list.yaml");
      if (!approved(membership.value)) unapprovedPolicies.push("policy_unapproved:theme-membership.yaml");
      // A policy snapshot DATED after the decision instant was not operative at it (Codex P1, round 8): the
      // compliance engine treats a future restricted-list asOf as fresh (a negative age never exceeds the
      // maximum) and the look-through path consumes future-dated membership content with no date check of its
      // own, so an accidental or staged future file could admit new risk on information the timestamp-locked
      // decision could not have had. Either future date is a stale input like an unapproved file: the arms
      // still seal, honestly blocked. (risk.yaml carries no asOf; its signature timestamp is checked above.)
      const futureDated = (asOf: string): boolean => Date.parse(`${asOf}T00:00:00.000Z`) > decisionAtMs;
      if (futureDated(restricted.value.asOf)) unapprovedPolicies.push("policy_future_dated:restricted-list.yaml");
      if (futureDated(membership.value.asOf)) unapprovedPolicies.push("policy_future_dated:theme-membership.yaml");


      const records = shadowDecisionRecords(charter, {
        mode: config.mode,
        charterHash: loaded.charterHash,
        policyHashes: { risk_yaml: risk.hash, restricted_list_yaml: restricted.hash, theme_membership_yaml: membership.hash },
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
            // The instant is immutable: something already sealed this arm (e.g. an operator run). Skipping it
            // is safe ONLY when the existing record is CONTENT-IDENTICAL to the one this run just derived,
            // `sealedAt` aside (Codex P2, rounds 7-8) - charter hash and mode alone are not enough, because the
            // decision row does not persist policy hashes, so a same-charter run under different policy files
            // would otherwise complete a "synchronized" pair whose arms saw different inputs while the ledger
            // event attributes both to the current policies. Comparing the whole derived record covers every
            // input that reaches the decision (gate verdict, blocked reasons - the policy approval labels
            // included - target book, snapshot bindings). A mismatch fails the whole run (the transaction rolls
            // back: no partial pair, no misattributing event).
            const existing = ctx.db
              .prepare("SELECT record_json FROM decision_records WHERE strategy_id = ? AND strategy_version = ? AND arm = ? AND decision_at = ?")
              .get(record.strategyId, record.strategyVersion, record.arm, record.decisionAt) as { record_json: string } | undefined;
            const contentOf = (r: object): string => canonicalJson({ ...(r as Record<string, unknown>), sealedAt: null });
            if (existing === undefined || contentOf(JSON.parse(existing.record_json) as object) !== contentOf(record)) {
              throw new Error(
                `arm ${record.arm} at ${record.decisionAt} is already sealed with different content ` +
                  `(this run derived charter ${loaded.charterHash}, mode ${config.mode}); refusing to complete a mismatched arm pair`,
              );
            }
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
