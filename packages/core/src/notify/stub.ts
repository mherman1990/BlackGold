import type { UtcInstant } from "@blackgold/shared";
import type { Ledger } from "../ledger/ledger.ts";
import { redact } from "./redact.ts";
import type { Notification, Notifier } from "./types.ts";

/** In-memory notifier for tests and Phase 0. Every send is also a `notify.sent` ledger event. */
export class StubNotifier implements Notifier {
  readonly sent: Notification[] = [];
  private readonly ledger: Ledger | undefined;
  private readonly clock: () => number;

  constructor(ledger?: Ledger, clock: () => number = Date.now) {
    this.ledger = ledger;
    this.clock = clock;
  }

  send(n: Notification): Promise<void> {
    const safe: Notification = { level: n.level, title: redact(n.title), body: redact(n.body) };
    this.sent.push(safe);
    this.ledger?.append("notify.sent", { adapter: "stub", ...safe }, new Date(this.clock()).toISOString() as UtcInstant);
    return Promise.resolve();
  }
}
