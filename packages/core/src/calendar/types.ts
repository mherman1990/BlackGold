import type { IsoDate, UtcInstant } from "@blackgold/shared";

/**
 * Exchange trading calendar (docs/CORE_INTERFACES.md). Dates are exchange-local calendar dates;
 * instants are UTC. Implementations must handle early closes and DST.
 */
export interface ExchangeCalendar {
  readonly exchange: string;
  readonly timeZone: string;
  isSession(date: IsoDate): boolean;
  isEarlyClose(date: IsoDate): boolean;
  /** Regular-session open as a UTC instant. Throws for a non-session date. */
  sessionOpen(date: IsoDate): UtcInstant;
  /** Regular-session close as a UTC instant, honoring early closes. Throws for a non-session date. */
  sessionClose(date: IsoDate): UtcInstant;
  /** First session date whose open is strictly after `after`. */
  nextSession(after: UtcInstant): IsoDate;
  /** Last session date whose close is at or before `before`. */
  previousSession(before: UtcInstant): IsoDate;
  /** All session dates with from <= date <= to, ascending. */
  sessionDates(from: IsoDate, to: IsoDate): IsoDate[];
}

export class NotASessionError extends Error {
  constructor(exchange: string, date: string) {
    super(`${date} is not a trading session on ${exchange}`);
    this.name = "NotASessionError";
  }
}
