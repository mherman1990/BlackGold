import { AccountBoundaryViolation, AllowlistConfigError } from "../errors.ts";
import type { OrderIntent } from "../types.ts";

/**
 * Exactly one account may trade: the registered `blackgold_sleeve`. No wildcard, no default, no list.
 * Accepts a single id or a one-element array so a misconfigured multi-account list fails at construction.
 */
export class SleeveAllowlist {
  readonly allowedAccountId: string;

  constructor(allowed: string | readonly string[]) {
    const ids = typeof allowed === "string" ? [allowed] : [...allowed];
    if (ids.length !== 1) throw new AllowlistConfigError(`exactly one sleeve account id is required, got ${ids.length}`);
    const id = ids[0] ?? "";
    if (id.trim().length === 0) throw new AllowlistConfigError("sleeve account id is empty");
    if (/[*?%,;\s]/.test(id)) throw new AllowlistConfigError("sleeve account id may not contain wildcard or separator characters");
    this.allowedAccountId = id;
  }

  isAllowed(accountId: string): boolean {
    return accountId === this.allowedAccountId;
  }

  assertSleeve(intent: OrderIntent): void {
    if (!this.isAllowed(intent.sleeveAccountId)) throw new AccountBoundaryViolation();
  }
}
