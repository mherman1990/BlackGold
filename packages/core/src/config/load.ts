import { readFileSync } from "node:fs";
import { join } from "node:path";
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
      tiingoApiKey: get("TIINGO_API_KEY"),
      autoIngestCharterPath: get("AUTO_INGEST_CHARTER"),
      autoIngestActions: get("AUTO_INGEST_ACTIONS"),
      processingDelays: delays("PROCESSING_DELAYS"),
      artifactBudgetBytes: num("ARTIFACT_BUDGET_BYTES"),
    }),
    sleeveAccount: stripUndefined({ role, accountRef: get("SLEEVE_ACCOUNT_REF") }),
  });
}

/** Basename of the optional secrets file, read from under the data dir (see loadSecretsFile). */
export const SECRETS_FILE_NAME = "secrets.env";

/**
 * The ONLY environment-variable names the secrets file may supply: the read-only data-source credentials, the
 * model-provider key, and the two opt-in auto-ingest switches (`AUTO_INGEST_CHARTER` / `AUTO_INGEST_ACTIONS`).
 * The two auto-ingest keys are the sole non-credential entries, and they are here for a reason: on umbrelOS 1.x
 * the app-data `.env` is not injected into the container (D-52), so the secrets file is the ONLY channel that
 * reaches an unattended `serve` process - and the scheduled ingest it turns on is precisely the autonomy D-52
 * exists to serve. They are safe to admit here because they can only enable an opt-in, read-only public-data
 * refresh: the charter path names which universe to fetch, and the actions switch is `tiingo|none`.
 *
 * A closed allowlist by design - the file still can NEVER set MODE, the sleeve role, ports, budgets, or any
 * other behavioural config, so it cannot change what the app does beyond that one benign refresh and (impossible
 * here regardless) could never enable a live path. A live mode is still refused from every source in
 * loadAppConfig/parseAppConfig.
 */
const SECRET_FILE_KEYS: ReadonlySet<string> = new Set([
  `${ENV_PREFIX}SEC_USER_AGENT_CONTACT`,
  `${ENV_PREFIX}FRED_API_KEY`,
  `${ENV_PREFIX}ALPACA_KEY_ID`,
  `${ENV_PREFIX}ALPACA_SECRET_KEY`,
  `${ENV_PREFIX}TIINGO_API_KEY`,
  "ANTHROPIC_API_KEY",
  `${ENV_PREFIX}AUTO_INGEST_CHARTER`,
  `${ENV_PREFIX}AUTO_INGEST_ACTIONS`,
]);

function secretsFilePath(env: NodeJS.ProcessEnv): string {
  // An explicit override wins. On Umbrel the file is mounted into the core container ONLY (a core-only
  // read-only mount, e.g. /run/blackgold-secrets/secrets.env), never under the shared /data volume the gateway
  // also mounts - so the gateway, which holds no credential in Phases 0-5, cannot read these secrets. Local
  // single-process dev falls back to ${dataDir}/secrets.env.
  const override = env[`${ENV_PREFIX}SECRETS_FILE`];
  if (override !== undefined && override !== "") return override;
  const dataDir = env[`${ENV_PREFIX}DATA_DIR`];
  return join(dataDir !== undefined && dataDir !== "" ? dataDir : "./data", SECRETS_FILE_NAME);
}

/**
 * Optional dotenv-style secrets file at `${dataDir}/secrets.env`, honoured ONLY for the allowlisted keys
 * above. It exists because on some hosts (umbrelOS 1.x) the app-data .env is not injected into the
 * container environment, while the data volume is reliably mounted - so an unattended process (the serve
 * scheduler) would otherwise start with no credentials. Values here are equivalent to the same secrets in the
 * environment: kept off AppConfig's serialized surfaces, never logged. A non-allowlisted key is ignored; a
 * missing file is a no-op. Only the path (never a value) can appear in an error.
 */
function loadSecretsFile(env: NodeJS.ProcessEnv): Record<string, string> {
  const path = secretsFilePath(env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(`could not read secrets file ${path}: ${(err as Error).message}`);
  }
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!SECRET_FILE_KEYS.has(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value !== "") out[key] = value;
  }
  return out;
}

/**
 * The environment merged with the secrets file, for the allowlisted keys only: a non-empty environment value
 * always wins, and the file fills only a key the environment leaves unset or empty. This is the single place
 * both loadAppConfig and readAnthropicApiKey obtain these values, preserving the "load.ts is the only module
 * that reads secrets" invariant.
 */
function withFileSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const fileSecrets = loadSecretsFile(env);
  const keys = Object.keys(fileSecrets);
  if (keys.length === 0) return env;
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const key of keys) {
    const current = merged[key];
    if (current === undefined || current === "") merged[key] = fileSecrets[key];
  }
  return merged;
}

/**
 * The model-provider API key, read from the standard `ANTHROPIC_API_KEY` variable (not `BLACKGOLD_`-prefixed,
 * to match the provider's own convention and the compose passthrough), falling back to the secrets file. It is
 * deliberately NOT placed on `AppConfig` so it is never serialized into a log, a status surface, or a
 * notification; the analyst wiring passes it straight to the adapter constructor. Absent or empty yields
 * undefined, and the analyst then fails closed.
 */
export function readAnthropicApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = withFileSecrets(env)["ANTHROPIC_API_KEY"];
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
  // The live-mode precheck reads the raw environment only: the secrets file cannot carry MODE (it is not an
  // allowlisted key), so it can neither enable nor disguise a live request.
  const requestedMode = env[`${ENV_PREFIX}MODE`];
  if (requestedMode === "LIVE_MANUAL" || requestedMode === "LIVE_LIMITED") {
    throw new LiveModeUnavailableError(requestedMode);
  }
  return parseAppConfig(envToAppConfigInput(withFileSecrets(env)));
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
