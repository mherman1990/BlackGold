---
paths:
  - "packages/broker-gateway/**"
  - "src/gateway/**"
  - "src/broker/**"
  - "packages/*/src/broker/**"
---

# Broker gateway and adapter rules

- The gateway is the only process that holds a trading credential. Core never imports it and never receives the credential.
- The gateway exposes no generic HTTP proxy, no raw-JSON passthrough, and no endpoint that accepts an arbitrary broker path.
- Every inbound `OrderIntent` must carry an explicit sleeve account identifier. The gateway re-validates mode, authorization artifact, strategy version, account hash, instrument, side, quantity/notional, quote freshness, and every hard cap before any broker call. A missing or mismatched field rejects.
- Non-sleeve account access uses a separate read-only interface type with no order, cancel, replace, transfer, or mutation methods. A compile-time or construction-time test proves this.
- No withdrawal, transfer, journal, beneficiary, or profile-update endpoint is ever wrapped, even behind a flag.
- Persist intent and deterministic client-order id before the first network side effect. Timeout, connection loss, or 5xx after submission sets `UNKNOWN`; reconcile by client id or order history before any retry.
- Protective orders use the broker-native construct only where `docs/capabilities/*.md` records verified support. Never emulate protection locally and call the position protected.
- Every endpoint path, field name, token lifetime, and rate limit used must trace to a dated entry in `docs/CAPABILITY_REGISTER.md`. Unverified claims are not coded.
- Fixtures are sanitized recordings. No real account numbers, hashes, tokens, or balances in tests.
