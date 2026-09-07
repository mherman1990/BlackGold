export type NotificationLevel = "info" | "warn" | "urgent";

export type Notification = { level: NotificationLevel; title: string; body: string };

/** Delivery channel for operator notifications. Notifications never carry dollar totals or credentials. */
export interface Notifier {
  send(n: Notification): Promise<void>;
}
