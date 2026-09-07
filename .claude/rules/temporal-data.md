---
paths:
  - "packages/data/**"
  - "packages/research/**"
  - "src/data/**"
  - "src/research/**"
  - "src/backtest/**"
  - "strategies/**"
---

# Point-in-time and research rules

- Every observation implements `PointInTimeObservation<T>` with `availableAt`, `ingestedAt`, `rawContentHash`, `adapterVersion`, and `parserVersion` populated. `observedAt`, `effectiveAt`, and `vintageAt` are populated when the source has them.
- A decision at `decisionAt` may read only records where `availableAt + processingDelay <= decisionAt`. Add a test for every new query path.
- SEC data uses the acceptance timestamp, not the period or transaction date. FRED historical reads use `realtime_start`/`realtime_end` vintages. COT uses Friday release time, not Tuesday position date. 13F is research context only unless a registered charter models the lag.
- Raw, unadjusted prices drive execution simulation. Adjusted total-return series drive performance. Never mix them in one calculation.
- Universe membership is queried by date from stored snapshots. A current constituent list used for a historical decision is a defect.
- Experiments are registered before results are viewed. A changed parameter, prompt, model, or hypothesis after viewing is a new experiment id. Never overwrite a result. The final holdout opens once and is logged.
- Time-ordered splits only. Purge and embargo overlapping horizons.
- Historical LLM replay is labelled contaminated. It is never primary promotion evidence.
- LLM output fields are research (`ResearchAssessment`). They contain no account, size, order type, or stop price. Confidence never feeds sizing.
- Money, price, quantity, and return aggregation use decimal arithmetic.
