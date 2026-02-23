/**
 * Web Push notification support for Guéridon.
 *
 * Sends push notifications to subscribed clients when no WebSocket
 * connections are active (phone-in-pocket scenario).
 *
 * VAPID keys: ~/.config/gueridon/vapid.json (generated once)
 * Subscriptions: ~/.config/gueridon/push-subscriptions.json (persisted)
 */

import webpush from "web-push";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { emit } from "./event-bus.js";

const CONFIG_DIR = join(homedir(), ".config", "gueridon");
const VAPID_PATH = join(CONFIG_DIR, "vapid.json");
const SUBS_PATH = join(CONFIG_DIR, "push-subscriptions.json");

let vapidReady = false;
let publicKey = "";

// Subscription keyed by endpoint URL (deduplicates re-subscribes)
let subscriptions: Map<string, webpush.PushSubscription> = new Map();

function init(): void {
  if (!existsSync(VAPID_PATH)) {
    emit({ type: "push:init", status: "disabled", detail: VAPID_PATH });
    return;
  }
  try {
    const keys = JSON.parse(readFileSync(VAPID_PATH, "utf-8"));
    publicKey = keys.publicKey;
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:gueridon@planetmodha.com",
      keys.publicKey, keys.privateKey,
    );
    vapidReady = true;
    emit({ type: "push:init", status: "configured" });
  } catch (e) {
    emit({ type: "push:init", status: "error", detail: String(e) });
    return;
  }
  loadSubscriptions();
}

function loadSubscriptions(): void {
  if (!existsSync(SUBS_PATH)) return;
  try {
    const data = JSON.parse(readFileSync(SUBS_PATH, "utf-8")) as webpush.PushSubscription[];
    subscriptions = new Map(data.map((s) => [s.endpoint, s]));
    emit({ type: "push:subscriptions-loaded", count: subscriptions.size });
  } catch {
    emit({ type: "push:subscriptions-load-error" });
  }
}

function saveSubscriptions(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(SUBS_PATH, JSON.stringify([...subscriptions.values()], null, 2));
}

/** Get the VAPID public key for client subscription. */
export function getVapidPublicKey(): string | null {
  return vapidReady ? publicKey : null;
}

/** Store a push subscription from a client. */
export function addSubscription(sub: webpush.PushSubscription): void {
  subscriptions.set(sub.endpoint, sub);
  saveSubscriptions();
  emit({ type: "push:subscribe", total: subscriptions.size });
}

/** Remove a push subscription. */
export function removeSubscription(endpoint: string): void {
  if (subscriptions.delete(endpoint)) {
    saveSubscriptions();
    emit({ type: "push:unsubscribe", total: subscriptions.size });
  }
}

/**
 * Send a push notification to all subscribers.
 * Called when CC finishes a turn or needs input and no SSE clients are connected.
 */
export async function sendPush(payload: {
  title: string;
  body: string;
  tag: string;
  folder: string;
  vibrate: number[];
}): Promise<void> {
  if (!vapidReady || subscriptions.size === 0) return;

  const data = JSON.stringify(payload);
  const expired: string[] = [];

  for (const [endpoint, sub] of subscriptions) {
    try {
      await webpush.sendNotification(sub, data);
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 410 || statusCode === 404 || statusCode === 403) {
        // Subscription expired, invalid, or JWT rejected — remove it.
        // 403 BadJwtToken from Apple means the subscription needs re-creating.
        expired.push(endpoint);
      } else {
        emit({ type: "push:send-fail", endpoint: endpoint.slice(0, 60), error: String(err) });
      }
    }
  }

  if (expired.length > 0) {
    for (const ep of expired) subscriptions.delete(ep);
    saveSubscriptions();
    emit({ type: "push:expired-cleanup", count: expired.length });
  }
}

/** Send "turn complete" push. */
export function pushTurnComplete(folder: string): Promise<void> {
  const name = folder.split("/").pop() || folder;
  return sendPush({
    title: "Guéridon",
    body: `Claude finished in ${name}`,
    tag: `gueridon-done-${name}`,
    folder,
    vibrate: [200],
  });
}

/** Send "needs input" push. */
export function pushAskUser(folder: string): Promise<void> {
  const name = folder.split("/").pop() || folder;
  return sendPush({
    title: "Guéridon",
    body: `Claude needs your input in ${name}`,
    tag: `gueridon-ask-${name}`,
    folder,
    vibrate: [200, 100, 200],
  });
}

// Initialize on module load
init();
