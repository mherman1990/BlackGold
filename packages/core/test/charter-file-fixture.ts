import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

/**
 * The tracked charter's version, read rather than written as a literal, so cutting a new charter version does
 * not silently empty per-version queries in the tests that use it.
 */
export const TRACKED_CHARTER_PATH = fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url));
export const CHARTER_VERSION = (parse(readFileSync(TRACKED_CHARTER_PATH, "utf8")) as { charter_version: string }).charter_version;

/**
 * The registered charter, shrunk to the shadow-decision fixture's shape (same edits as shadow-decision.test.ts)
 * and written back to disk, because the shadow job and the experiment CLI load a charter FILE. The parse ->
 * edit -> stringify round trip keeps it a valid document under the real schema. `edit` mutates the document
 * before it is written (a DRAFT approval block, a different universe) for refusal tests.
 */
export function writeShadowCharter(dir: string, opts: { decisionOffsetMinutes?: number; fileName?: string; edit?: (doc: Record<string, unknown>) => void } = {}): string {
  const doc = parse(readFileSync(TRACKED_CHARTER_PATH, "utf8")) as Record<string, unknown>;
  const universe = doc["universe"] as Record<string, unknown>;
  universe["risk_etfs"] = ["VTI", "QQQ", "IWM", "VTV", "VUG", "XLK", "XLV", "XLU"];
  universe["conditional"] = [];
  universe["look_through_flagged"] = [];
  (doc["sizing"] as Record<string, unknown>)["clusters"] = [];
  const features = doc["features"] as Record<string, unknown>;
  Object.assign(features, { momentum_lookback_sessions: 20, momentum_skip_sessions: 4, trend_sma_sessions: 10, volatility_sessions: 15, adv_sessions: 5, min_adv_usd: "1000000" });
  // Unlike the in-memory fixtures, a charter FILE goes through full validation: factor assignments must cover
  // only universe members, and the registered feature point must be a member of the sensitivity grid.
  const factors = doc["factors"] as { assignments: Record<string, unknown> };
  const keep = new Set([...(universe["risk_etfs"] as string[]), universe["cash_etf"] as string]);
  factors.assignments = Object.fromEntries(Object.entries(factors.assignments).filter(([sym]) => keep.has(sym)));
  if (opts.decisionOffsetMinutes !== undefined) (doc["rules"] as Record<string, unknown>)["decision_offset_minutes"] = opts.decisionOffsetMinutes;
  const grid = doc["sensitivity_grid"] as Record<string, unknown>;
  grid["momentum"] = [{ lookback_sessions: 20, skip_sessions: 4 }, { lookback_sessions: 40, skip_sessions: 4 }];
  grid["trend_sma_sessions"] = [10, 15];
  grid["volatility_sessions"] = [15];
  opts.edit?.(doc);
  const path = join(dir, opts.fileName ?? "charter.yaml");
  writeFileSync(path, stringify(doc));
  return path;
}
