# D-57: where a second corporate-actions source can come from

**Date:** 2026-10-06. **Author:** Claude Code. **Status:** survey for PR-B. Nothing here is decided.

D-57 lets Claude Code build a second automated corporate-actions source that is independent of Tiingo, plus a
reconciler that writes the ≥2-source file the owner signs. PR-A builds the reconciler and the signing gate.
This note records what a probe of the public issuer and exchange sources found on 2026-10-06. That probe
decides what PR-B can build, and where it cannot reach without an owner decision.

## Scope it has to cover

These figures come from `strategies/etf-trend-vol/charter.yaml`:

- **Risk universe:** VTI, QQQ, IWM, VTV, VUG, XLK, XLF, XLV, XLI, XLP, XLU, XLY.
- **Cash:** BIL.
- **Secondary benchmark:** SPY.
- **History starts** at `registered_history_start` 2007-06-01, for feature warm-up.
- **Walk-forward splits** tile 2010-06-28 → 2018-12-31. The §16.1 aggregate verdict is computed on these.
- **RECENT** runs 2025-01-01 → 2026-09-06.
- **The holdout is out of scope.**

## Verified facts

A background probe found these. Claude Code re-fetched the two marked ✔ itself and checked the stated content.

| Issuer | Endpoint | Covers | Depth | robots | Terms |
|---|---|---|---|---|---|
| State Street (SPDR) ✔ | `www.ssga.com/library-content/products/fund-data/etfs/us/spdr-etf-historical-distributions.xlsx`, one file for all SPDR funds | XLK XLF XLV XLI XLP XLU XLY, BIL, SPY | Sector funds from 1999, BIL from 2007-07, SPY from 1993 | Path allowed | Footer: no reproduction "without SSGA's express written consent" |
| Vanguard ✔ | `advisors.vanguard.com/investments/products/api/funds/{portId}/pricing/distributions` (VTI 0970, VTV 0966, VUG 0967) | VTI VTV VUG | **The latest 40 rows only.** VTI's earliest is 2016-12-20. | Allowed | Bans "repeated automated access" |
| BlackRock (iShares) | `fundDownload` for portfolioId 239710 (SpreadsheetML; malformed XML) | IWM | From 2000-06 | Allowed | **Bans robots and automated copying outright** |
| Invesco | Every distribution path returned 406 (bot protection) | QQQ | - | - | - |
| Nasdaq (exchange) | `api.nasdaq.com/api/quote/{T}/dividends?assetclass=etf` | QQQ only; NYSE Arca listings return nothing | QQQ from 2012-06-15 | **`Disallow: /`** | - |

Properties of the SSGA file that bear on the parser:

- **No splits.** The per-fund `navhist-us-en-{ticker}.xlsx` files carry unadjusted NAV and shares outstanding,
  so a split shows as a step in both.
- **Amounts are as paid, not split-adjusted.** That matches Tiingo's `divCash`.
- **Zero-amount rows exist,** for example XLK on 2007-03-16.
- **The file mixes disclaimer rows into the sheet.**
- **XLF shows two rows in September 2016:**
  - 0.114386 on 09/16/2016, the regular quarterly distribution;
  - **0.139146 on 09/19/2016**, in the same `DIVIDEND ($)` column.
  - 0.139146 is exactly the spin-off ratio the repository's example file gives the XLF → XLRE distribution.

## Inferences

1. **The 2016-09-19 XLF row is the XLRE spin-off, recorded as a share ratio, not dollars.**
   - If a parser read it as a $0.139 cash dividend, it would understate a distribution worth several dollars a
     share.
   - Under the reconciler's no-drop rule, that row would also sit beside the hand-added SPINOFF, so XLF would
     carry two distributions for one event.
   - **PR-B must exclude cash records on a structural action's ex-date and report them.** It must not convert
     them.
   - Two related points need correcting before the acceptance case is curated:
     - the example file and `docs/PHASE2_REQUIREMENTS_MATRIX.md` both date the spin-off in 2015;
     - XLRE's 2015-10-08 launch is probably the source of that date.
2. **A cash dividend for VTI, VTV, VUG or QQQ in most of the evaluated span has no automated second source.**
   - Vanguard covers 2016-12 onward and Nasdaq covers QQQ from 2012-06. Nothing found covers VTI, VTV or VUG
     for 2007-06 → 2016-11, or QQQ for 2007-06 → 2012-05.
   - The reconciler would write those dividends single-sourced, as it must, and ingest would flag them.
   - **VTI is both a universe member and the primary benchmark.** So every walk-forward run would stay
     uncitable even with SSGA fully reconciled.
   - **On automated sources alone, D-57 cannot yet produce a citable run.**
3. **SSGA is the one source an automated pipeline can use without a terms question this survey cannot settle.**
   - It is a single published file, robots allow its path, and one fetch per reconcile is not "repeated".
   - Its footer is a reproduction notice rather than an access ban. Storing a private raw artifact that is
     never redistributed is plausibly outside it, but that is a reading, and it is the owner's.

## Recommendations (proposals for PR-B)

1. **Build the SSGA adapter first.**
   - It is a single fetch of the all-funds file, plus the per-fund NAV files for split detection.
   - It covers 10 of the 14 symbols over the whole span.
   - `www.ssga.com` is already on the egress allowlist (`data/http.ts`) for the `ssga-holdings` adapter, so it
     needs no allowlist change.
2. **Design every issuer parser to read bytes, not to fetch.** The same parser then runs on:
   - a fetched artifact, where the owner accepts automated retrieval for that issuer;
   - a file the owner downloaded in a browser and passed with `--file`, where he does not.

   The second mode puts no automated access on a site whose terms forbid it. It also keeps the owner in the
   loop he already has to be in for signing.
3. **Close the Vanguard and QQQ gaps** with one of the following, in the order Claude Code recommends:
   - **(a) Owner-curated entries from the issuers' own documents.** These are the original D-29 path for
     roughly 80 dividends:
     - VTI, VTV and VUG, quarterly, 2007-06 → 2016-11;
     - QQQ, quarterly, 2007-06 → 2012-05.

     The reconciler merges them like any other source. It costs the owner real time, and it is the only option
     here whose independence is not in question.
   - **(b) SEC filings as the second source.** `sec.gov` is already allowlisted. Annual reports give per-share
     distributions per fiscal year, not per ex-date, so this would corroborate annual sums, not individual
     dividends. That would need a reconciler extension and an owner ruling that a sum check satisfies D-29.
     Not verified that the 2007-2016 filings carry the figures in a parseable form.
   - **(c) A second vendor's free dividend API.** D-57 names "issuer distribution notices or an exchange feed",
     and vendors often share an upstream feed, so independence is weak. Not recommended.

## Decisions needed from the owner

- **Which issuers may be fetched automatically.** Claude Code recommends:
  - SSGA: yes;
  - BlackRock: no (its terms ban robots outright);
  - Vanguard: no (it bans repeated automated access, and its 40-row depth makes automation worth little anyway).

  BlackRock and Vanguard would then be read from files the owner downloads.
- **How to close the 2007-2016 Vanguard and 2007-2012 QQQ gaps:** (a), (b), (c) above, or accepting that those
  spans stay uncitable.
- Whether Nasdaq's QQQ data may be used at all, given `Disallow: /`. Claude Code recommends not, and
  recommends a downloaded Invesco or owner-curated source in its place.
