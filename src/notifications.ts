/**
 * Notification system for Guéridon.
 *
 * Handles service worker registration, permission requests,
 * push subscription, and showing notifications when Claude
 * finishes or needs input.
 *
 * Notifications only fire when the page is NOT focused — no point
 * notifying someone who's already looking at the screen.
 *
 * Push notifications fire from the bridge when no WS clients are
 * connected (phone-in-pocket scenario).
 */

let swRegistration: ServiceWorkerRegistration | null = null;
let swReady: Promise<ServiceWorkerRegistration | null>;
let permissionGranted = false;

/** Register the service worker. Call once at startup. */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) {
    swReady = Promise.resolve(null);
    return;
  }
  swReady = navigator.serviceWorker.register("/sw.js").then(
    (reg) => { swRegistration = reg; return reg; },
    (e) => { console.warn("[notifications] SW registration failed:", e); return null; },
  );
}

/**
 * Request notification permission. Must be called from a user gesture
 * (e.g. first prompt submission). Returns true if granted.
 */
export async function requestPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") {
    permissionGranted = true;
    return true;
  }
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  permissionGranted = result === "granted";
  return permissionGranted;
}

/**
 * Subscribe to push notifications via the bridge.
 * Called after permission is granted and lobbyConnected provides the VAPID key.
 * Sends the subscription to the bridge for server-side push delivery.
 */
export async function subscribeToPush(
  vapidPublicKey: string,
  sendToBridge: (msg: unknown) => void,
): Promise<void> {
  // Ensure SW registration has completed (race on first load)
  await swReady;
  if (!swRegistration || !vapidPublicKey) return;
  if (!("PushManager" in window)) {
    console.log("[notifications] Push API not available");
    return;
  }
  try {
    // Check for existing subscription first
    let sub = await swRegistration.pushManager.getSubscription();
    if (!sub) {
      const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);
      sub = await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }
    // Send subscription to bridge
    sendToBridge({ type: "pushSubscribe", subscription: sub.toJSON() });
    console.log("[notifications] Push subscription sent to bridge");
  } catch (e) {
    console.warn("[notifications] Push subscription failed:", e);
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/** Show a notification that Claude finished a turn. */
export function notifyTurnComplete(folder: string, folderPath?: string): void {
  showNotification(`Claude finished in ${folder}`, {
    tag: `gueridon-done-${folder}`,
    vibrate: [200],
    folder: folderPath ?? folder,
  });
}

/** Show a notification that Claude needs user input. */
export function notifyAskUser(folder: string, folderPath?: string): void {
  showNotification(`Claude needs your input in ${folder}`, {
    tag: `gueridon-ask-${folder}`,
    vibrate: [200, 100, 200],
    folder: folderPath ?? folder,
  });
}

function showNotification(
  body: string,
  opts: { tag: string; vibrate: number[]; folder: string },
): void {
  // Don't notify if page is focused — user is already looking
  if (document.hasFocus()) return;
  if (!permissionGranted && Notification.permission !== "granted") return;

  if (swRegistration) {
    swRegistration.showNotification("Guéridon", {
      body,
      icon: "/icon-192.svg",
      badge: "/icon-192.svg",
      tag: opts.tag,
      renotify: true,
      vibrate: opts.vibrate,
      data: { folder: opts.folder },
    });
  } else {
    // Fallback: direct Notification API (no SW)
    new Notification("Guéridon", { body, icon: "/icon-192.svg", tag: opts.tag });
  }
}
