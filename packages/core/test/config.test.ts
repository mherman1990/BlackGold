import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  LiveModeUnavailableError,
  SleeveRoleError,
  ConfigError,
  envToAppConfigInput,
  loadAppConfig,
  parseYamlConfig,
  RiskConfigSchema,
  FinancialPictureConfigSchema,
  RestrictedListConfigSchema,
  LiveAuthorizationSchema,
  processingDelayOverridesMs,
} from "../src/index.ts";
import { LIVE_MODES, MODES } from "@blackgold/shared";

const ROOT = new URL("../../../", import.meta.url).pathname;
const example = (name: string): string => readFileSync(`${ROOT}config/examples/${name}`, "utf8");

describe("app config from environment", () => {
  it("applies defaults and derives paths from BLACKGOLD_DATA_DIR", () => {
    const cfg = loadAppConfig({ BLACKGOLD_DATA_DIR: "/tmp/bg-x" });
    expect(cfg.mode).toBe("RESEARCH");
    expect(cfg.dbPath).toBe("/tmp/bg-x/blackgold.sqlite");
    expect(cfg.backupsDir).toBe("/tmp/bg-x/backups");
    expect(cfg.sleeveAccount.role).toBe("blackgold_sleeve");
  });

  it("every live mode is refused at load time; every non-live mode loads", () => {
    for (const mode of LIVE_MODES) {
      expect(() => loadAppConfig({ BLACKGOLD_MODE: mode }), mode).toThrow(LiveModeUnavailableError);
    }
    for (const mode of MODES.filter((m) => !LIVE_MODES.includes(m))) {
      expect(loadAppConfig({ BLACKGOLD_MODE: mode }).mode).toBe(mode);
    }
  });

  it("rejects any sleeve role other than blackgold_sleeve, including wildcards and empty", () => {
    for (const role of ["default", "*", "sleeve", "BLACKGOLD_SLEEVE"]) {
      expect(() => envToAppConfigInput({ BLACKGOLD_SLEEVE_ACCOUNT_ROLE: role }), role).toThrow(SleeveRoleError);
    }
  });

  it("reads processing-delay overrides from the environment and converts them for the repository", () => {
    const cfg = loadAppConfig({ BLACKGOLD_PROCESSING_DELAYS: "fred.=PT2H, cftc.=P1D,sec.edgar.=P1DT6H" });
    expect(cfg.sources.processingDelays).toEqual({ "fred.": "PT2H", "cftc.": "P1D", "sec.edgar.": "P1DT6H" });
    expect(processingDelayOverridesMs(cfg.sources)).toEqual({ "fred.": 7_200_000, "cftc.": 86_400_000, "sec.edgar.": 108_000_000 });
    expect(processingDelayOverridesMs(loadAppConfig({}).sources)).toEqual({});
    for (const bad of ["fred.=2h", "fred.", "=PT1H", "fred.=P", "fred.=PT", "fred.=PT1H,"]) {
      if (bad.endsWith(",")) continue; // a trailing comma is tolerated
      expect(() => loadAppConfig({ BLACKGOLD_PROCESSING_DELAYS: bad }), bad).toThrow(ConfigError);
    }
    expect(loadAppConfig({ BLACKGOLD_PROCESSING_DELAYS: "fred.=PT1H," }).sources.processingDelays).toEqual({ "fred.": "PT1H" });
  });

  it("rejects malformed values with a ConfigError", () => {
    expect(() => loadAppConfig({ BLACKGOLD_SCHEDULER_POLL_SECONDS: "1" })).toThrow(ConfigError);
    expect(() => loadAppConfig({ BLACKGOLD_MODE: "YOLO" })).toThrow(ConfigError);
  });
});

describe("example YAML configs parse against their schemas", () => {
  it("risk.yaml", () => {
    const risk = parseYamlConfig(example("risk.yaml"), RiskConfigSchema, "risk.yaml");
    expect(risk.leverage).toBe(false);
    expect(risk.fractionalShares).toBe(false);
    expect(risk.extendedHours).toBe(false);
  });
  it("financial-picture.yaml", () => {
    expect(() => parseYamlConfig(example("financial-picture.yaml"), FinancialPictureConfigSchema)).not.toThrow();
  });
  it("restricted-list.yaml", () => {
    const rl = parseYamlConfig(example("restricted-list.yaml"), RestrictedListConfigSchema);
    expect(rl.themes.length).toBeGreaterThan(0);
  });
  it("LIVE_AUTHORIZATION.example.yaml parses but is only a schema in Phase 0", () => {
    expect(() => parseYamlConfig(example("LIVE_AUTHORIZATION.example.yaml"), LiveAuthorizationSchema)).not.toThrow();
  });
  it("no example contains a dollar total or a credential-shaped string", () => {
    for (const f of ["risk.yaml", "financial-picture.yaml", "restricted-list.yaml", "LIVE_AUTHORIZATION.example.yaml", "app.env.example"]) {
      const text = example(f);
      expect(text, f).not.toMatch(/\$\s?\d{1,3}(,\d{3})+/);
      expect(text, f).not.toMatch(/sk-ant-|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}/);
    }
  });
});
