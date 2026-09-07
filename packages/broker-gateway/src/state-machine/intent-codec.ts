import { z } from "zod";
import { MODES, canonicalJson, dec, decToString, utc, type Sha256Hex } from "@blackgold/shared";
import type { OrderIntent } from "../types.ts";

/** Wire/storage form of an OrderIntent: every Dec is a canonical decimal string. */
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, "decimal string");
const instant = z.string().transform((s) => utc(s));
const verdict = z.object({ ok: z.boolean(), reasonCodes: z.array(z.string()) });

export const orderIntentJsonSchema = z.object({
  intentId: z.string().min(1),
  clientOrderId: z.string().min(1),
  sleeveAccountId: z.string().min(1),
  mode: z.enum(MODES),
  strategyId: z.string().min(1),
  strategyVersion: z.string().min(1),
  symbol: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
  quantity: decimalString,
  orderType: z.enum(["LIMIT", "MARKET"]),
  limitPrice: decimalString.optional(),
  timeInForce: z.enum(["DAY", "GTC"]),
  extendedHours: z.boolean().optional(),
  protection: z.object({ stopPrice: decimalString, construct: z.enum(["NATIVE_BRACKET", "NATIVE_OCO"]) }).optional(),
  quote: z.object({ bid: decimalString, ask: decimalString, venue: z.string(), at: instant }),
  riskSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  complianceVerdict: verdict,
  riskVerdict: verdict,
  authorizationRef: z.string().optional(),
  approval: z.object({ by: z.string(), at: instant, signature: z.string() }).optional(),
  decisionAt: instant,
  createdAt: instant,
});

export type OrderIntentJson = z.input<typeof orderIntentJsonSchema>;

export function intentToJson(intent: OrderIntent): string {
  const out: OrderIntentJson = {
    intentId: intent.intentId,
    clientOrderId: intent.clientOrderId,
    sleeveAccountId: intent.sleeveAccountId,
    mode: intent.mode,
    strategyId: intent.strategyId,
    strategyVersion: intent.strategyVersion,
    symbol: intent.symbol,
    side: intent.side,
    quantity: decToString(intent.quantity),
    orderType: intent.orderType,
    timeInForce: intent.timeInForce,
    quote: {
      bid: decToString(intent.quote.bid),
      ask: decToString(intent.quote.ask),
      venue: intent.quote.venue,
      at: intent.quote.at,
    },
    riskSnapshotHash: intent.riskSnapshotHash,
    complianceVerdict: intent.complianceVerdict,
    riskVerdict: intent.riskVerdict,
    decisionAt: intent.decisionAt,
    createdAt: intent.createdAt,
  };
  if (intent.limitPrice !== undefined) out.limitPrice = decToString(intent.limitPrice);
  if (intent.extendedHours !== undefined) out.extendedHours = intent.extendedHours;
  if (intent.protection)
    out.protection = { stopPrice: decToString(intent.protection.stopPrice), construct: intent.protection.construct };
  if (intent.authorizationRef !== undefined) out.authorizationRef = intent.authorizationRef;
  if (intent.approval) out.approval = intent.approval;
  return canonicalJson(out);
}

/** Parse and validate a stored or inbound intent. Throws on any malformed field (fail closed). */
export function intentFromJson(json: string): OrderIntent {
  const p = orderIntentJsonSchema.parse(JSON.parse(json));
  const intent: OrderIntent = {
    intentId: p.intentId,
    clientOrderId: p.clientOrderId,
    sleeveAccountId: p.sleeveAccountId,
    mode: p.mode,
    strategyId: p.strategyId,
    strategyVersion: p.strategyVersion,
    symbol: p.symbol,
    side: p.side,
    quantity: dec(p.quantity),
    orderType: p.orderType,
    timeInForce: p.timeInForce,
    quote: { bid: dec(p.quote.bid), ask: dec(p.quote.ask), venue: p.quote.venue, at: p.quote.at },
    riskSnapshotHash: p.riskSnapshotHash as Sha256Hex,
    complianceVerdict: p.complianceVerdict,
    riskVerdict: p.riskVerdict,
    decisionAt: p.decisionAt,
    createdAt: p.createdAt,
  };
  if (p.limitPrice !== undefined) intent.limitPrice = dec(p.limitPrice);
  if (p.extendedHours !== undefined) intent.extendedHours = p.extendedHours;
  if (p.protection) intent.protection = { stopPrice: dec(p.protection.stopPrice), construct: p.protection.construct };
  if (p.authorizationRef !== undefined) intent.authorizationRef = p.authorizationRef;
  if (p.approval) intent.approval = p.approval;
  return intent;
}
