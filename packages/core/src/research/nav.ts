import { Dec, ONE, ZERO, assertPositive, type IsoDate, type Side } from "@blackgold/shared";

/**
 * Total-return NAV accounting with decimal arithmetic (PLAN.md Phase 1). Cash, quantities, cost basis,
 * proceeds, and NAV are Dec; no binary float touches a ledger invariant. Long-only and cash-funded by
 * construction: a BUY the cash cannot cover and a SELL beyond the held quantity both throw.
 *
 * Tax lots are FIFO. Realized gains split at the one-year boundary: a lot held more than 365 days is
 * LONG_TERM (holding period starts the day after acquisition, so exactly 365 days is still short-term).
 */
export type Lot = { openedAt: IsoDate; quantity: Dec; costPerShare: Dec };

export type Position = {
  entityId: string;
  quantity: Dec;
  /** Total cost basis of open lots (fees included). */
  costBasis: Dec;
  lots: Lot[];
};

export type Fill = { entityId: string; side: Side; quantity: Dec; price: Dec; fees: Dec; session: IsoDate };

export type DividendCredit = { entityId: string; amountPerShare: Dec; payDate: IsoDate; entitledQuantity?: Dec };

export type DividendReceipt = { entityId: string; payDate: IsoDate; amountPerShare: Dec; quantity: Dec; amount: Dec };

export type GainTerm = "SHORT_TERM" | "LONG_TERM";

export type RealizedGain = {
  entityId: string;
  openedAt: IsoDate;
  closedAt: IsoDate;
  quantity: Dec;
  proceeds: Dec;
  costBasis: Dec;
  gain: Dec;
  term: GainTerm;
};

export class InsufficientCashError extends Error {
  constructor(needed: Dec, available: Dec) {
    super(`Insufficient cash: need ${needed.toFixed()}, have ${available.toFixed()}`);
    this.name = "InsufficientCashError";
  }
}
export class InsufficientQuantityError extends Error {
  constructor(entityId: string, requested: Dec, held: Dec) {
    super(`Cannot sell ${requested.toFixed()} ${entityId}: holding ${held.toFixed()} (long-only)`);
    this.name = "InsufficientQuantityError";
  }
}
export class MissingPriceError extends Error {
  constructor(entityId: string) {
    super(`No price for held position ${entityId}`);
    this.name = "MissingPriceError";
  }
}

const MS_PER_DAY = 86_400_000;

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

export function gainTerm(openedAt: IsoDate, closedAt: IsoDate): GainTerm {
  return daysBetween(openedAt, closedAt) > 365 ? "LONG_TERM" : "SHORT_TERM";
}

export class Portfolio {
  private cashBalance: Dec;
  private readonly book = new Map<string, Position>();
  private readonly realized: RealizedGain[] = [];
  private readonly dividendLog: DividendReceipt[] = [];

  constructor(initialCash: Dec) {
    if (initialCash.isNegative()) throw new RangeError("initial cash must be non-negative");
    this.cashBalance = initialCash;
  }

  get cash(): Dec {
    return this.cashBalance;
  }

  get positions(): ReadonlyMap<string, Position> {
    return this.book;
  }

  position(entityId: string): Position | undefined {
    return this.book.get(entityId);
  }

  quantity(entityId: string): Dec {
    return this.book.get(entityId)?.quantity ?? ZERO;
  }

  applyFill(f: Fill): void {
    assertPositive(f.quantity, "fill quantity");
    if (f.price.isNegative()) throw new RangeError("fill price must be non-negative");
    if (f.fees.isNegative()) throw new RangeError("fees must be non-negative");
    const gross = f.quantity.times(f.price);
    if (f.side === "BUY") {
      const cost = gross.plus(f.fees);
      if (cost.gt(this.cashBalance)) throw new InsufficientCashError(cost, this.cashBalance);
      this.cashBalance = this.cashBalance.minus(cost);
      const pos = this.book.get(f.entityId) ?? { entityId: f.entityId, quantity: ZERO, costBasis: ZERO, lots: [] };
      pos.lots.push({ openedAt: f.session, quantity: f.quantity, costPerShare: cost.div(f.quantity) });
      pos.quantity = pos.quantity.plus(f.quantity);
      pos.costBasis = pos.costBasis.plus(cost);
      this.book.set(f.entityId, pos);
      return;
    }
    const pos = this.book.get(f.entityId);
    const held = pos?.quantity ?? ZERO;
    if (!pos || f.quantity.gt(held)) throw new InsufficientQuantityError(f.entityId, f.quantity, held);
    this.cashBalance = this.cashBalance.plus(gross).minus(f.fees);
    this.reduceFifo(pos, f.quantity, f.price, f.fees, f.session);
  }

  /** Cash credit on the pay-date for the quantity entitled at the ex-date (defaults to the current holding). */
  applyDividend(d: DividendCredit): DividendReceipt {
    if (d.amountPerShare.isNegative()) throw new RangeError("dividend amount must be non-negative");
    const quantity = d.entitledQuantity ?? this.quantity(d.entityId);
    const amount = quantity.times(d.amountPerShare);
    this.cashBalance = this.cashBalance.plus(amount);
    const receipt: DividendReceipt = { entityId: d.entityId, payDate: d.payDate, amountPerShare: d.amountPerShare, quantity, amount };
    this.dividendLog.push(receipt);
    return receipt;
  }

  /** Quantity x ratio, cost per share / ratio; total cost basis unchanged. No-op for an unheld entity. */
  applySplit(entityId: string, ratio: Dec): void {
    assertPositive(ratio, "split ratio");
    const pos = this.book.get(entityId);
    if (!pos) return;
    for (const lot of pos.lots) {
      lot.quantity = lot.quantity.times(ratio);
      lot.costPerShare = lot.costPerShare.div(ratio);
    }
    pos.quantity = pos.quantity.times(ratio);
  }

  /** Realize the whole position at finalPrice (zero when null: bankruptcy with no recovery). The loss is booked, not dropped. */
  applyDelisting(entityId: string, finalPrice: Dec | null, session: IsoDate): RealizedGain[] {
    const pos = this.book.get(entityId);
    if (!pos) return [];
    const price = finalPrice ?? ZERO;
    if (price.isNegative()) throw new RangeError("final price must be non-negative");
    const before = this.realized.length;
    this.cashBalance = this.cashBalance.plus(pos.quantity.times(price));
    this.reduceFifo(pos, pos.quantity, price, ZERO, session);
    return this.realized.slice(before);
  }

  /** Cash plus marked positions. Every held entity needs a price; a missing price fails closed. */
  nav(prices: ReadonlyMap<string, Dec>): Dec {
    let total = this.cashBalance;
    for (const pos of this.book.values()) {
      const px = prices.get(pos.entityId);
      if (px === undefined) throw new MissingPriceError(pos.entityId);
      total = total.plus(pos.quantity.times(px));
    }
    return total;
  }

  /** Market value of positions divided by NAV: the realized equity weight used by the exposure-matched benchmark. */
  investedWeight(prices: ReadonlyMap<string, Dec>): Dec {
    const nav = this.nav(prices);
    if (!nav.gt(0)) return ZERO;
    return nav.minus(this.cashBalance).div(nav);
  }

  realizedGains(): readonly RealizedGain[] {
    return this.realized;
  }

  realizedSummary(): { shortTerm: Dec; longTerm: Dec; total: Dec } {
    let shortTerm = ZERO;
    let longTerm = ZERO;
    for (const g of this.realized) {
      if (g.term === "SHORT_TERM") shortTerm = shortTerm.plus(g.gain);
      else longTerm = longTerm.plus(g.gain);
    }
    return { shortTerm, longTerm, total: shortTerm.plus(longTerm) };
  }

  dividends(): readonly DividendReceipt[] {
    return this.dividendLog;
  }

  private reduceFifo(pos: Position, quantity: Dec, price: Dec, fees: Dec, session: IsoDate): void {
    let remaining = quantity;
    const feePerShare = quantity.gt(0) ? fees.div(quantity) : ZERO;
    while (remaining.gt(0)) {
      const lot = pos.lots[0];
      if (!lot) throw new InsufficientQuantityError(pos.entityId, remaining, ZERO);
      const take = lot.quantity.lt(remaining) ? lot.quantity : remaining;
      const costBasis = take.times(lot.costPerShare);
      const proceeds = take.times(price).minus(take.times(feePerShare));
      this.realized.push({
        entityId: pos.entityId,
        openedAt: lot.openedAt,
        closedAt: session,
        quantity: take,
        proceeds,
        costBasis,
        gain: proceeds.minus(costBasis),
        term: gainTerm(lot.openedAt, session),
      });
      lot.quantity = lot.quantity.minus(take);
      pos.costBasis = pos.costBasis.minus(costBasis);
      pos.quantity = pos.quantity.minus(take);
      remaining = remaining.minus(take);
      if (lot.quantity.isZero()) pos.lots.shift();
    }
    if (pos.quantity.isZero()) {
      this.book.delete(pos.entityId);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Daily NAV replay
// ---------------------------------------------------------------------------------------------

export type PortfolioEvent =
  | ({ type: "FILL" } & Fill)
  | { type: "DIVIDEND"; entityId: string; amountPerShare: Dec; payDate: IsoDate; entitledQuantity?: Dec }
  | { type: "SPLIT"; entityId: string; ratio: Dec; exDate: IsoDate }
  | { type: "DELISTING"; entityId: string; finalPrice: Dec | null; session: IsoDate };

export function eventDate(e: PortfolioEvent): IsoDate {
  switch (e.type) {
    case "FILL":
    case "DELISTING":
      return e.session;
    case "DIVIDEND":
      return e.payDate;
    case "SPLIT":
      return e.exDate;
  }
}

export type NavPoint = { session: IsoDate; nav: Dec; cash: Dec; investedWeight: Dec };

/**
 * Replay events in date order and mark NAV at each session close. Events dated on a session are applied
 * before that session's mark; a SPLIT is applied before any same-day fill so raw fill quantities are
 * interpreted in post-split units, matching the raw bars of that day.
 */
export function dailyNavSeries(input: {
  initialCash: Dec;
  events: readonly PortfolioEvent[];
  sessions: readonly IsoDate[];
  closes: (session: IsoDate) => ReadonlyMap<string, Dec>;
}): { points: NavPoint[]; portfolio: Portfolio } {
  const portfolio = new Portfolio(input.initialCash);
  const rank = (e: PortfolioEvent): number => (e.type === "SPLIT" ? 0 : e.type === "DIVIDEND" ? 1 : e.type === "FILL" ? 2 : 3);
  const events = input.events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const da = eventDate(a.e);
      const db = eventDate(b.e);
      if (da !== db) return da < db ? -1 : 1;
      const ra = rank(a.e);
      const rb = rank(b.e);
      return ra !== rb ? ra - rb : a.i - b.i;
    })
    .map((x) => x.e);
  let next = 0;
  const points: NavPoint[] = [];
  for (const session of input.sessions) {
    while (next < events.length) {
      const e = events[next];
      if (!e || eventDate(e) > session) break;
      applyEvent(portfolio, e);
      next++;
    }
    const prices = input.closes(session);
    points.push({ session, nav: portfolio.nav(prices), cash: portfolio.cash, investedWeight: portfolio.investedWeight(prices) });
  }
  return { points, portfolio };
}

export function applyEvent(p: Portfolio, e: PortfolioEvent): void {
  switch (e.type) {
    case "FILL":
      p.applyFill(e);
      return;
    case "DIVIDEND":
      p.applyDividend(e.entitledQuantity === undefined ? { entityId: e.entityId, amountPerShare: e.amountPerShare, payDate: e.payDate } : e);
      return;
    case "SPLIT":
      p.applySplit(e.entityId, e.ratio);
      return;
    case "DELISTING":
      p.applyDelisting(e.entityId, e.finalPrice, e.session);
      return;
  }
}

/** Convenience for tests and reports: NAV relative to the starting NAV. */
export function navReturn(points: readonly NavPoint[]): Dec {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || !first.nav.gt(0)) throw new RangeError("navReturn needs a series starting from a positive NAV");
  return last.nav.div(first.nav).minus(ONE);
}
