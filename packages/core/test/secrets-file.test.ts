import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppConfig, readAnthropicApiKey, SECRETS_FILE_NAME } from "../src/config/load.ts";

// "fake..." values mirror the existing ingest test fixtures and stay clear of the secret scanner.
const FAKE_TIINGO = "faketiingokey0123456789";
const FAKE_FRED = "fakefredkey0123456789abcdef";
const FAKE_ANTHROPIC = "fake-anthropic-key-0123456789";
const CONTACT = "ops@example.com";

/** A fresh data dir with an optional secrets.env, and a base env pointing at it (no credentials in env). */
function setup(secretsFileBody?: string): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "bg-secrets-"));
  if (secretsFileBody !== undefined) writeFileSync(join(dir, SECRETS_FILE_NAME), secretsFileBody);
  return { BLACKGOLD_DATA_DIR: dir };
}

describe("file-based secrets loader", () => {
  it("fills data-source credentials from the file when the environment is empty", () => {
    const env = setup(`BLACKGOLD_TIINGO_API_KEY=${FAKE_TIINGO}\nBLACKGOLD_SEC_USER_AGENT_CONTACT=${CONTACT}\n`);
    const config = loadAppConfig(env);
    expect(config.sources.tiingoApiKey).toBe(FAKE_TIINGO);
    expect(config.sources.secUserAgentContact).toBe(CONTACT);
  });

  it("supplies the Anthropic key from the file", () => {
    const env = setup(`ANTHROPIC_API_KEY=${FAKE_ANTHROPIC}\n`);
    expect(readAnthropicApiKey(env)).toBe(FAKE_ANTHROPIC);
  });

  it("supplies the opt-in auto-ingest switches from the file (the umbrelOS env-gap channel)", () => {
    // On umbrelOS 1.x the app-data .env never reaches the container, so the secrets file is the only way to turn
    // on the unattended ingest job. These two behavioural keys are the sole non-credential entries allowed.
    const env = setup(`BLACKGOLD_AUTO_INGEST_CHARTER=strategies/etf-trend-vol/charter.yaml\nBLACKGOLD_AUTO_INGEST_ACTIONS=tiingo\n`);
    const config = loadAppConfig(env);
    expect(config.sources.autoIngestCharterPath).toBe("strategies/etf-trend-vol/charter.yaml");
    expect(config.sources.autoIngestActions).toBe("tiingo");
  });

  it("still ignores a non-allowlisted behavioural key from the file (only the two auto-ingest keys are admitted)", () => {
    // SCHEDULER_POLL_SECONDS is behavioural config that is NOT allowlisted: the file must not be able to set it.
    const env = setup(`BLACKGOLD_SCHEDULER_POLL_SECONDS=5\nBLACKGOLD_AUTO_INGEST_CHARTER=strategies/etf-trend-vol/charter.yaml\n`);
    const config = loadAppConfig(env);
    expect(config.schedulerPollSeconds).toBe(60); // the schema default, not the file's 5
    expect(config.sources.autoIngestCharterPath).toBe("strategies/etf-trend-vol/charter.yaml");
  });

  it("lets a non-empty environment value win over the file", () => {
    const env = setup(`BLACKGOLD_TIINGO_API_KEY=${FAKE_TIINGO}\n`);
    env["BLACKGOLD_TIINGO_API_KEY"] = "env-wins-key-0123456789";
    expect(loadAppConfig(env).sources.tiingoApiKey).toBe("env-wins-key-0123456789");
  });

  it("ignores an empty environment value and falls back to the file", () => {
    const env = setup(`BLACKGOLD_FRED_API_KEY=${FAKE_FRED}\n`);
    env["BLACKGOLD_FRED_API_KEY"] = "";
    expect(loadAppConfig(env).sources.fredApiKey).toBe(FAKE_FRED);
  });

  it("parses comments, blank lines, and quoted values; skips malformed lines", () => {
    const env = setup(["# a comment", "", 'BLACKGOLD_TIINGO_API_KEY="' + FAKE_TIINGO + '"', "not-a-pair", "=novalue"].join("\n"));
    expect(loadAppConfig(env).sources.tiingoApiKey).toBe(FAKE_TIINGO);
  });

  it("NEVER honours a non-allowlisted key: a secrets file cannot enable a live mode", () => {
    // The security-critical property: MODE is not an allowlisted secret key, so a secrets file that names it is
    // ignored entirely. The config still loads in the default RESEARCH mode and never a live one.
    const env = setup(`BLACKGOLD_MODE=LIVE_MANUAL\nBLACKGOLD_TIINGO_API_KEY=${FAKE_TIINGO}\n`);
    const config = loadAppConfig(env);
    expect(config.mode).toBe("RESEARCH");
    expect(config.sources.tiingoApiKey).toBe(FAKE_TIINGO);
  });

  it("NEVER honours a non-allowlisted key: a secrets file cannot change the sleeve account role", () => {
    const env = setup(`BLACKGOLD_SLEEVE_ACCOUNT_ROLE=household\nBLACKGOLD_TIINGO_API_KEY=${FAKE_TIINGO}\n`);
    // A household role would throw SleeveRoleError if the file were honoured; it must load fine as the sleeve.
    expect(() => loadAppConfig(env)).not.toThrow();
    expect(loadAppConfig(env).sleeveAccount.role).toBe("blackgold_sleeve");
  });

  it("reads BLACKGOLD_SECRETS_FILE when set (the core-only mount), not the data dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-secrets-"));
    const custom = join(dir, "custom-secrets.env");
    writeFileSync(custom, `BLACKGOLD_TIINGO_API_KEY=${FAKE_TIINGO}\n`);
    const dataDir = mkdtempSync(join(tmpdir(), "bg-data-")); // no secrets.env here
    const env: NodeJS.ProcessEnv = { BLACKGOLD_DATA_DIR: dataDir, BLACKGOLD_SECRETS_FILE: custom };
    expect(loadAppConfig(env).sources.tiingoApiKey).toBe(FAKE_TIINGO);
  });

  it("is a no-op when the file is absent", () => {
    const env = setup();
    expect(loadAppConfig(env).sources.tiingoApiKey).toBeUndefined();
    expect(readAnthropicApiKey(env)).toBeUndefined();
  });
});
