import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, utc } from "@blackgold/shared";
import { NyseCalendar } from "../src/calendar/nyse.ts";
import { parseAppConfig } from "../src/config/load.ts";
import { ArtifactStore } from "../src/data/artifacts/store.ts";
import { PointInTimeRepository } from "../src/data/pit/repository.ts";
import { openCoreDb } from "../src/db/open.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { parseIngestArgs, runIngest, UsageError } from "../src/ingest/run.ts";
import { corporateActionFromValue, corporateActionSourceId } from "../src/market/types.ts";
import { blocksPromotionEvidence, isQualityCode } from "../src/data/quality.ts";
import { SchemaDriftError } from "../src/data/adapters/common.ts";
import {
  ADAPTER_VERSION,
  PARSER_VERSION,
  UNVERIFIED_SINGLE_SOURCE,
  UnapprovedCorporateActionsError,
  corporateActionsHash,
  ingestCorporateActions,
  parseCorporateActions,
} from "../src/data/adapters/corporate-actions.ts";

const calendar = new NyseCalendar();
const ingestedAt = utc("2026-12-01T00:00:00Z");
const bytesOf = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));
const ctxFor = (b: Uint8Array) => ({ calendar, ingestedAt, rawContentHash: `sha256:${sha256Hex(b)}` });
type Approval = { approvedBy: string | null; approvedAt: string | null; actionsHash: string };
/**
 * A file the owner has signed over exactly these actions (D-57). Every fixture goes through this, so a test
 * named for some other defect fails on that defect and not on a missing signature - a test that passed because
 * the file was unsigned would prove nothing about the thing it names.
 */
const signed = (file: { actions: unknown[] } & Record<string, unknown>, over: Partial<Approval> = {}): Uint8Array =>
  bytesOf({ ...file, approval: { approvedBy: "Test Owner", approvedAt: "2026-10-05T00:00:00Z", actionsHash: corporateActionsHash(file.actions), ...over } });
const fileOf = (actions: unknown[], dataset = "test-set"): Uint8Array => signed({ dataset, actions });

// Announced (2018-12-20) before its ex-date (2018-12-24); two sources.
const DIVIDEND = {
  action: { kind: "CASH_DIVIDEND", entityId: "VTI", amount: "0.7500", exDate: "2018-12-24", payDate: "2018-12-27", qualified: true },
  announcedAt: "2018-12-20T14:30:00Z",
  sources: ["issuer:vanguard", "exchange:nasdaq"],
};
// The XLF -> XLRE spin-off, the acceptance case; parent XLF, no announcement, two sources.
const SPINOFF = {
  action: { kind: "SPINOFF", parent: "XLF", child: "XLRE", ratio: "0.139146", exDate: "2015-10-08", childFirstClose: "30.00" },
  sources: ["issuer:ssga", "exchange:nyse-arca"],
};

describe("vendored corporate-action parser", () => {
  it("maps each entry to a corporate_action.<KIND> observation with the right entity, effective and available instants", () => {
    const bytes = fileOf([DIVIDEND, SPINOFF]);
    const obs = parseCorporateActions(bytes, ctxFor(bytes));
    expect(obs).toHaveLength(2);

    const div = obs.find((o) => o.sourceId === corporateActionSourceId("CASH_DIVIDEND"));
    if (!div) throw new Error("missing dividend");
    expect(div.entityId).toBe("VTI");
    expect(div.effectiveAt).toBe("2018-12-24T00:00:00.000Z");
    // Announced 2018-12-20, before the ex-date: the repository forbids availableAt < effectiveAt, so it clamps
    // up to the ex-date start.
    expect(div.availableAt).toBe("2018-12-24T00:00:00.000Z");
    expect(div.sourceLocator).toBe("vendor/corporate-actions/test-set/VTI/CASH_DIVIDEND/2018-12-24");
    expect(div.rawContentHash).toBe(`sha256:${sha256Hex(bytes)}`);
    expect(div.adapterVersion).toBe(ADAPTER_VERSION);
    expect(div.parserVersion).toBe(PARSER_VERSION);
    expect(div.qualityFlags).toEqual([]);

    const spin = obs.find((o) => o.sourceId === corporateActionSourceId("SPINOFF"));
    if (!spin) throw new Error("missing spinoff");
    expect(spin.entityId).toBe("XLF"); // the parent, per actionEntityId
    expect(spin.effectiveAt).toBe("2015-10-08T00:00:00.000Z");
    expect(spin.availableAt).toBe("2015-10-08T00:00:00.000Z");
    const action = corporateActionFromValue(spin.value);
    if (action.kind !== "SPINOFF") throw new Error("expected spinoff");
    expect(action.parent).toBe("XLF");
    expect(action.child).toBe("XLRE");
    expect(action.ratio.toFixed()).toBe("0.139146");
    expect(action.childFirstClose?.toFixed()).toBe("30");
  });

  it("honours an announcement on or after the ex-date, and defaults to the ex-date when none is given", () => {
    const late = { action: { kind: "CASH_DIVIDEND", entityId: "QQQ", amount: "0.50", exDate: "2018-12-24", payDate: "2018-12-31", qualified: true }, announcedAt: "2018-12-26T15:00:00Z", sources: ["a", "b"] };
    const none = { action: { kind: "CASH_DIVIDEND", entityId: "IWM", amount: "0.40", exDate: "2018-12-24", payDate: "2018-12-31", qualified: true }, sources: ["a", "b"] };
    const bytes = fileOf([late, none]);
    const obs = parseCorporateActions(bytes, ctxFor(bytes));
    const byEntity = (e: string) => obs.find((o) => o.entityId === e);
    expect(byEntity("QQQ")?.availableAt).toBe("2018-12-26T15:00:00.000Z");
    expect(byEntity("IWM")?.availableAt).toBe("2018-12-24T00:00:00.000Z");
  });

  it("flags an entry that names fewer than two reconciling sources", () => {
    const single = { action: { kind: "CASH_DIVIDEND", entityId: "BIL", amount: "0.12", exDate: "2019-01-02", payDate: "2019-01-07", qualified: false }, sources: ["only-one"] };
    const obs = parseCorporateActions(fileOf([single, DIVIDEND]), ctxFor(fileOf([single, DIVIDEND])));
    expect(obs.find((o) => o.entityId === "BIL")?.qualityFlags).toEqual([UNVERIFIED_SINGLE_SOURCE]);
    expect(obs.find((o) => o.entityId === "VTI")?.qualityFlags).toEqual([]);
  });

  it("rejects a malformed action, a duplicate, and a non-conforming file as SCHEMA_DRIFT", () => {
    const bad = (a: unknown) => () => parseCorporateActions(fileOf([a]), ctxFor(fileOf([a])));
    expect(bad({ action: { kind: "CASH_DIVIDEND", entityId: "VTI", amount: "-0.10", exDate: "2018-12-24", payDate: "2018-12-27" }, sources: ["a", "b"] })).toThrow(SchemaDriftError);
    expect(bad({ action: { kind: "CASH_DIVIDEND", entityId: "VTI", amount: "0.10", exDate: "2018-12-27", payDate: "2018-12-24" }, sources: ["a", "b"] })).toThrow(SchemaDriftError);
    expect(bad({ action: { kind: "SPLIT", entityId: "VTI", ratio: "0", exDate: "2018-12-24" }, sources: ["a", "b"] })).toThrow(SchemaDriftError);
    expect(bad({ action: { kind: "NOPE", entityId: "VTI" }, sources: ["a", "b"] })).toThrow(SchemaDriftError);
    // Same entity, kind and effective date twice in one file.
    expect(() => parseCorporateActions(fileOf([DIVIDEND, DIVIDEND]), ctxFor(fileOf([DIVIDEND, DIVIDEND])))).toThrow(SchemaDriftError);
    // Not JSON, and a file missing the dataset field.
    const junk = new TextEncoder().encode("{not json");
    expect(() => parseCorporateActions(junk, ctxFor(junk))).toThrow(SchemaDriftError);
    const noDataset = bytesOf({ actions: [] });
    expect(() => parseCorporateActions(noDataset, ctxFor(noDataset))).toThrow(SchemaDriftError);
  });

  it("rejects unknown provenance fields (strict schema) and nonpositive spin-off values", () => {
    const badEntry = (e: unknown) => () => parseCorporateActions(signed({ dataset: "d", actions: [e] }), ctxFor(signed({ dataset: "d", actions: [e] })));
    // A misspelled announcedAt must fail, not be silently dropped (which would fall back to the ex-date start
    // and could expose the action before its real, later announcement).
    expect(badEntry({ action: DIVIDEND.action, announced_at: "2018-12-20T00:00:00Z", sources: ["a", "b"] })).toThrow(SchemaDriftError);
    // Nonpositive spin-off ratio / childFirstClose would feed a zero or negative distribution into the TR series.
    expect(badEntry({ action: { kind: "SPINOFF", parent: "XLF", child: "XLRE", ratio: "0", exDate: "2015-10-08" }, sources: ["a", "b"] })).toThrow(SchemaDriftError);
    expect(badEntry({ action: { kind: "SPINOFF", parent: "XLF", child: "XLRE", ratio: "0.5", exDate: "2015-10-08", childFirstClose: "-1" }, sources: ["a", "b"] })).toThrow(SchemaDriftError);
    // A field the action's kind does not read: a misspelled optional field would otherwise vanish silently and,
    // for childFirstClose, take the spun-off value out of the parent's total return (Codex, PR #114).
    const { childFirstClose, ...spin } = SPINOFF.action;
    expect(badEntry({ action: { ...spin, childFirstclose: childFirstClose }, sources: ["a", "b"] })).toThrow(/a SPINOFF has no field childFirstclose/);
    expect(badEntry({ action: { kind: "MERGER", entityId: "X", acquirer: "Y", terms: { stockRatio: "0.5", cashPershare: "1" }, effective: "2015-10-08" }, sources: ["a", "b"] })).toThrow(/terms\.cashPershare/);
    expect(badEntry({ action: { ...DIVIDEND.action, note: "special" }, sources: ["a", "b"] })).toThrow(/a CASH_DIVIDEND has no field note/);
    // A null optional field is absent, not unknown.
    const nullClose = signed({ dataset: "d", actions: [{ action: { ...spin, childFirstClose: null }, sources: ["a", "b"] }] });
    expect(parseCorporateActions(nullClose, ctxFor(nullClose))).toHaveLength(1);
    // Unknown top-level key.
    const extra = signed({ dataset: "d", actions: [], oops: 1 });
    expect(() => parseCorporateActions(extra, ctxFor(extra))).toThrow(SchemaDriftError);
  });

  it("counts distinct sources and registers the flag with the quality policy so it bars promotion evidence", () => {
    const dup = { action: { kind: "CASH_DIVIDEND", entityId: "VTI", amount: "0.5", exDate: "2018-12-24", payDate: "2018-12-27", qualified: true }, sources: ["issuer:x", "issuer:x"] };
    const bytes = signed({ dataset: "d", actions: [dup] });
    expect(parseCorporateActions(bytes, ctxFor(bytes))[0]?.qualityFlags).toEqual([UNVERIFIED_SINGLE_SOURCE]);
    // The flag must actually bite: a registered quality code that bars promotion evidence (D-29 P1 fix).
    expect(isQualityCode(UNVERIFIED_SINGLE_SOURCE)).toBe(true);
    expect(blocksPromotionEvidence([UNVERIFIED_SINGLE_SOURCE])).toEqual([UNVERIFIED_SINGLE_SOURCE]);
  });
});

describe("owner approval gate (D-57)", () => {
  const refusal = (bytes: Uint8Array): string[] => {
    try {
      parseCorporateActions(bytes, ctxFor(bytes));
    } catch (err) {
      if (err instanceof UnapprovedCorporateActionsError) return err.reasons;
      throw err;
    }
    return [];
  };
  const file = { dataset: "gate", actions: [DIVIDEND, SPINOFF] };

  it("ingests a file the owner signed over exactly these actions", () => {
    expect(refusal(signed(file))).toEqual([]);
    expect(parseCorporateActions(signed(file), ctxFor(signed(file)))).toHaveLength(2);
  });

  it("refuses an unsigned file, in whole: no observation is produced", () => {
    expect(refusal(signed(file, { approvedBy: null }))).toEqual(["approval.approvedBy is unsigned"]);
    expect(refusal(signed(file, { approvedBy: "   " }))).toEqual(["approval.approvedBy is unsigned"]);
    expect(refusal(signed(file, { approvedAt: null }))).toEqual(["approval.approvedAt is empty"]);
    // A date is not a signature instant - the form the owner's first risk.yaml signature took.
    expect(refusal(signed(file, { approvedAt: "2026-10-05" }))).toEqual(["approval.approvedAt must be an ISO-8601 UTC instant ending in Z"]);
  });

  it("refuses an approval dated after the ingest, and accepts one dated exactly at it", () => {
    expect(refusal(signed(file, { approvedAt: "2026-12-01T00:00:01Z" })).join(" ")).toContain("is after this ingest");
    expect(refusal(signed(file, { approvedAt: ingestedAt }))).toEqual([]);
  });

  it("refuses actions that changed after approval - an amount, an added action, or a reordering", () => {
    const approvedHash = corporateActionsHash(file.actions);
    const edited = { ...DIVIDEND, action: { ...DIVIDEND.action, amount: "0.7501" } };
    expect(refusal(signed({ dataset: "gate", actions: [edited, SPINOFF] }, { actionsHash: approvedHash })).join(" ")).toContain("changed after approval");
    expect(refusal(signed({ dataset: "gate", actions: [DIVIDEND, SPINOFF, { ...DIVIDEND, action: { ...DIVIDEND.action, exDate: "2019-03-25", payDate: "2019-03-28" } }] }, { actionsHash: approvedHash })).join(" ")).toContain("changed after approval");
    expect(refusal(signed({ dataset: "gate", actions: [SPINOFF, DIVIDEND] }, { actionsHash: approvedHash })).join(" ")).toContain("changed after approval");
  });

  it("hashes the actions as written, so a field the schema defaults does not break a valid signature", () => {
    // `sources` defaults to [] when omitted. Hashing the parsed (defaulted) actions instead of the written ones
    // would refuse every file a hand-written entry left it out of - and quietly change what the owner signed.
    const noSources = { action: DIVIDEND.action, announcedAt: DIVIDEND.announcedAt };
    const bytes = signed({ dataset: "gate", actions: [noSources] });
    expect(refusal(bytes)).toEqual([]);
    expect(parseCorporateActions(bytes, ctxFor(bytes))[0]?.qualityFlags).toEqual([UNVERIFIED_SINGLE_SOURCE]);
  });

  it("names every problem at once, and treats a file with no approval block as malformed", () => {
    expect(refusal(signed(file, { approvedBy: null, approvedAt: null, actionsHash: `sha256:${"0".repeat(64)}` }))).toHaveLength(3);
    const bare = bytesOf(file);
    expect(() => parseCorporateActions(bare, ctxFor(bare))).toThrow(SchemaDriftError);
  });

  it("ships an example that is complete but for the owner's signature", () => {
    // config/examples/corporate-actions.example.json documents the format. Its hash is right, so the ONLY reason
    // it is refused is that nobody signed it - which is exactly what a reconciler's output looks like.
    const bytes = new Uint8Array(readFileSync(new URL("../../../config/examples/corporate-actions.example.json", import.meta.url)));
    expect(refusal(bytes)).toEqual(["approval.approvedBy is unsigned", "approval.approvedAt is empty"]);
  });
});

describe("vendored corporate-action ingest", () => {
  function harness() {
    const dir = mkdtempSync(join(tmpdir(), "bg-corpact-"));
    const config = parseAppConfig({ dataDir: dir });
    const { db } = openCoreDb(config);
    return { dir, config, db };
  }

  it("stores one artifact for the file and appends readable observations; a second identical ingest deduplicates", () => {
    const { config, db } = harness();
    const store = new ArtifactStore(config.artifactsDir, db);
    const bytes = fileOf([DIVIDEND, SPINOFF]);

    const outcome = ingestCorporateActions(store, bytes, { calendar, ingestedAt });
    expect(outcome.artifacts).toHaveLength(1);
    expect(outcome.artifacts[0]?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(outcome.observations).toHaveLength(2);
    // Parsed before the artifact is stored, so the hash is computed, not read back: it must be the store's.
    expect(outcome.observations.every((o) => o.rawContentHash === outcome.artifacts[0]?.hash)).toBe(true);

    const repo = new PointInTimeRepository(db);
    const first = repo.appendMany(outcome.observations);
    expect(first.map((r) => r.deduplicated)).toEqual([false, false]);

    const again = ingestCorporateActions(store, bytes, { calendar, ingestedAt });
    expect(again.artifacts[0]?.deduplicated).toBe(true);
    const second = repo.appendMany(again.observations);
    expect(second.every((r) => r.deduplicated)).toBe(true);
    expect(second.every((r) => !r.conflict)).toBe(true);
    db.close();
  });

  it("runs through runIngest with no credentials configured (the file source needs no egress client)", async () => {
    const { dir, config, db } = harness();
    const path = join(dir, "actions.json");
    writeFileSync(path, fileOf([DIVIDEND, SPINOFF]));

    const report = await runIngest({ db, config, calendar }, { source: "corporate-actions", file: path });
    expect(report.source).toBe("corporate-actions");
    expect(report.artifacts).toBe(1);
    expect(report.observations).toBe(2);
    expect(report.requestCount).toBe(0);
    expect(new Ledger(db).events().filter((e) => e.kind === "ingest.completed")).toHaveLength(1);
    db.close();
  });

  it("stores nothing for a refused file - not even the artifact - and records the attempt", async () => {
    const { dir, config, db } = harness();
    const store = new ArtifactStore(config.artifactsDir, db);
    const unsigned = signed({ dataset: "gate", actions: [DIVIDEND] }, { approvedBy: null });
    expect(() => ingestCorporateActions(store, unsigned, { calendar, ingestedAt })).toThrow(UnapprovedCorporateActionsError);
    expect(store.count()).toBe(0);

    const path = join(dir, "unsigned.json");
    writeFileSync(path, unsigned);
    await expect(runIngest({ db, config, calendar }, { source: "corporate-actions", file: path })).rejects.toThrow(UnapprovedCorporateActionsError);
    const events = new Ledger(db).events();
    expect(events.filter((e) => e.kind === "ingest.completed")).toHaveLength(0);
    const refused = events.filter((e) => e.kind === "ingest.refused_unapproved");
    expect(refused).toHaveLength(1);
    expect(JSON.stringify(refused[0]?.payload)).toContain("approval.approvedBy is unsigned");
    expect(store.count()).toBe(0);
    db.close();
  });

  it("makes the XLF/XLRE spin-off readable through the point-in-time path only on or after its ex-date", () => {
    const { config, db } = harness();
    const store = new ArtifactStore(config.artifactsDir, db);
    const outcome = ingestCorporateActions(store, fileOf([SPINOFF]), { calendar, ingestedAt });
    const repo = new PointInTimeRepository(db);
    repo.appendMany(outcome.observations);

    // A decision the day before the ex-date cannot see it (availableAt = ex-date start, +15 min delay).
    const before = repo.asOf({ sourceId: corporateActionSourceId("SPINOFF"), entityId: "XLF", decisionAt: utc("2015-10-07T23:00:00Z") });
    expect(before.rows).toHaveLength(0);

    // A decision the next day sees it, and it round-trips to the same action features/backtest read.
    const after = repo.asOf({ sourceId: corporateActionSourceId("SPINOFF"), entityId: "XLF", decisionAt: utc("2015-10-09T00:00:00Z") });
    expect(after.rows).toHaveLength(1);
    const row = after.rows[0];
    if (!row) throw new Error("missing row");
    const action = corporateActionFromValue(row.value);
    if (action.kind !== "SPINOFF") throw new Error("expected spinoff");
    expect(action.parent).toBe("XLF");
    expect(action.child).toBe("XLRE");
    expect(action.ratio.toFixed()).toBe("0.139146");
    db.close();
  });
});

describe("corporate-actions CLI arguments", () => {
  it("parses --file and the optional --dataset", () => {
    expect(parseIngestArgs(["corporate-actions", "--file", "a.json"])).toEqual({ source: "corporate-actions", file: "a.json", dataset: undefined });
    expect(parseIngestArgs(["corporate-actions", "--file", "a.json", "--dataset", "etf"])).toEqual({ source: "corporate-actions", file: "a.json", dataset: "etf" });
  });

  it("requires --file and rejects unknown flags", () => {
    expect(() => parseIngestArgs(["corporate-actions"])).toThrow(UsageError);
    expect(() => parseIngestArgs(["corporate-actions", "--file", "a.json", "--live"])).toThrow(UsageError);
  });
});
