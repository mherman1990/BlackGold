import { NotImplementedError } from "../errors.ts";
import { redact } from "./redact.ts";
import type { Notification, Notifier } from "./types.ts";

/**
 * ntfy adapter (D-17). Phase 0 validates configuration only: there are no network calls in this build.
 * Delivery lands in Phase 5.
 */
export class NtfyNotifier implements Notifier {
  readonly topicUrl: URL;

  constructor(topicUrl: string) {
    this.topicUrl = validateNtfyTopicUrl(topicUrl);
  }

  send(n: Notification): Promise<void> {
    redact(n.title);
    redact(n.body);
    return Promise.reject(new NotImplementedError("ntfy delivery is Phase 5"));
  }
}

export function validateNtfyTopicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`ntfy topic URL is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("ntfy topic URL must be http(s)");
  if (url.username !== "" || url.password !== "") throw new TypeError("ntfy topic URL must not embed credentials");
  const topic = url.pathname.replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) throw new TypeError("ntfy topic URL must end in a single topic segment");
  if (url.search !== "" || url.hash !== "") throw new TypeError("ntfy topic URL must not carry a query or fragment");
  return url;
}
