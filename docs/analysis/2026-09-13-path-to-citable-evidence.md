# Path to citable evidence for etf-trend-vol (2026-09-13)

The 2026-09-13 machinery check
(`docs/analysis/2026-09-13-etf-trend-vol-machinery-check.md`) ran with
`citableAsEvidence: false` / `promotionBlockingCodes: [UNVERIFIED_SINGLE_SOURCE]`.
This note records, from the code, exactly what that blocker is and how to clear
it. The headline: **the blocker is the corporate-actions data path, not the
daily-bars vendor.** Clearing it needs data curation with existing tooling — no
code change.

## Where the label actually comes from

`UNVERIFIED_SINGLE_SOURCE` is a corporate-action code, not a bars code:

- The Tiingo corporate-actions adapter stamps it on **every** dividend/split
  unconditionally (`packages/core/src/data/adapters/tiingo-corporate-actions.ts:117`).
  The automated Tiingo actions path (D-49) can therefore *never* be promotion
  evidence, by construction.
- The backtest folds any promotion-blocking action-row flag into the run's
  labels (`packages/core/src/research/backtest.ts:226-231`), because a NAV or
  benchmark series that credits a single-source dividend must carry that label.
- Daily bars are never flagged single-source. They carry their own quality
  codes — `STALE_BAR`, `GAP`, `OUTLIER` (`packages/core/src/data/quality.ts`).
  A second bars vendor would not change `citableAsEvidence`.

So a Tiingo-bars run that credits Tiingo dividends is uncitable *because of the
dividends*. Swapping or adding a bars source does nothing for citability.

## The one path that clears it (existing tooling, no code change)

The only promotion-eligible corporate-action source is an operator-curated
vendored file, ingested with:

```
ingest corporate-actions --file <path.json>
```

The flag is cleared per entry, and only when the entry names **≥2 distinct
sources**: `new Set(entry.sources).size >= 2`
(`packages/core/src/data/adapters/corporate-actions.ts:105`). One source keeps
the flag; two or more reconciled sources clear it. Format and validation are in
`config/examples/corporate-actions.example.json` (the same parser the read path
uses validates on ingest).

Entry shape (illustrative — not reconciled data):

```json
{
  "action": {
    "kind": "CASH_DIVIDEND",
    "entityId": "VTI",
    "amount": "0.7500",
    "exDate": "2018-12-24",
    "payDate": "2018-12-27",
    "qualified": true
  },
  "announcedAt": "2018-12-20T14:30:00Z",
  "sources": ["issuer:vanguard-distributions", "exchange:nasdaq-corporate-actions"]
}
```

`announcedAt` is optional; the store forbids `availableAt` earlier than the
ex-date, so an earlier announcement is clamped up to the ex-date start.

## Scope of the curation (owner work)

This is the real cost, and it is data work, not engineering:

- **Instruments:** the 12-ETF risk universe + BIL (cash) + the primary
  benchmark (VTI) — every entity whose dividends/splits enter a NAV or benchmark
  series in a run.
- **Actions:** all cash dividends and any splits/spin-offs over the window(s)
  being evaluated. For a citable DESIGN run that is 2007-06-01 → 2018-12-31; for
  RECENT, 2025-01-01 → present. (The holdout window is deliberately out of scope
  here — opening it is a separate, one-time, owner-only act.)
- **Reconciliation:** each action agreed across ≥2 independent public sources —
  e.g. the issuer's distribution notices (Vanguard, SSGA) and an exchange
  corporate-action feed (NYSE Arca / Nasdaq) — with both named in `sources`.
- Broad-based ETF distributions are quarterly, so DESIGN is on the order of a
  few hundred dividend entries plus a handful of structural actions (e.g. the
  2015 XLF→XLRE spin-off already used as a fixture).

Once ingested, a run that reads reconciled actions instead of the Tiingo
automated actions drops `UNVERIFIED_SINGLE_SOURCE`. The Tiingo actions can
remain in the store — the read path collapses to the reconciled rows per the
usual vintage/latest rules — but the clean citable path is to rely on the
reconciled file for the entities and dates under evaluation.

## What still gates a citable, promotable result after that

Clearing the data label is necessary, not sufficient. Independent of the data:

1. **Signed 0.2.0 charter** (D-50, currently Proposed) — an owner act — before a
   registered experiment exists on this strategy version.
2. **Citing any run as promotion evidence is owner-only** (a standing carve-out).
   Claude Code may compute and report; it may not declare a run to be evidence.
3. **In-sample is still in-sample.** A citable DESIGN run is citable *machinery*,
   not proof of edge. The evidential test is the **sealed holdout**, opened once,
   by the owner, deliberately.

## A second bars source is a different thing (optional, not this)

If cross-checking the *bars* themselves is ever wanted, note it is **net-new
code**, not a config toggle, and it does **not** affect the current citability
blocker:

- Two bars sources already coexist in the store without collision — observations
  are keyed by `source_id` (`packages/core/src/data/pit/repository.ts:89-94`), so
  `tiingo.eod.bars.1d` and `alpaca.iex.bars.1d` never conflict. Alpaca is already
  wired (`BLACKGOLD_ALPACA_KEY_ID`/`_SECRET_KEY`, `ingest alpaca-bars …`).
- But nothing compares two bars series. Making a disagreement mean something
  would require: a bars cross-source verifier, a new bar-level quality code
  registered in `quality.ts`, and wiring in `coverage.ts`/`backtest.ts` to fold
  it into `promotionBlockingCodes` the way action flags are folded today. That is
  a separate, reviewed change — worth doing for data-integrity confidence, but
  not the path to clearing the current label.

## Recommendation

To make a citable run possible, the next concrete step is **owner-side
corporate-action curation** for the universe over the evaluation window, ingested
via `ingest corporate-actions --file`. No code change is required for that path.
Everything downstream (charter signature, holdout, evidence citation) remains an
owner act by design.
