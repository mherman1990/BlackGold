# Alpaca API capability register

Accessed 2026-09-06 from first-party documentation. Alpaca is proposed as the Phase 5 paper broker only (D-25). Live Alpaca is not planned.

## Verified

| ID | Claim | Source | Consequence for Black Gold |
|---|---|---|---|
| ALP-01 | Paper trading does not account for: market impact, information leakage of orders, price slippage due to latency, order queue position for non-marketable limits, price improvement, regulatory fees, dividends | https://docs.alpaca.markets/docs/paper-trading | Black Gold's internal conservative fill/cost model and total-return dividend accounting are mandatory alongside paper fills |
| ALP-02 | Paper endpoint is `https://paper-api.alpaca.markets`; paper accounts are created and deleted rather than reset, and new API keys are needed for a new account | same | Config holds a paper base URL distinct from live; a paper reset is a documented runbook step that invalidates keys |
| ALP-03 | Paper accounts do not send fill emails | same | Notifications come from Black Gold's reconciler, not the broker |
| ALP-04 | `client_order_id` is accepted; auto-generated if the client omits it | https://docs.alpaca.markets/docs/orders-at-alpaca | Black Gold always supplies a deterministic id |
| ALP-05 | Order classes: bracket (entry with take-profit and stop-loss, one exit cancels the other), OCO, OTO | same | Native protection construct exists; atomicity is not claimed by the docs and is not assumed |
| ALP-06 | Time in force: `day`, `gtc`, `opg`, `cls`, `ioc`, `fok`; GTC orders auto-cancelled after 90 days | same | Protective GTC stops must be re-issued before day 90; scheduler tracks age |
| ALP-07 | Fractional orders are `day` only | same | Black Gold uses whole shares; fractional is rejected by the risk engine |
| ALP-08 | Extended hours requires limit orders with `day` or `gtc` | same | Black Gold never sets `extended_hours: true`; gateway rejects it |
| ALP-09 | `partially_filled` status exists; on a bracket, partial take-profit fill adjusts stop-loss quantity | same | Order state machine models `PARTIALLY_FILLED` and child quantity changes |
| ALP-10 | Order replacement (PATCH) is supported; bracket/OCO legs allow `limit_price`/`stop_price` updates; notional orders cannot be replaced | same | Black Gold uses `qty`, never `notional`, so replace is available for protective legs |

## UNVERIFIED (probe in Phase 5)

| ID | Question | Probe |
|---|---|---|
| ALP-11 | Does a duplicate `client_order_id` return the existing order (idempotent) or an error? | Submit the same id twice on paper with a far-from-market limit; record response; cancel |
| ALP-12 | Free market data entitlement is IEX-only; SIP requires subscription | Read market-data docs; inspect account entitlement; label every bar with venue |
| ALP-13 | Exact rate limits (requests/minute) and `429` headers | Read docs; observe headers |
| ALP-14 | Streaming trade updates via WebSocket for paper | Read docs; connect read-only |
| ALP-15 | Corporate-action handling in paper positions (splits, symbol changes) | Read docs; observe across a known split if one occurs |
| ALP-16 | Paper fill price rule (last trade vs. quote) and behaviour at open/close | Read docs; compare paper fills with Black Gold's conservative model over the Phase 5 window |
