import { describe, expect, it } from "vitest";
import { dec } from "@blackgold/shared";
import {
  SyntheticReadOnlyView,
  UnknownAccountError,
  health,
  type BrokerTradingAdapter,
  type ReadOnlyAccountView,
} from "../src/index.ts";
import { OTHER, T0 } from "./helpers.ts";

const view: ReadOnlyAccountView = new SyntheticReadOnlyView([
  [
    OTHER,
    {
      positions: [{ symbol: "VTI", quantity: dec(10), averageCost: dec("250.00"), asOf: T0 }],
      balances: { cash: dec("1000.00"), equity: dec("3500.00"), asOf: T0 },
    },
  ],
]);

describe("SyntheticReadOnlyView surface", () => {
  it("exposes exactly positions and balances on its prototype and nothing else", () => {
    const names = Object.getOwnPropertyNames(SyntheticReadOnlyView.prototype).sort();
    expect(names).toEqual(["balances", "constructor", "positions"]);
    // No own enumerable state that could be reached for mutation either.
    expect(Object.getOwnPropertyNames(new SyntheticReadOnlyView([]))).toEqual([]);
    // No static mutation helpers hanging off the class.
    expect(Object.getOwnPropertyNames(SyntheticReadOnlyView).sort()).toEqual(["length", "name", "prototype"]);
  });

  it("has no mutation methods at the type level", () => {
    // @ts-expect-error submit does not exist on a read-only view
    expect(view.submit).toBeUndefined();
    // @ts-expect-error cancel does not exist on a read-only view
    expect(view.cancel).toBeUndefined();
    // @ts-expect-error transfer does not exist on a read-only view
    expect(view.transfer).toBeUndefined();
    // @ts-expect-error withdraw does not exist on a read-only view
    expect(view.withdraw).toBeUndefined();

    type ForbiddenEverywhere = "withdraw" | "transfer" | "journal" | "updateProfile" | "rawRequest" | "replace";
    const noneOnView: Extract<keyof ReadOnlyAccountView, ForbiddenEverywhere | "submit" | "cancel"> extends never
      ? true
      : false = true;
    const noneOnAdapter: Extract<keyof BrokerTradingAdapter, ForbiddenEverywhere> extends never ? true : false = true;
    expect(noneOnView).toBe(true);
    expect(noneOnAdapter).toBe(true);
  });

  it("answers for accounts it holds and refuses the rest without echoing the reference", async () => {
    const positions = await view.positions(OTHER);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.quantity.eq(dec(10))).toBe(true);
    const balances = await view.balances(OTHER);
    expect(balances.cash.eq(dec("1000"))).toBe(true);
    let caught: unknown;
    try {
      await view.positions("NOT-HELD-9999");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownAccountError);
    expect(String(caught)).not.toContain("NOT-HELD-9999");
    await expect(view.balances("NOT-HELD-9999")).rejects.toThrow(UnknownAccountError);
  });

  it("returns copies, so a caller cannot mutate the view's data through the result", async () => {
    const a = await view.positions(OTHER);
    a.pop();
    expect(await view.positions(OTHER)).toHaveLength(1);
  });
});

describe("health", () => {
  it("declares no live capability, no credential, and the synthetic adapter only", () => {
    expect(health()).toEqual({ ok: true, role: "gateway", liveCapable: false, credentialLoaded: false, adapters: ["synthetic"] });
  });
});
