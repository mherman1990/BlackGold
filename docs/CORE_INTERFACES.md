# Core TypeScript interfaces and schemas (proposal)

Sketches only. These are not implemented. They define the seams the phases build against and the properties tests must prove. Money and quantity use a `Decimal` type (fixed-point library chosen in Phase 0), never `number`. All timestamps are ISO-8601 UTC strings at the boundary and `Date`/epoch internally.

## Time and identity primitives

```ts
type UtcInstant = string;            // ISO-8601 with Z
type Decimal = import("decimal.js").Decimal; // or equivalent; never number for money
type Sha256 = string;                // lowercase hex

type Mode = "RESEARCH" | "BACKTEST" | "SHADOW" | "PAPER" | "LIVE_MANUAL" | "LIVE_LIMITED";
type HaltState = "NORMAL" | "HALT_NEW_RISK" | "HOLD_ONLY" | "EMERGENCY_FLATTEN_AUTHORIZED";
type Arm = "B0_PASSIVE" | "B1_DETERMINISTIC" | "C1_LLM_OVERLAY" | "D1_LLM_ONLY_SHADOW";
```

## Point-in-time observation (from `docs/DATA_PROVENANCE_SPEC.md`)

```ts
type PointInTimeObservation<T> = {
  sourceId: string;
  sourceLocator: string;
  entityId?: string;
  observedAt?: UtcInstant;
  effectiveAt?: UtcInstant;
  availableAt: UtcInstant;
  vintageAt?: UtcInstant;
  ingestedAt: UtcInstant;
  rawContentHash: Sha256;
  adapterVersion: string;
  parserVersion: string;
  value: T;
  qualityFlags: string[];
};

interface PointInTimeRepository {
  /** The only read path decisions may use. Enforces availableAt + processingDelay <= decisionAt. */
  asOf<T>(query: { sourceId: string; entityId?: string; decisionAt: UtcInstant; processingDelay?: string }): Promise<PointInTimeObservation<T>[]>;
  append<T>(obs: PointInTimeObservation<T>): Promise<void>;   // append-only; duplicates by hash are no-ops
}
```

## Data adapters

```ts
interface DataAdapter<T> {
  readonly sourceId: string;
  readonly adapterVersion: string;
  readonly rateLimit: { perSecond: number; burst: number };
  fetch(window: { from: UtcInstant; to: UtcInstant }, ctx: FetchContext): AsyncIterable<PointInTimeObservation<T>>;
}
interface ArtifactStore {
  put(bytes: Uint8Array, meta: { sourceId: string; locator: string; retrievedAt: UtcInstant }): Promise<Sha256>;
  get(hash: Sha256): Promise<Uint8Array | undefined>;
}
```

## Market and corporate actions

```ts
type RawBar = { symbol: string; session: string; open: Decimal; high: Decimal; low: Decimal; close: Decimal; volume: bigint; venue: "IEX" | "SIP" | "BROKER" | "OTHER"; };
type AdjustedTotalReturnPoint = { symbol: string; session: string; trIndex: Decimal; adjustmentVersion: string };
type CorporateAction =
  | { kind: "SPLIT"; symbol: string; exDate: string; ratio: Decimal }
  | { kind: "DIVIDEND"; symbol: string; exDate: string; payDate?: string; amount: Decimal }
  | { kind: "SYMBOL_CHANGE"; from: string; to: string; effective: string }
  | { kind: "MERGER" | "SPINOFF"; symbol: string; effective: string; terms: string }
  | { kind: "DELISTING"; symbol: string; effective: string; reason?: string }
  | { kind: "BAR_CORRECTION"; symbol: string; session: string; supersedesHash: Sha256 };

interface UniverseSnapshotStore {
  membersAsOf(universeId: string, date: string): Promise<{ symbols: string[]; snapshotDate: string; survivorshipFree: boolean }>;
}
interface ExchangeCalendar {
  isSession(date: string): boolean;
  sessionClose(date: string): UtcInstant;      // handles early closes and DST
  nextSession(after: UtcInstant): string;
}
```

## Strategy and experiment registry

```ts
type AlphaCharterRef = { strategyId: string; version: string; charterHash: Sha256; approvedBy: string; approvedAt: UtcInstant };

type ExperimentRegistration = {
  experimentId: string;
  charter: AlphaCharterRef;
  codeCommit: string;
  dataSnapshotIds: string[];
  versions: { feature: string; strategy: string; portfolio: string; risk: string };
  model?: { provider: string; modelId: string; promptHash: Sha256; schemaHash: Sha256; toolSet: string[]; decoding: Record<string, unknown>; preprocessorVersion: string };
  parameterGrid: Record<string, unknown[]>;
  trialCount: number;
  splits: { train: [string, string]; validation: [string, string]; walkForward: Array<[string, string]>; holdout: [string, string] };
  metrics: { primary: string; secondary: string[] };
  costModel: { base: CostAssumptions; adverse: CostAssumptions; stress: CostAssumptions };
  passFail: string;
  registeredAt: UtcInstant;
  resultsViewedAt?: UtcInstant;   // once set, the registration is frozen forever
  holdoutOpenedAt?: UtcInstant;   // set at most once
};

interface CandidateEngine {
  readonly strategyId: string; readonly version: string;
  candidates(decisionAt: UtcInstant, pit: PointInTimeRepository, universe: UniverseSnapshotStore): Promise<Candidate[]>;
}
type Candidate = { candidateId: string; strategyId: string; strategyVersion: string; symbol: string; decisionAt: UtcInstant; signal: Decimal; features: Record<string, Decimal | string>; };
```

## Analyst (LLM research layer)

```ts
type EvidencePacket = {
  packetId: string; candidateId: string; strategyVersion: string; decisionAt: UtcInstant;
  excerpts: Array<{ sourceId: string; locator: string; availableAt: UtcInstant; text: string; hash: Sha256 }>;
  priorComparables?: EvidencePacket["excerpts"];
  exposureFlags: string[];          // redacted, sleeve-relative, no dollars
  restrictions: string[];
  untrustedContentNotice: string;   // fixed string; content is data, not instructions
  packetHash: Sha256;
};

type ResearchAssessment = {
  assessmentId: string;
  candidateId: string;
  strategyVersion: string;
  evidenceFor: Array<{ sourceId: string; fact: string }>;
  evidenceAgainst: Array<{ sourceId: string; fact: string }>;
  missingEvidence: string[];
  ontologyTags: string[];
  factorsTouched: string[];
  thesis: string;
  strongestDissent: string;
  falsifiers: Array<{ condition: string; observableBy?: string }>;
  expectedHorizon: string;
  uncertainty: "low" | "medium" | "high";
  abstain: boolean;
  abstainReason?: string;
};
// Deliberately absent: accountId, size, orderType, stopPrice, restricted_check.

interface ModelAdapter {
  assess(packet: EvidencePacket, opts: { modelId: string; promptVersion: string; deadlineMs: number; budget: Budget }): Promise<{ assessment: ResearchAssessment; record: ModelCallRecord } | { abstained: true; reason: string; record: ModelCallRecord }>;
}
type ModelCallRecord = { provider: string; modelId: string; promptHash: Sha256; schemaHash: Sha256; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: Decimal; latencyMs: number; validation: "ok" | "schema_fail" | "citation_fail" | "timeout" | "budget" };
```

## Household, compliance, portfolio, risk

```ts
type FinancialPicture = { sleeveAccountRef: string; otherAccounts: Array<{ id: string; kind: "BROKERAGE" | "IRA" | "401K" | "CASH"; asOf: string; exposures: Record<string, Decimal> }>; liquidityNeeds: string[]; careerSensitivityFlags: string[]; asOf: string; nextRefreshDue: string };
// Dollar totals are held only in code paths that compute sizing; never serialized into packets, logs, or reports.

type RestrictedList = { version: string; hash: Sha256; names: string[]; themes: string[]; etfs: string[]; blackouts: Array<{ from: string; to: string; reason: string }>; pendingRemovals: Array<{ item: string; requestedAt: UtcInstant; eligibleAt: UtcInstant; reason: string }> };

type Verdict = { ok: boolean; reasonCodes: string[] };
interface ComplianceEngine { check(intent: PortfolioTarget, ctx: ComplianceContext): Verdict; }
interface RiskEngine { size(target: PortfolioTarget, ctx: RiskContext): { ok: boolean; quantity?: Decimal; reasonCodes: string[] }; haltState(ctx: RiskContext): HaltState; }
interface PortfolioConstructor { targets(decisions: StrategyDecision[], state: SleeveState, risk: RiskConfig): PortfolioTarget[]; } // never receives ResearchAssessment.uncertainty as a sizing input
```

## Orders and gateway

```ts
type OrderState = "CREATED" | "VALIDATED" | "AWAITING_APPROVAL" | "APPROVED" | "SUBMITTING" | "UNKNOWN" | "ACKNOWLEDGED" | "PARTIALLY_FILLED" | "FILLED" | "PROTECTION_PENDING" | "PROTECTED" | "PROTECTION_FAILED" | "CANCEL_PENDING" | "CANCELED" | "REJECTED" | "EXIT_PENDING" | "CLOSED";

type OrderIntent = {
  intentId: string;
  clientOrderId: string;              // deterministic: hash(intentId, strategyVersion, symbol, side, qty, decisionAt)
  sleeveAccountId: string;            // supplied by trusted code; gateway re-checks against allowlist; never inferred
  mode: Mode;
  strategyId: string; strategyVersion: string;
  symbol: string; side: "BUY" | "SELL"; quantity: Decimal;
  orderType: "LIMIT" | "MARKET"; limitPrice?: Decimal; timeInForce: "DAY" | "GTC";
  protection?: { stopPrice: Decimal; construct: "NATIVE_BRACKET" | "NATIVE_OCO" };
  quote: { bid: Decimal; ask: Decimal; venue: string; at: UtcInstant };
  riskSnapshotHash: Sha256; complianceVerdict: Verdict; riskVerdict: Verdict;
  authorizationRef?: string;          // LIVE_AUTHORIZATION id; required for LIVE_* modes
  approval?: { by: string; at: UtcInstant; signature: string };
  createdAt: UtcInstant;
};

/** Read-only view for non-sleeve accounts. There is no mutating counterpart. */
interface ReadOnlyAccountView { positions(accountRef: string): Promise<Position[]>; balances(accountRef: string): Promise<Balances>; }

/** Trading interface. Only the gateway implements it; only the sleeve account id is accepted. */
interface BrokerTradingAdapter {
  readonly allowedAccountId: string;
  submit(intent: OrderIntent): Promise<{ brokerOrderId: string } | { state: "UNKNOWN" } | { rejected: string }>;
  orderStatus(clientOrderId: string): Promise<BrokerOrderSnapshot | undefined>;
  cancel(clientOrderId: string): Promise<"CANCEL_PENDING" | "UNKNOWN">;
  openOrders(): Promise<BrokerOrderSnapshot[]>;
  positions(): Promise<Position[]>;
}
// Absent by design: withdraw, transfer, journal, updateProfile, listAccounts-with-write, rawRequest.

type LiveAuthorization = { id: string; sleeveAccountHash: Sha256; charters: AlphaCharterRef[]; instruments: string[]; directions: ["BUY", "SELL"]; sessions: ["REGULAR"]; orderTypes: Array<"LIMIT" | "MARKET">; caps: { maxNav: Decimal; maxGross: Decimal; maxPosition: Decimal; maxOrder: Decimal; maxDailyOrders: number; maxCumulativeLoss: Decimal }; startsAt: UtcInstant; expiresAt: UtcInstant; approvalMode: "PER_ORDER" | "LIMITED_AUTO"; hashes: { risk: Sha256; compliance: Sha256; executable: Sha256 }; signature: string };
```

## Event ledger

```ts
type LedgerEvent = { seq: number; at: UtcInstant; kind: string; payload: unknown; prevHash: Sha256; hash: Sha256 };
interface Ledger { append(kind: string, payload: unknown): Promise<LedgerEvent>; verifyChain(from?: number): Promise<{ ok: boolean; brokenAt?: number }>; sealDaily(date: string): Promise<{ rootHash: Sha256 }>; }
```

## Properties tests must prove (Phase 0–4)

1. No type in `core` can construct or call a mutation on a non-sleeve account (compile-time and reflection test over exported interfaces).
2. `PointInTimeRepository.asOf` never returns an observation with `availableAt + delay > decisionAt` (property test with random instants).
3. `PortfolioConstructor` output is invariant to `ResearchAssessment.uncertainty` (mutation test).
4. `OrderIntent.clientOrderId` is a pure function of its declared inputs (determinism test).
5. Every `OrderState` transition not in the legal table throws (exhaustive table test).
6. `Ledger.verifyChain` detects any single-byte modification (fuzz test).
7. Serializing `FinancialPicture` for a packet, log, or report never includes a dollar field (schema-level redaction test).
