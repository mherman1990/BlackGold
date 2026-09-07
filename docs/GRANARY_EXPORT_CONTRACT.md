# Granary export contract (proposed design)

**Status:** Proposed, 2026-09-07, by Claude Code. Design only — no code exists yet and none is authorized by this
document. It specifies the read-only surface Black Gold would expose for **Granary** (`mherman1990/Granary`, the
separate household planning product that sits above Black Gold, see **D-40**) to consume. Building it is Phase 4/5
work and needs Matt's authorization; the open decisions in section 9 are his.

This document is authoritative across sessions for *how* the two products may connect. It does not widen any
boundary; it is a specific application of boundaries Black Gold already enforces.

## 1. The one hard idea

**Black Gold exports weights and states. It never exports dollars or account identifiers. Granary supplies the
dollar denominator itself.**

Granary is the household book of record. It already holds the sleeve account's balance as one line in Matt's
household picture (from Matt's own entry or his brokerage export — Granary's data, never Black Gold's). So Granary
does not need Black Gold to tell it how many dollars the sleeve is worth. What Granary needs from Black Gold is the
sleeve's *composition and posture* — which instruments at what fraction of sleeve NAV, which arm decided what, the
risk and evidence state — all of which is expressible without a single dollar figure or account number. Granary
multiplies Black Gold's exported weights by the sleeve balance it already knows to get dollar exposures for
household allocation. The dollar arithmetic happens entirely on Granary's side.

This is not a convenience. It is what lets the export reuse Black Gold's existing **redaction-at-serialization**
guard unchanged (section 7), so the contract is safe by construction rather than by reviewer vigilance.

## 2. Why the direction is one-way

Granary reads Black Gold. Black Gold never reads, calls, imports, or depends on Granary. Concretely:

- No Granary identifier, port (`granary`/3000), path, image, schema, credential, or line of code enters this
  repository — the standing "this repository contains Black Gold only" rule, and the mirror of Granary's own
  isolation rule (`AGENTS.md`: it may not increase Black Gold authority or rely on Black Gold's uncommitted state).
- No shared SQLite file, volume, secret, port, release, or Umbrel identity. Black Gold stays `blackgold-trading`
  on 8479; the two apps' data directories are disjoint.
- The export is **pull-based**: Black Gold writes a read-only artifact to its own data directory (or serves it
  read-only on 8479); Granary fetches a copy. Black Gold exposes no endpoint that Granary (or anything) can POST
  to. There is no inbound path, so there is no inbound attack surface — the risk of the integration sits entirely
  on Granary's side of the boundary, where Granary's own rules already place it.

This is the same asymmetry the threat model already assumes for household data (A3): the household picture may be
*read into* Black Gold's risk gate someday (F13, read-only, encrypted, never in dollar form to a model), but the
sleeve never reaches back into the household book. Granary inverts nothing here; it consumes an export.

## 3. What crosses (the export payload)

A single versioned JSON document, produced from the local store in one pass by the same builder family as
`StatusReport` (`packages/core/src/status/model.ts`). Every field is a count, date, hash, state, name, or a
**fraction in `[0,1]`** — never a dollar amount, never an account reference.

| Field group | Example fields | Form | Why it is safe to export |
|---|---|---|---|
| Contract envelope | `contractVersion`, `generatedAt`, `codeCommit`, `appVersion` | string / instant / hash | Metadata; no protected value |
| Sleeve composition | per instrument: `symbol`, `targetWeight`, `actualWeight` (fractions of sleeve NAV), `arm` (`B0`/`B1`/`C1`/`D1`) | fraction in `[0,1]`, symbol, label | Weights, not dollars; symbols are public tickers; Granary applies its own dollar balance |
| Cash posture | `cashWeight`, `cashInstrument` (e.g. `BIL`) | fraction, symbol | Fraction only |
| Risk state | `riskState` (`NORMAL` / `HALT_NEW_RISK` / `HOLD_ONLY`), `reArmRequired`, `drawdownState` | enum / bool | States, not balances; lets Granary reflect a halt without knowing sums |
| Data health | per source: `sourceId` prefix, `latestAvailableAt`, `staleDays`, `staleBlocksNewRisk` | name / date / count / bool | Identical to what the status page already exposes |
| Evidence state | `experiments`, `trials`, `resultsViewed`, `holdoutsOpened`, `promotionEvidenceClaimed`, `charterRegistrable` | counts / bool | Counts only; phrased so it cannot imply evidence that does not exist |
| Integrity | `ledgerSealedThrough` (date), `ledgerRootHash` (sealed daily root), `snapshotIds` | date / hash / ids | Hash and ids are already copied off-device by design (A5) |

`targetWeight`/`actualWeight` are the sleeve's own internal fractions and sum to ≤ 1 with `cashWeight`. They carry
no information about the sleeve's absolute size, and none about any non-sleeve account.

## 4. What never crosses

Hard exclusions, enforced by the serialization guard in section 7 — not left to the caller to remember:

- **No dollar amounts.** Not sleeve NAV, not position dollar values, not fill prices in a form that reconstructs a
  dollar exposure, not fees, not P&L in currency. (Percentage return may be exported; a dollar return may not.)
- **No account identifiers.** No account number, no account hash, no `blackgold_sleeve` account id, no broker
  account reference of any kind.
- **No household data.** Black Gold does not hold Granary's household picture and never re-exports A3 data; the
  export is sleeve-only and flows the other way.
- **No secrets or credentials.** No keys, tokens, User-Agent contacts, or config secrets — the same scan that
  guards the repo (`check:secrets`) and the runtime guard apply.
- **No order, transfer, or mutation surface.** The export is a document, not an API. It contains nothing that
  could form or route an `OrderIntent`, and there is no method on it that mutates anything (the same type-level
  absence that `ReadOnlyAccountView` already guarantees, T-01/T-22/T-05).

## 5. How it is produced and consumed

- **Produced:** a new `buildHouseholdExport(db)` in the `status`/export module, returning a typed
  `HouseholdExport` object, serialized through the redaction guard, and written to
  `${APP_DATA_DIR}/exports/household-export.json` (runtime data, gitignored) on the existing post-close schedule.
  It reads only the local store — no broker, no model, no network — exactly like `buildStatusReport`.
- **Served (optional):** the read-only status service on 8479 may add a `GET /export/household.json` route that
  returns the same document. Read-only; no write route is added.
- **Consumed:** Granary pulls the file or the URL on its own cadence, over Tailscale, read-only, and validates it
  against a copy of the schema it vendors. Per Granary's Phase 6/7 plan it first runs this against a **mock** of
  this contract (no real Black Gold dependency); a real fetch is a separately gated Granary step. Nothing in Black
  Gold changes for Granary to switch from mock to real — the artifact is identical.

## 6. Failure and staleness semantics

- Unknown or stale state fails closed for Granary the same way it does for Black Gold. `staleBlocksNewRisk` and
  `riskState` are exported so Granary can see when the sleeve is halted or its data is stale, and treat the
  composition as not-current rather than silently trusting an old file.
- `generatedAt` and `ledgerSealedThrough` let Granary detect a stale export (Black Gold down, schedule missed) and
  degrade explicitly — an unknown weight is never rendered as zero on either side.
- The export is a snapshot, not a stream. It carries no promise of real-time freshness; Granary treats it as
  as-of `generatedAt`.

## 7. Why this is safe by construction

The export inherits guarantees Black Gold already has, rather than adding new trust:

- **Redaction at serialization (T-21, T-22).** Black Gold already has off-device report types that *fail to
  serialize* when a dollar total, account hash, or secret pattern is present (the evidence packet F2, the status
  report). `HouseholdExport` is registered as one more such type, so a future field that tried to smuggle a dollar
  amount or account id would fail its own serialization test, not ship.
- **The status-page precedent.** `packages/core/src/status/model.ts` already documents the rule that a surface
  reached over Tailscale is a surface that leaves the device, and carries "counts, dates, hashes and states only."
  The export is the machine-readable sibling of that page and obeys the identical rule.
- **F13 direction.** The threat model already states non-sleeve/household values "never reach F2 or F8 in dollar
  form." The export extends the same no-dollar-off-device rule to a new consumer without exception.
- **Account isolation (T-01).** The export names instruments, never accounts, so it cannot leak which account is
  the sleeve or address any other account.
- **No new inbound path.** Because the contract is pull-only and write-free, it adds no route that could be used to
  place an order, change a restriction, or clear a halt — those stay Umbrel-local and authenticated (F12).

The net effect: if Granary — or anything that intercepts the file over Tailscale — is fully compromised, it learns
the sleeve's instrument weights and operational state. It learns no dollar figure, no account number, no secret,
and gains no ability to act on the sleeve. That is the intended blast radius.

## 8. Versioning and stability

- `contractVersion` is semver and independent of Black Gold's app version. A field addition that stays backward
  compatible bumps the minor; a removal or a meaning change bumps the major and Granary must opt in.
- The document is additive-friendly: Granary ignores unknown fields, and Black Gold never repurposes a field name.
- A change to what a weight *means* (e.g. gross vs. net of cash) is a major bump, treated with the same care as a
  strategy-version change, because Granary's dollar math depends on the definition.

## 9. Open decisions for Matt

None of these is Claude Code's to settle; they shape the contract before any code is written.

1. **Transport.** File-on-disk that Granary reads over a shared read path, or an HTTP `GET` on 8479? Recommendation:
   the read-only `GET` — it keeps Black Gold's data directory private to Black Gold and matches the existing status
   service, with no new write surface.
2. **Granularity of composition.** Per-instrument weights only, or also per-arm (`B0`/`B1`/`C1`/`D1`) target vs.
   actual? Recommendation: per-arm, since the household view benefits from seeing the deterministic book separately
   from any model-influenced arm — but it is strictly more information leaving the device, so it is your call.
3. **Return reporting.** Export percentage return series (safe) at all, or keep the export to current composition
   and state only? Recommendation: percentage-only if included; never a dollar return.
4. **Cadence and retention.** How often the export is regenerated, and whether Black Gold keeps a history of past
   exports or only the latest. Recommendation: regenerate post-close with the daily seal; keep only the latest on
   Black Gold's side (Granary keeps its own history if it wants one).
5. **Whether to build it now.** This is Phase 4/5 work. It can be built as a self-contained, dollar-free export
   ahead of the rest of Phase 4 because it depends on nothing that needs the charter signed — but it should still
   be one bounded PR, authorized on its own, not chained onto unrelated work.
