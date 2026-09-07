import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { isLiveMode, SLEEVE_ROLE } from "@blackgold/shared";
import { AppConfigSchema, type AppConfig, type AppConfigInput } from "./schema.ts";

/**
 * The only module in core that reads process.env. Everything else receives config as arguments.
 *
 * HARD RULES (Phase 0):
 *  (a) A live mode can never be loaded. There is no live code path in this build, and no single
 *      environment variable may enable one. Live requires a later, explicitly approved PR and a valid
 *      LIVE_AUTHORIZATION artifact; neither exists here.
 *  (b) The sleeve account role must be exactly `blackgold_sleeve`.
 */

export const ENV_PREFIX = "BLACKGOLD_";

export class LiveModeUnavailableError extends Error {
  constructor(mode: string) {
    super(`Live modes are absent by construction in this build (requested mode: ${mode})`);
    this.name = "LiveModeUnavailableError";
  }
}

export class SleeveRoleError extends Error {
  constructor(role: string) {
    super(`sleeveAccount.role must be "${SLEEVE_ROLE}", got "${role}"`);
    this.name = "SleeveRoleError";
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Read `BLACKGOLD_*` variables into the raw AppConfig input shape. Unset variables stay undefined. */
export function envToAppConfigInput(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const get = (name: string): string | undefined => {
    const v = env[`${ENV_PREFIX}${name}`];
    return v === undefined || v === "" ? undefined : v;
  };
  const num = (name: string): number | undefined => {
    const v = get(name);
    return v === undefined ? undefined : Number(v);
  };
  /** "fred.=PT2H,cftc.=P1D": comma-separated <source-id prefix>=<ISO-8601 duration> pairs. */
  const delays = (name: string): Record<string, string> | undefined => {
    const v = get(name);
    if (v === undefined) return undefined;
    const out: Record<string, string> = {};
    for (const part of v.split(",")) {
      const t = part.trim();
      if (t === "") continue;
      const i = t.indexOf("=");
      if (i <= 0 || i === t.length - 1) throw new ConfigError(`${ENV_PREFIX}${name}: expected <source-prefix>=<ISO-8601 duration>, got "${t}"`);
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return out;
  };

  const role = get("SLEEVE_ACCOUNT_ROLE") ?? SLEEVE_ROLE;
  if (role !== SLEEVE_ROLE) throw new SleeveRoleError(role);

  return stripUndefined({
    mode: get("MODE"),
    dataDir: get("DATA_DIR"),
    dbPath: get("DB_PATH"),
    artifactsDir: get("ARTIFACTS_DIR"),
    backupsDir: get("BACKUPS_DIR"),
    timezoneDisplay: get("TIMEZONE_DISPLAY"),
    exchange: get("EXCHANGE"),
    schedulerPollSeconds: num("SCHEDULER_POLL_SECONDS"),
    httpPort: num("HTTP_PORT"),
    notifications: stripUndefined({ adapter: get("NOTIFY_ADAPTER"), ntfyTopicUrl: get("NTFY_TOPIC_URL") }),
    budgets: stripUndefined({
      llmPerCallUsd: get("LLM_BUDGET_PER_CALL_USD"),
      llmPerDayUsd: get("LLM_BUDGET_PER_DAY_USD"),
      llmPerMonthUsd: get("LLM_BUDGET_PER_MONTH_USD"),
    }),
    sources: stripUndefined({
      secUserAgentContact: get("SEC_USER_AGENT_CONTACT"),
      fredApiKey: get("FRED_API_KEY"),
      alpacaKeyId: get("ALPACA_KEY_ID"),
      alpacaSecretKey: get("ALPACA_SECRET_KEY"),
      processingDelays: delays("PROCESSING_DELAYS"),
      artifactBudgetBytes: num("ARTIFACT_BUDGET_BYTES"),
    }),
    sleeveAccount: stripUndefined({ role, accountRef: get("SLEEVE_ACCOUNT_REF") }),
  });
}

/**
 * The model-provider API key, read from the standard `ANTHROPIC_API_KEY` variable (not `BLACKGOLD_`-prefixed,
 * to match the provider's own convention and the compose passthrough). Deliberately NOT placed on `AppConfig`
 * so it is never serialized into a log, a status surface, or a notification; the analyst wiring passes it
 * straight to the adapter constructor. Absent or empty yields undefined, and the analyst then fails closed.
 */
export function readAnthropicApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env["ANTHROPIC_API_KEY"];
  return v === undefined || v === "" ? undefined : v;
}

/** Parse an AppConfig from an input object, applying the hard rules. */
export function parseAppConfig(input: unknown): AppConfig {
  const parsed = AppConfigSchema.safeParse(input);
  if (!parsed.success) throw new ConfigError(`Invalid app config: ${formatIssues(parsed.error)}`);
  const config = parsed.data;
  if (isLiveMode(config.mode)) throw new LiveModeUnavailableError(config.mode);
  // The schema already pins the literal; this re-check guards against a schema edit slipping through.
  if ((config.sleeveAccount.role as string) !== SLEEVE_ROLE) throw new SleeveRoleError(config.sleeveAccount.role);
  return config;
}

/** Load the app config from `BLACKGOLD_*` environment variables. */
export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // A live mode is refused before schema parsing so the message is unambiguous even if other fields are invalid.
  const requestedMode = env[`${ENV_PREFIX}MODE`];
  if (requestedMode === "LIVE_MANUAL" || requestedMode === "LIVE_LIMITED") {
    throw new LiveModeUnavailableError(requestedMode);
  }
  return parseAppConfig(envToAppConfigInput(env));
}

/** Read a YAML file and validate it against a zod schema. Uses the YAML 1.2 core schema: dates stay strings. */
export function loadYamlConfig<S extends z.ZodType>(path: string, schema: S): z.output<S> {
  const text = readFileSync(path, "utf8");
  return parseYamlConfig(text, schema, path);
}

export function parseYamlConfig<S extends z.ZodType>(text: string, schema: S, label = "<yaml>"): z.output<S> {
  const doc: unknown = parseYaml(text, { schema: "core", version: "1.2" });
  const parsed = schema.safeParse(doc);
  if (!parsed.success) throw new ConfigError(`Invalid config ${label}: ${formatIssues(parsed.error)}`);
  return parsed.data;
}

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`).join("; ");
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export type { AppConfig, AppConfigInput };
