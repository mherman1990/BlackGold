import { UnknownAccountError } from "../../errors.ts";
import type { Balances, Position, ReadOnlyAccountView } from "../../types.ts";

export type AccountSnapshot = { positions: readonly Position[]; balances: Balances };

/**
 * Read-only view over non-sleeve accounts. It has exactly two methods, positions and balances, and nothing else:
 * no order, cancel, replace, transfer, or mutation surface exists on this type or its prototype. A reflection test
 * and a type-level test in test/read-only.test.ts keep it that way.
 */
export class SyntheticReadOnlyView implements ReadOnlyAccountView {
  readonly #accounts: ReadonlyMap<string, AccountSnapshot>;

  constructor(accounts: ReadonlyMap<string, AccountSnapshot> | Iterable<readonly [string, AccountSnapshot]>) {
    this.#accounts = new Map(accounts);
  }

  positions(accountRef: string): Promise<Position[]> {
    const a = this.#accounts.get(accountRef);
    if (!a) return Promise.reject(new UnknownAccountError());
    return Promise.resolve(a.positions.map((p) => ({ ...p })));
  }

  balances(accountRef: string): Promise<Balances> {
    const a = this.#accounts.get(accountRef);
    if (!a) return Promise.reject(new UnknownAccountError());
    return Promise.resolve({ ...a.balances });
  }
}
