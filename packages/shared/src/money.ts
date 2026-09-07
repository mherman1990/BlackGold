import { Decimal } from "decimal.js";

/**
 * Money, price, quantity, and return arithmetic use Decimal, never binary float.
 * A dedicated Decimal clone keeps our configuration independent of any other consumer.
 */
export const Dec = Decimal.clone({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -20, toExpPos: 40 });
export type Dec = InstanceType<typeof Dec>;

export type DecimalInput = string | number | bigint | Dec;

/** Construct a Decimal. Numbers are accepted only if they are safe integers, to prevent float contamination. */
export function dec(value: DecimalInput): Dec {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`Non-integer number ${value} passed to dec(); pass a string instead`);
    }
    return new Dec(value);
  }
  if (typeof value === "bigint") return new Dec(value.toString());
  return new Dec(value);
}

export const ZERO: Dec = new Dec(0);
export const ONE: Dec = new Dec(1);

export function sumDec(values: Iterable<Dec>): Dec {
  let total = ZERO;
  for (const v of values) total = total.plus(v);
  return total;
}

/** Round to a fixed number of decimal places with banker's rounding. Cash amounts use 2, prices up to 4. */
export function roundTo(value: Dec, places: number): Dec {
  return value.toDecimalPlaces(places, Decimal.ROUND_HALF_EVEN);
}

export function assertNonNegative(value: Dec, label: string): void {
  if (value.isNegative()) throw new RangeError(`${label} must be non-negative, got ${value.toString()}`);
}

/** Strictly greater than zero. decimal.js reports +0 as "positive", so never use isPositive() for this check. */
export function isStrictlyPositive(value: Dec): boolean {
  return value.gt(0);
}

export function assertPositive(value: Dec, label: string): void {
  if (!value.gt(0)) throw new RangeError(`${label} must be positive, got ${value.toString()}`);
}

/** Serialize for storage or hashing: canonical string form, no exponent. */
export function decToString(value: Dec): string {
  return value.toFixed();
}
