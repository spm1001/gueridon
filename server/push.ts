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
import { emit, errorDetail } from "./event-bus.js";

const CONFIG_DIR = join(homedir(), ".config", "gueridon");
const VAPID_PATH = join(CONFIG_DIR, "vapid.json");
const SUBS_PATH = join(CONFIG_DIR, "push-subscriptions.json");

let vapidReady = false;
let publicKey = "";

// Subscription keyed by endpoint URL (deduplicates re-subscribes)
let subscriptions: Map<string, webpush.PushSubscription> = new Map();

// Safety cap — prevents unbounded growth across SW re-registrations
const MAX_SUBSCRIPTIONS = 5;

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
    emit({ type: "push:init", status: "error", detail: errorDetail(e) });
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

  // Cap: if over limit, drop oldest (Map preserves insertion order)
  while (subscriptions.size > MAX_SUBSCRIPTIONS) {
    const oldest = subscriptions.keys().next().value;
    if (oldest && oldest !== sub.endpoint) {
      subscriptions.delete(oldest);
    } else break;
  }

  saveSubscriptions();
  emit({ type: "push:subscribe", total: subscriptions.size });

  // Validate existing subs in the background — prune dead endpoints
  pruneStaleSubscriptions(sub.endpoint).catch(() => {});
}

/**
 * Validate all existing subscriptions by sending a zero-TTL ping.
 * Dead endpoints return 410/404/403 from the push service without
 * reaching the browser. Any that fail are pruned.
 */
async function pruneStaleSubscriptions(excludeEndpoint: string): Promise<void> {
  if (!vapidReady) return;

  const stale: string[] = [];

  for (const [endpoint, sub] of subscriptions) {
    if (endpoint === excludeEndpoint) continue;
    try {
      await webpush.sendNotification(sub, JSON.stringify({ type: "validate" }), { TTL: 0 });
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 410 || statusCode === 404 || statusCode === 403) {
        stale.push(endpoint);
      }
      // Other errors (network, 429) — leave the sub alone
    }
  }

  if (stale.length > 0) {
    for (const ep of stale) subscriptions.delete(ep);
    saveSubscriptions();
    emit({ type: "push:subscribe-prune", pruned: stale.length, remaining: subscriptions.size });
  }
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
  let sent = 0;

  for (const [endpoint, sub] of subscriptions) {
    try {
      await webpush.sendNotification(sub, data);
      sent++;
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 410 || statusCode === 404 || statusCode === 403) {
        // Subscription expired, invalid, or JWT rejected — remove it.
        // 403 BadJwtToken from Apple means the subscription needs re-creating.
        expired.push(endpoint);
      } else {
        emit({ type: "push:send-fail", endpoint: endpoint.slice(0, 60), error: errorDetail(err) });
      }
    }
  }

  if (expired.length > 0) {
    for (const ep of expired) subscriptions.delete(ep);
    saveSubscriptions();
    emit({ type: "push:expired-cleanup", count: expired.length });
  }

  if (sent > 0) {
    emit({ type: "push:send-ok", sent, tag: payload.tag });
  }
}

/** Send "turn complete" push. Enriches body for share-sheet sessions. */
export function pushTurnComplete(folder: string, shareContext?: { filename: string }): Promise<void> {
  const name = folder.split("/").pop() || folder;
  const body = shareContext
    ? `Processed ${shareContext.filename} in ${name}`
    : `Claude finished in ${name}`;
  return sendPush({
    title: "Guéridon",
    body,
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

// For unit testing — reset module state without re-importing
export const _testing = {
  reset(subs: Map<string, webpush.PushSubscription> = new Map()) {
    subscriptions = subs;
    vapidReady = true;
  },
  getSubscriptions() { return subscriptions; },
  pruneStaleSubscriptions,
};

// Initialize on module load
init();
