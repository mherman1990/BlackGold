import { z } from "zod";
import { ACCOUNT_ROLES, ARMS, MODES, SLEEVE_ROLE, durationMs } from "@blackgold/shared";

/**
 * Configuration schemas for Black Gold core. Money, percentages, and ratios are decimal STRINGS
 * ("0.05" means 5%) so that no binary float ever enters a risk limit. Parse them with `dec()`.
 *
 * JSON Schema files under config/schema/ are emitted from these definitions (see emit-json-schema.ts).
 */

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const SHA256_PREFIXED_RE = /^sha256:[0-9a-f]{4,64}$/;

/** Non-negative decimal string such as "0.05" or "1500". */
export const decString = z
  .string()
  .regex(DECIMAL_RE, "must be a decimal string such as \"0.05\"")
  .refine((s) => !s.startsWith("-"), "must be non-negative");

/** Ratio between 0 and 1 inclusive, as a decimal string. */
export const ratioString = decString.refine((s) => Number(s) <= 1, "must be between 0 and 1");

export const utcInstantString = z.iso.datetime({ message: "must be an ISO-8601 UTC instant ending in Z" });
export const isoDateString = z.iso.date({ message: "must be a calendar date YYYY-MM-DD" });

// ---------------------------------------------------------------------------------------------
// AppConfig
// ---------------------------------------------------------------------------------------------

export const NotificationAdapters = ["stub", "ntfy"] as const;

const AppConfigInput = z.object({
  mode: z.enum(MODES).default("RESEARCH"),
  dataDir: z.string().min(1).default("./data"),
  /** Defaults to `${dataDir}/blackgold.sqlite`. */
  dbPath: z.string().min(1).optional(),
  /** Defaults to `${dataDir}/artifacts`. */
  artifactsDir: z.string().min(1).optional(),
  /** Defaults to `${dataDir}/backups`. */
  backupsDir: z.string().min(1).optional(),
  timezoneDisplay: z.literal("America/Chicago").default("America/Chicago"),
  exchange: z.literal("XNYS").default("XNYS"),
  schedulerPollSeconds: z.number().int().min(5).max(3600).default(60),
  /** Local read-only status listener used by `serve`; reached only through Umbrel's app_proxy. */
  httpPort: z.number().int().min(1024).max(65535).default(8479),
  notifications: z
    .object({
      adapter: z.enum(NotificationAdapters).default("stub"),
      ntfyTopicUrl: z.url({ protocol: /^https?$/ }).optional(),
    })
    .default({ adapter: "stub" }),
  budgets: z
    .object({
      llmPerCallUsd: decString.default("0.50"),
      llmPerDayUsd: decString.default("5.00"),
      llmPerMonthUsd: decString.default("60.00"),
    })
    .default({ llmPerCallUsd: "0.50", llmPerDayUsd: "5.00", llmPerMonthUsd: "60.00" }),
  /** Public data sources (Phase 1). Credentials come only from the environment and are never logged. */
  sources: z
    .object({
      /** Required by SEC fair-access policy: "BlackGold/<version> (<contact email>)". No default. */
      secUserAgentContact: z.email().optional(),
      fredApiKey: z.string().min(8).optional(),
      alpacaKeyId: z.string().min(8).optional(),
      alpacaSecretKey: z.string().min(8).optional(),
      /** Per-source-prefix processing delays as ISO-8601 durations; override spec defaults. */
      processingDelays: z
        .record(
          z.string().min(1),
          z.string().regex(/^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/, "ISO-8601 duration such as PT15M, PT2H, P1D, or P1DT6H").refine((s) => s !== "P" && s !== "PT", "duration must name at least one unit"),
        )
        .default({}),
      /** Storage cap for the raw artifact store in bytes (spec section 9). */
      artifactBudgetBytes: z.number().int().positive().default(40 * 1024 * 1024 * 1024),
    })
    .default({ processingDelays: {}, artifactBudgetBytes: 40 * 1024 * 1024 * 1024 }),
  sleeveAccount: z
    .object({
      role: z.literal(SLEEVE_ROLE),
      /** Opaque reference to the sleeve account. "UNASSIGNED" until a broker phase binds a real account. */
      accountRef: z.string().min(1).default("UNASSIGNED"),
    })
    .default({ role: SLEEVE_ROLE, accountRef: "UNASSIGNED" }),
});

export const AppConfigSchema = AppConfigInput.transform((c) => ({
  ...c,
  dbPath: c.dbPath ?? `${c.dataDir}/blackgold.sqlite`,
  artifactsDir: c.artifactsDir ?? `${c.dataDir}/artifacts`,
  backupsDir: c.backupsDir ?? `${c.dataDir}/backups`,
}));

export type AppConfigInput = z.input<typeof AppConfigInput>;
export type AppConfig = z.output<typeof AppConfigSchema>;

// ---------------------------------------------------------------------------------------------
// RiskConfig (risk.yaml). Defaults are the D-15 engineering defaults; not investment advice.
// ---------------------------------------------------------------------------------------------

export const RiskConfigSchema = z.object({
  version: z.string().min(1).default("0.1.0"),
  approvedBy: z.string().nullable().default(null),
  approvedAt: utcInstantString.nullable().default(null),

  sleeve: z
    .object({
      maxPctOfLiquidInvestableAssets: ratioString.default("0.05"),
      cashFundedOnly: z.literal(true).default(true),
    })
    .default({ maxPctOfLiquidInvestableAssets: "0.05", cashFundedOnly: true }),

  allowedInstruments: z.array(z.enum(["ETF", "EQUITY"])).nonempty().default(["ETF", "EQUITY"]),
  /** Long-only: SELL may only reduce an existing long position. */
  allowedDirections: z.array(z.enum(["BUY", "SELL"])).nonempty().default(["BUY", "SELL"]),
  allowedSessions: z.array(z.literal("REGULAR")).nonempty().default(["REGULAR"]),
  allowedOrderTypes: z.array(z.enum(["LIMIT", "MARKET"])).nonempty().default(["LIMIT", "MARKET"]),
  allowedTimeInForce: z.array(z.enum(["DAY", "GTC"])).nonempty().default(["DAY", "GTC"]),
  fractionalShares: z.literal(false).default(false),
  extendedHours: z.literal(false).default(false),
  leverage: z.literal(false).default(false),

  positionLimits: z
    .object({
      maxSingleStockWeightPct: ratioString.default("0.05"),
      maxSingleEtfWeightPct: ratioString.default("0.20"),
      /** Initial loss budget from entry to approved stop, as a fraction of sleeve NAV. */
      maxInitialRiskPerPositionPct: ratioString.default("0.0035"),
      maxOpenPositions: z.number().int().positive().default(10),
      maxNewPositionsPerSession: z.number().int().nonnegative().default(3),
      /** Sum of initial loss budgets opened in one session, as a fraction of sleeve NAV. */
      dailyNewRiskPctNav: ratioString.default("0.01"),
    })
    .default({
      maxSingleStockWeightPct: "0.05",
      maxSingleEtfWeightPct: "0.20",
      maxInitialRiskPerPositionPct: "0.0035",
      maxOpenPositions: 10,
      maxNewPositionsPerSession: 3,
      dailyNewRiskPctNav: "0.01",
    }),

  concentration: z
    .object({
      maxSectorWeightPct: ratioString.default("0.20"),
      maxThemeWeightPct: ratioString.default("0.20"),
      maxFactorWeightPct: ratioString.default("0.30"),
      maxCorrelatedClusterWeightPct: ratioString.default("0.30"),
      correlationClusterThreshold: ratioString.default("0.70"),
    })
    .default({
      maxSectorWeightPct: "0.20",
      maxThemeWeightPct: "0.20",
      maxFactorWeightPct: "0.30",
      maxCorrelatedClusterWeightPct: "0.30",
      correlationClusterThreshold: "0.70",
    }),

  exposure: z
    .object({
      maxGrossExposurePct: ratioString.default("1.00"),
      maxNetExposurePct: ratioString.default("1.00"),
      minCashPct: ratioString.default("0.02"),
    })
    .default({ maxGrossExposurePct: "1.00", maxNetExposurePct: "1.00", minCashPct: "0.02" }),

  volatility: z
    .object({
      scalingRule: z.enum(["none", "target_vol"]).default("target_vol"),
      targetAnnualizedVolPct: ratioString.default("0.10"),
      maxScaleFactor: decString.default("1.0"),
      lookbackDays: z.number().int().positive().default(63),
    })
    .default({ scalingRule: "target_vol", targetAnnualizedVolPct: "0.10", maxScaleFactor: "1.0", lookbackDays: 63 }),

  liquidity: z
    .object({
      maxAdvParticipationPct: ratioString.default("0.01"),
      minAdvUsd: decString.default("5000000"),
      minPriceUsd: decString.default("5.00"),
      maxSpreadBps: decString.default("50"),
    })
    .default({ maxAdvParticipationPct: "0.01", minAdvUsd: "5000000", minPriceUsd: "5.00", maxSpreadBps: "50" }),

  orderLimits: z
    .object({
      maxOrderNotionalUsd: decString.default("1500"),
      maxOrderQuantity: decString.default("1000"),
      maxOrdersPerSession: z.number().int().nonnegative().default(4),
      maxDailyTurnoverPctNav: ratioString.default("0.25"),
    })
    .default({ maxOrderNotionalUsd: "1500", maxOrderQuantity: "1000", maxOrdersPerSession: 4, maxDailyTurnoverPctNav: "0.25" }),

  eventBlackouts: z
    .object({
      earningsDaysBefore: z.number().int().nonnegative().default(2),
      earningsDaysAfter: z.number().int().nonnegative().default(1),
      blockNewRiskOnScheduledEvents: z.boolean().default(true),
    })
    .default({ earningsDaysBefore: 2, earningsDaysAfter: 1, blockNewRiskOnScheduledEvents: true }),

  pdt: z
    .object({
      preventPatternDayTrading: z.literal(true).default(true),
      maxDayTradesPerRollingFiveDays: z.number().int().nonnegative().default(3),
    })
    .default({ preventPatternDayTrading: true, maxDayTradesPerRollingFiveDays: 3 }),

  priceRules: z
    .object({
      maxQuoteAgeSeconds: z.number().int().positive().default(60),
      maxAbnormalMovePct: ratioString.default("0.20"),
      maxCrossSourceDeviationPct: ratioString.default("0.02"),
      requireTwoSources: z.boolean().default(true),
    })
    .default({ maxQuoteAgeSeconds: 60, maxAbnormalMovePct: "0.20", maxCrossSourceDeviationPct: "0.02", requireTwoSources: true }),

  haltThresholds: z
    .object({
      /** HALT_NEW_RISK at this fraction of sleeve NAV lost in one session. */
      dailyLossPct: ratioString.default("0.02"),
      /** HALT_NEW_RISK at this peak-to-trough drawdown from the high-water mark. */
      haltNewRiskDrawdownPct: ratioString.default("0.08"),
      /** HOLD_ONLY at this peak-to-trough drawdown. */
      holdOnlyDrawdownPct: ratioString.default("0.10"),
      manualRearmRequired: z.literal(true).default(true),
      automaticFlatten: z.literal(false).default(false),
    })
    .default({
      dailyLossPct: "0.02",
      haltNewRiskDrawdownPct: "0.08",
      holdOnlyDrawdownPct: "0.10",
      manualRearmRequired: true,
      automaticFlatten: false,
    }),

  /** Stale inputs fail closed for new risk. */
  staleness: z
    .object({
      financialPictureMaxAgeDays: z.number().int().positive().default(120),
      marketDataMaxAgeMinutes: z.number().int().positive().default(30),
      modelConfigMaxAgeDays: z.number().int().positive().default(90),
      brokerAuthMaxAgeMinutes: z.number().int().positive().default(25),
      restrictedListMaxAgeDays: z.number().int().positive().default(120),
    })
    .default({
      financialPictureMaxAgeDays: 120,
      marketDataMaxAgeMinutes: 30,
      modelConfigMaxAgeDays: 90,
      brokerAuthMaxAgeMinutes: 25,
      restrictedListMaxAgeDays: 120,
    }),

  thesis: z
    .object({
      expiryDays: z.number().int().positive().default(60),
      deterministicExitOnExpiry: z.literal(true).default(true),
    })
    .default({ expiryDays: 60, deterministicExitOnExpiry: true }),
});

export type RiskConfig = z.output<typeof RiskConfigSchema>;

// ---------------------------------------------------------------------------------------------
// FinancialPictureConfig (household picture; dollar totals stay in local config and never reach a model)
// ---------------------------------------------------------------------------------------------

const exposureMap = z.record(z.string().min(1), ratioString);

export const FinancialPictureConfigSchema = z.object({
  asOf: isoDateString,
  staleAfterDays: z.number().int().positive().default(120),
  liquidInvestableAssetsUsd: decString,
  accounts: z.array(
    z.object({
      accountId: z.string().min(1),
      label: z.string().min(1),
      role: z.enum(ACCOUNT_ROLES),
      taxType: z.enum(["taxable", "traditional_ira", "roth_ira", "401k", "hsa", "cash", "other"]),
      valueUsd: decString,
      exposures: z
        .object({
          assetClass: exposureMap.default({}),
          sector: exposureMap.default({}),
          style: exposureMap.default({}),
        })
        .default({ assetClass: {}, sector: {}, style: {} }),
    }),
  ),
  careerSensitivity: z
    .object({
      /** Sectors or themes correlated with household income. Flags only, never dollar values. */
      sectorFlags: z.array(z.string().min(1)).default([]),
      themeFlags: z.array(z.string().min(1)).default([]),
      notes: z.string().default(""),
    })
    .default({ sectorFlags: [], themeFlags: [], notes: "" }),
});

export type FinancialPictureConfig = z.output<typeof FinancialPictureConfigSchema>;

// ---------------------------------------------------------------------------------------------
// RestrictedListConfig (additions immediate; removals after a cooling period)
// ---------------------------------------------------------------------------------------------

export const RestrictedListConfigSchema = z.object({
  asOf: isoDateString,
  coolingPeriodDays: z.number().int().nonnegative().default(30),
  names: z.array(z.string().min(1)).default([]),
  themes: z.array(z.string().min(1)).default([]),
  etfs: z.array(z.string().min(1)).default([]),
  blackouts: z
    .array(z.object({ from: isoDateString, to: isoDateString, reason: z.string().min(1) }))
    .default([]),
  pendingRemovals: z
    .array(
      z.object({
        item: z.string().min(1),
        requestedAt: utcInstantString,
        eligibleAt: utcInstantString,
        reason: z.string().min(1),
      }),
    )
    .default([]),
});

export type RestrictedListConfig = z.output<typeof RestrictedListConfigSchema>;

// ---------------------------------------------------------------------------------------------
// LiveAuthorization (docs/AUTOMATION_AND_LIVE_GATES.md section 5). Schema only: Phase 0 has no verifier
// and no live path. Field names mirror the YAML artifact (snake_case).
// ---------------------------------------------------------------------------------------------

const prefixedHash = z.string().regex(SHA256_PREFIXED_RE, "must look like sha256:<hex>");
const usdAmount = z.union([z.int().nonnegative(), decString]).transform((v) => String(v));
const pctAmount = z.union([z.int().min(0).max(100), decString]).transform((v) => String(v));

export const LiveAuthorizationSchema = z.object({
  authorization_id: z.string().regex(/^AUTH-\d{4}-\d{4}$/),
  issued_at_utc: utcInstantString,
  starts_at_utc: utcInstantString,
  expires_at_utc: utcInstantString,
  sleeve: z.object({ account_hash: prefixedHash, broker: z.string().min(1) }),
  mode: z.enum(["LIVE_MANUAL", "LIVE_LIMITED"]),
  approval_mode: z.enum(["per_order", "version_level"]),
  allowed: z.object({
    charter_versions: z.array(
      z.object({ strategy_id: z.string().min(1), charter_version: z.string().min(1), charter_hash: prefixedHash }),
    ),
    strategy_versions: z.array(
      z.object({
        strategy_id: z.string().min(1),
        rules_version: z.int().nonnegative(),
        portfolio_version: z.int().nonnegative(),
      }),
    ),
    arms_in_production: z.array(z.enum(ARMS)),
    instruments: z.array(z.string().regex(/^[A-Z.\-]{1,10}$/)).nonempty(),
    directions: z.array(z.enum(["BUY_TO_OPEN", "SELL_TO_CLOSE"])).nonempty(),
    sessions: z.array(z.literal("REGULAR")).nonempty(),
    order_types: z.array(z.enum(["LIMIT_DAY", "LIMIT_GTC", "MARKET_DAY"])).nonempty(),
  }),
  caps: z.object({
    max_sleeve_nav_usd: usdAmount,
    max_gross_exposure_pct_nav: pctAmount,
    max_position_pct_nav: pctAmount,
    max_order_notional_usd: usdAmount,
    max_orders_per_session_day: z.int().nonnegative(),
    max_cumulative_loss_usd: usdAmount,
  }),
  hashes: z.object({
    risk_yaml: prefixedHash,
    compliance_policy: prefixedHash,
    executable_version: z.string().min(1),
    model_config: prefixedHash.nullable(),
  }),
  signature: z.object({ key_id: z.string().min(1), value: z.string().min(1) }),
});

export type LiveAuthorization = z.output<typeof LiveAuthorizationSchema>;

// ---------------------------------------------------------------------------------------------
// ModelManifestConfig (the capability manifest; model IDs live here, never in code - D-11, MP-02)
// ---------------------------------------------------------------------------------------------

export const ModelTiers = ["fast", "synthesis", "premium"] as const;
export const ModelTasks = ["extraction", "triage", "synthesis"] as const;

const ModelEntrySchema = z.object({
  provider: z.string().min(1),
  /** The exact model snapshot id, pinned per strategy version. A provider-side upgrade is a new version. */
  modelId: z.string().min(1),
  tier: z.enum(ModelTiers),
  structuredOutput: z.boolean(),
  promptCaching: z.boolean(),
  batch: z.object({ supported: z.boolean(), completionWindowHours: z.number().int().positive() }),
  contextTokens: z.number().int().positive(),
  pricing: z.object({
    inputPerMTokUsd: decString,
    outputPerMTokUsd: decString,
    cachedInputPerMTokUsd: decString,
    /** The date this pricing and these capabilities were verified. Staleness fails closed (modelConfigMaxAgeDays). */
    checkedAt: isoDateString,
  }),
  registeredTasks: z.array(z.enum(ModelTasks)).min(1),
});

export const ModelManifestConfigSchema = z
  .object({
    models: z.array(ModelEntrySchema).min(1),
  })
  .refine((m) => new Set(m.models.map((e) => e.modelId)).size === m.models.length, "model ids must be unique");

export type ModelEntry = z.output<typeof ModelEntrySchema>;
export type ModelManifestConfig = z.output<typeof ModelManifestConfigSchema>;

/** Every config schema by file name, for JSON Schema emission and documentation. */
export const CONFIG_SCHEMAS = {
  app: AppConfigSchema,
  risk: RiskConfigSchema,
  "financial-picture": FinancialPictureConfigSchema,
  "restricted-list": RestrictedListConfigSchema,
  "live-authorization": LiveAuthorizationSchema,
  "model-manifest": ModelManifestConfigSchema,
} as const;

/**
 * Configured per-source-prefix processing delays in milliseconds, the shape `PointInTimeRepository` takes as
 * `processingDelayOverrides`. Every repository the runtime constructs must receive this; a repository built
 * without it silently falls back to the spec defaults (15 or 60 minutes) and can read a source earlier than
 * the operator declared realistic.
 */
export function processingDelayOverridesMs(sources: AppConfig["sources"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [prefix, iso] of Object.entries(sources.processingDelays)) out[prefix] = durationMs(iso);
  return out;
}
