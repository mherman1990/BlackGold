# Schwab Trader API capability register

**Status: every row UNVERIFIED as of 2026-09-06.** The developer portal (`https://developer.schwab.com/products/trader-api--individual`) returned HTTP 403 to an unauthenticated fetch. No Schwab-specific claim may be coded until Matt's authenticated access is used in the Phase 6 spike. Nothing below is a fact; each row is a hypothesis to test.

## Hypotheses to verify in Phase 6

| ID | Hypothesis | Why it matters | Verification method (non-live) | Result |
|---|---|---|---|---|
| SCH-01 | OAuth 2.0 authorization-code flow with a short-lived access token (order of 30 minutes) and a refresh token that expires after roughly 7 days with no rolling refresh | Determines unattended-operation feasibility; a weekly manual re-auth blocks unattended automation | Read official auth docs; perform one auth with a read-only probe; record exact lifetimes | UNVERIFIED |
| SCH-02 | The consent screen lets the user select which accounts to link | Sleeve-only linkage is the preferred blast-radius control (D-13) | Observe the consent UI; enumerate linked accounts via the accounts endpoint | UNVERIFIED |
| SCH-03 | Account numbers are exposed as hashed identifiers via a dedicated endpoint and orders reference the hash | Gateway allowlist is keyed by this hash | Read docs; call the account-numbers endpoint read-only | UNVERIFIED |
| SCH-04 | An order preview/validation endpoint exists | Enables non-live order validation in Phase 6 | Read docs; attempt preview of a 1-share limit order far from market only if documented as non-executing | UNVERIFIED |
| SCH-05 | Native conditional orders (OCO, OTO/trigger, bracket via `orderStrategyType`) exist for equities | Whether broker-native protection is available | Read docs; preview only | UNVERIFIED |
| SCH-06 | Client-supplied order ids or idempotency keys are supported | Required for `UNKNOWN`-state reconciliation | Read docs | UNVERIFIED |
| SCH-07 | Partial fills and child-order quantity adjustments are reported in order status | Order state machine correctness | Read docs; inspect recorded status JSON from a paper/preview source | UNVERIFIED |
| SCH-08 | Rate limits (requests per minute) and retry headers | Scheduler design | Read docs | UNVERIFIED |
| SCH-09 | Streaming order/fill events are available | Reconciliation latency | Read docs | UNVERIFIED |
| SCH-10 | No paper/sandbox environment exists for the individual Trader API | Phase 5 uses Alpaca paper instead (D-25) | Read docs | UNVERIFIED |
| SCH-11 | Token revocation and re-authorization behaviour on outage | Runbooks | Read docs | UNVERIFIED |
| SCH-12 | Extended-hours and fractional-share behaviour | Must be rejected by Black Gold regardless | Read docs | UNVERIFIED |
| SCH-13 | Market-data quote endpoint provides a consolidated (NBBO) quote usable immediately before an executable intent | Quote freshness rule | Read docs; read-only probe | UNVERIFIED |
| SCH-14 | The credential grants order authority on every linked account, not per account | If true, the residual blast radius must be accepted in writing (D-13) | Read docs and consent UI | UNVERIFIED |

## Rules during verification

- Read-only endpoints only until SCH-01 through SCH-14 are resolved and Matt approves the Phase 6 gateway plan.
- No live order call of any kind during capability discovery, including "test" orders.
- Record URL, access date, exact quoted claim, and sanitized evidence for each row.
- Anything still UNVERIFIED after the spike blocks Phase 7.
