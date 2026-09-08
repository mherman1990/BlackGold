import { Dec, dec, isoDate, utc, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { PointInTimeObservation } from "../data/pit/types.ts";

/**
 * Raw market data and corporate-action records (docs/DATA_PROVENANCE_SPEC.md sections 4 and 5).
 *
 * A RawBar is the price as printed on the date: never adjusted. Share quantities, fills, and stop
 * distances come from RawBar. Returns never do; they come from TotalReturnSeries (market/series.ts).
 */
export type RawBar = {
  symbol: string;
  session: IsoDate;
  open: Dec;
  high: Dec;
  low: Dec;
  close: Dec;
  volume: bigint;
  /** Venue / entitlement label, e.g. "iex". Never "NBBO" for a single-venue feed. */
  venue: string;
};

export class MalformedBarError extends Error {
  constructor(detail: string) {
    super(`Malformed bar value: ${detail}`);
    this.name = "MalformedBarError";
  }
}

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Decimal fields arrive as strings from the adapter's canonical JSON; numbers are tolerated via their shortest textual form. */
export function decFromJson(v: unknown, field: string): Dec {
  if (typeof v === "string") {
    if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) throw new MalformedBarError(`${field} is not a decimal string: ${v}`);
    return new Dec(v);
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new MalformedBarError(`${field} is not finite`);
    return new Dec(v.toString());
  }
  if (typeof v === "bigint") return dec(v);
  if (v instanceof Dec) return v;
  throw new MalformedBarError(`${field} missing or of unsupported type`);
}

function bigintFromJson(v: unknown, field: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new MalformedBarError(`${field} must be a non-negative integer`);
}

function stringFromJson(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) throw new MalformedBarError(`${field} must be a non-empty string`);
  return v;
}

/**
 * Convert the adapter's stored JSON value ({symbol, session, open, high, low, close, volume, venue}) into
 * a RawBar with Dec prices. Volume may be a string (canonical JSON renders bigint as string) or an integer.
 */
export function rawBarFromValue(value: unknown, defaults: { symbol?: string; venue?: string } = {}): RawBar {
  if (!isRecord(value)) throw new MalformedBarError("value is not an object");
  const symbolRaw = value["symbol"] ?? defaults.symbol;
  const venueRaw = value["venue"] ?? defaults.venue ?? "unknown";
  const bar: RawBar = {
    symbol: stringFromJson(symbolRaw, "symbol"),
    session: isoDate(stringFromJson(value["session"], "session")),
    open: decFromJson(value["open"], "open"),
    high: decFromJson(value["high"], "high"),
    low: decFromJson(value["low"], "low"),
    close: decFromJson(value["close"], "close"),
    volume: bigintFromJson(value["volume"], "volume"),
    venue: stringFromJson(venueRaw, "venue"),
  };
  for (const [k, p] of [
    ["open", bar.open],
    ["high", bar.high],
    ["low", bar.low],
    ["close", bar.close],
  ] as const) {
    if (p.isNegative()) throw new MalformedBarError(`${k} is negative`);
  }
  if (bar.high.lt(bar.low)) throw new MalformedBarError("high < low");
  return bar;
}

/** Serialize a RawBar to the JSON shape stored in an observation value. */
export function rawBarToValue(bar: RawBar): Json {
  return {
    symbol: bar.symbol,
    session: bar.session,
    open: bar.open.toFixed(),
    high: bar.high.toFixed(),
    low: bar.low.toFixed(),
    close: bar.close.toFixed(),
    volume: bar.volume.toString(),
    venue: bar.venue,
  };
}

// ---------------------------------------------------------------------------------------------
// Corporate actions (spec section 5)
// ---------------------------------------------------------------------------------------------

export const CORPORATE_ACTION_KINDS = [
  "SPLIT",
  "CASH_DIVIDEND",
  "SYMBOL_CHANGE",
  "MERGER",
  "SPINOFF",
  "DELISTING",
  "STALE_BAR",
  "CORRECTED_BAR",
] as const;
export type CorporateActionKind = (typeof CORPORATE_ACTION_KINDS)[number];

/** ratio 4 means 4 new shares for each old share; a reverse split 1:10 is ratio "0.1". */
export type SplitAction = { kind: "SPLIT"; entityId: string; ratio: Dec; exDate: IsoDate };
export type CashDividendAction = {
  kind: "CASH_DIVIDEND";
  entityId: string;
  /** Per share held at the ex-date, in raw (unadjusted) share units. */
  amount: Dec;
  exDate: IsoDate;
  payDate: IsoDate;
  qualified: boolean;
};
export type SymbolChangeAction = { kind: "SYMBOL_CHANGE"; entityId: string; oldSymbol: string; newSymbol: string; effective: IsoDate };
export type MergerAction = {
  kind: "MERGER";
  /** The target: its series ends at `effective`. */
  entityId: string;
  acquirer: string;
  terms: { cashPerShare?: Dec; stockRatio?: Dec };
  effective: IsoDate;
};
export type SpinoffAction = {
  kind: "SPINOFF";
  parent: string;
  child: string;
  /** Child shares received per parent share. */
  ratio: Dec;
  exDate: IsoDate;
  /** Child's first raw close; when present the spun value is a cash-equivalent distribution in the parent's TR series. */
  childFirstClose?: Dec;
  /** Ticker the child trades under from the ex-date; defaults to the child entity id. */
  childSymbol?: string;
};
export type DelistingAction = { kind: "DELISTING"; entityId: string; lastTradeDate: IsoDate; reason: string; finalPrice: Dec | null };
export type StaleBarAction = { kind: "STALE_BAR"; entityId: string; session: IsoDate; reason: string };
export type CorrectedBarAction = {
  kind: "CORRECTED_BAR";
  entityId: string;
  session: IsoDate;
  /** rawContentHash of the bar being corrected. */
  priorHash: string;
  open: Dec;
  high: Dec;
  low: Dec;
  close: Dec;
  volume: bigint;
};

export type CorporateAction =
  | SplitAction
  | CashDividendAction
  | SymbolChangeAction
  | MergerAction
  | SpinoffAction
  | DelistingAction
  | StaleBarAction
  | CorrectedBarAction;

export function corporateActionSourceId(kind: CorporateActionKind): string {
  return `corporate_action.${kind}`;
}

/** The entity the action is recorded against (the parent for a spin-off, the target for a merger). */
export function actionEntityId(a: CorporateAction): string {
  return a.kind === "SPINOFF" ? a.parent : a.entityId;
}

/** Ex-date or effective date: the `effectiveAt` of the observation and the day the series/positions change. */
export function actionEffectiveDate(a: CorporateAction): IsoDate {
  switch (a.kind) {
    case "SPLIT":
    case "CASH_DIVIDEND":
    case "SPINOFF":
      return a.exDate;
    case "SYMBOL_CHANGE":
    case "MERGER":
      return a.effective;
    case "DELISTING":
      return a.lastTradeDate;
    case "STALE_BAR":
    case "CORRECTED_BAR":
      return a.session;
  }
}

export function dateStartUtc(date: IsoDate): UtcInstant {
  return utc(`${date}T00:00:00Z`);
}

export class MalformedCorporateActionError extends Error {
  constructor(detail: string) {
    super(`Malformed corporate action: ${detail}`);
    this.name = "MalformedCorporateActionError";
  }
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) throw new MalformedCorporateActionError(`${field} must be a non-empty string`);
  return v;
}
function date(v: unknown, field: string): IsoDate {
  return isoDate(str(v, field));
}
function num(v: unknown, field: string): Dec {
  try {
    return decFromJson(v, field);
  } catch (e) {
    throw new MalformedCorporateActionError(e instanceof Error ? e.message : field);
  }
}

/** Parse a stored observation value back into a CorporateAction with Dec fields. */
export function corporateActionFromValue(value: unknown): CorporateAction {
  if (!isRecord(value)) throw new MalformedCorporateActionError("value is not an object");
  const kind = value["kind"];
  if (typeof kind !== "string" || !(CORPORATE_ACTION_KINDS as readonly string[]).includes(kind)) {
    throw new MalformedCorporateActionError(`unknown kind ${typeof kind === "string" ? kind : "<non-string>"}`);
  }
  switch (kind as CorporateActionKind) {
    case "SPLIT": {
      const ratio = num(value["ratio"], "ratio");
      if (!ratio.gt(0)) throw new MalformedCorporateActionError("split ratio must be positive");
      return { kind: "SPLIT", entityId: str(value["entityId"], "entityId"), ratio, exDate: date(value["exDate"], "exDate") };
    }
    case "CASH_DIVIDEND": {
      const amount = num(value["amount"], "amount");
      if (amount.isNegative()) throw new MalformedCorporateActionError("dividend amount must be non-negative");
      const exDate = date(value["exDate"], "exDate");
      const payDate = date(value["payDate"], "payDate");
      if (payDate < exDate) throw new MalformedCorporateActionError("payDate precedes exDate");
      return { kind: "CASH_DIVIDEND", entityId: str(value["entityId"], "entityId"), amount, exDate, payDate, qualified: value["qualified"] === true };
    }
    case "SYMBOL_CHANGE":
      return {
        kind: "SYMBOL_CHANGE",
        entityId: str(value["entityId"], "entityId"),
        oldSymbol: str(value["oldSymbol"], "oldSymbol"),
        newSymbol: str(value["newSymbol"], "newSymbol"),
        effective: date(value["effective"], "effective"),
      };
    case "MERGER": {
      const termsRaw = value["terms"];
      if (!isRecord(termsRaw)) throw new MalformedCorporateActionError("terms must be an object");
      const terms: MergerAction["terms"] = {};
      if (termsRaw["cashPerShare"] !== undefined && termsRaw["cashPerShare"] !== null) terms.cashPerShare = num(termsRaw["cashPerShare"], "terms.cashPerShare");
      if (termsRaw["stockRatio"] !== undefined && termsRaw["stockRatio"] !== null) terms.stockRatio = num(termsRaw["stockRatio"], "terms.stockRatio");
      if (terms.cashPerShare === undefined && terms.stockRatio === undefined) throw new MalformedCorporateActionError("merger terms need cashPerShare or stockRatio");
      if (terms.cashPerShare?.isNegative()) throw new MalformedCorporateActionError("merger cashPerShare must be non-negative");
      if (terms.stockRatio !== undefined && !terms.stockRatio.gt(0)) throw new MalformedCorporateActionError("merger stockRatio must be positive");
      return { kind: "MERGER", entityId: str(value["entityId"], "entityId"), acquirer: str(value["acquirer"], "acquirer"), terms, effective: date(value["effective"], "effective") };
    }
    case "SPINOFF": {
      const a: SpinoffAction = {
        kind: "SPINOFF",
        parent: str(value["parent"], "parent"),
        child: str(value["child"], "child"),
        ratio: num(value["ratio"], "ratio"),
        exDate: date(value["exDate"], "exDate"),
      };
      if (!a.ratio.gt(0)) throw new MalformedCorporateActionError("spinoff ratio must be positive");
      if (value["childFirstClose"] !== undefined && value["childFirstClose"] !== null) a.childFirstClose = num(value["childFirstClose"], "childFirstClose");
      if (a.childFirstClose !== undefined && !a.childFirstClose.gt(0)) throw new MalformedCorporateActionError("spinoff childFirstClose must be positive");
      if (typeof value["childSymbol"] === "string") a.childSymbol = value["childSymbol"];
      return a;
    }
    case "DELISTING": {
      const fp = value["finalPrice"];
      return {
        kind: "DELISTING",
        entityId: str(value["entityId"], "entityId"),
        lastTradeDate: date(value["lastTradeDate"], "lastTradeDate"),
        reason: str(value["reason"], "reason"),
        finalPrice: fp === null || fp === undefined ? null : num(fp, "finalPrice"),
      };
    }
    case "STALE_BAR":
      return { kind: "STALE_BAR", entityId: str(value["entityId"], "entityId"), session: date(value["session"], "session"), reason: str(value["reason"], "reason") };
    case "CORRECTED_BAR":
      return {
        kind: "CORRECTED_BAR",
        entityId: str(value["entityId"], "entityId"),
        session: date(value["session"], "session"),
        priorHash: str(value["priorHash"], "priorHash"),
        open: num(value["open"], "open"),
        high: num(value["high"], "high"),
        low: num(value["low"], "low"),
        close: num(value["close"], "close"),
        volume: bigintFromJson(value["volume"], "volume"),
      };
  }
}

/** Serialize with decimals as strings (canonical JSON does this for Dec anyway; explicit is reproducible). */
export function corporateActionToValue(a: CorporateAction): Json {
  switch (a.kind) {
    case "SPLIT":
      return { kind: a.kind, entityId: a.entityId, ratio: a.ratio.toFixed(), exDate: a.exDate };
    case "CASH_DIVIDEND":
      return { kind: a.kind, entityId: a.entityId, amount: a.amount.toFixed(), exDate: a.exDate, payDate: a.payDate, qualified: a.qualified };
    case "SYMBOL_CHANGE":
      return { kind: a.kind, entityId: a.entityId, oldSymbol: a.oldSymbol, newSymbol: a.newSymbol, effective: a.effective };
    case "MERGER":
      return {
        kind: a.kind,
        entityId: a.entityId,
        acquirer: a.acquirer,
        terms: {
          ...(a.terms.cashPerShare === undefined ? {} : { cashPerShare: a.terms.cashPerShare.toFixed() }),
          ...(a.terms.stockRatio === undefined ? {} : { stockRatio: a.terms.stockRatio.toFixed() }),
        },
        effective: a.effective,
      };
    case "SPINOFF":
      return {
        kind: a.kind,
        parent: a.parent,
        child: a.child,
        ratio: a.ratio.toFixed(),
        exDate: a.exDate,
        ...(a.childFirstClose === undefined ? {} : { childFirstClose: a.childFirstClose.toFixed() }),
        ...(a.childSymbol === undefined ? {} : { childSymbol: a.childSymbol }),
      };
    case "DELISTING":
      return { kind: a.kind, entityId: a.entityId, lastTradeDate: a.lastTradeDate, reason: a.reason, finalPrice: a.finalPrice === null ? null : a.finalPrice.toFixed() };
    case "STALE_BAR":
      return { kind: a.kind, entityId: a.entityId, session: a.session, reason: a.reason };
    case "CORRECTED_BAR":
      return {
        kind: a.kind,
        entityId: a.entityId,
        session: a.session,
        priorHash: a.priorHash,
        open: a.open.toFixed(),
        high: a.high.toFixed(),
        low: a.low.toFixed(),
        close: a.close.toFixed(),
        volume: a.volume.toString(),
      };
  }
}

export type CorporateActionProvenance = {
  sourceLocator: string;
  /** Announcement or first public record instant. Must be >= the effective date's start. */
  availableAt: UtcInstant;
  ingestedAt: UtcInstant;
  rawContentHash: string;
  adapterVersion: string;
  parserVersion: string;
  qualityFlags?: string[];
};

/**
 * Wrap a corporate action as a PointInTimeObservation: sourceId `corporate_action.<KIND>`, entityId the
 * subject entity, effectiveAt the ex/effective date at 00:00Z. The repository rejects availableAt earlier
 * than effectiveAt (TEMPORAL_INVERSION), so an action announced before its ex-date must still use the
 * announcement instant only if it is not earlier than the ex-date start; otherwise use the ex-date start.
 */
export function corporateActionObservation(action: CorporateAction, p: CorporateActionProvenance): PointInTimeObservation<Json> {
  return {
    sourceId: corporateActionSourceId(action.kind),
    sourceLocator: p.sourceLocator,
    entityId: actionEntityId(action),
    effectiveAt: dateStartUtc(actionEffectiveDate(action)),
    availableAt: p.availableAt,
    ingestedAt: p.ingestedAt,
    rawContentHash: p.rawContentHash,
    adapterVersion: p.adapterVersion,
    parserVersion: p.parserVersion,
    value: corporateActionToValue(action),
    qualityFlags: [...(p.qualityFlags ?? [])],
  };
}
