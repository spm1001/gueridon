/**
 * Notification system for Guéridon.
 *
 * Handles service worker registration, permission requests, and
 * showing notifications when Claude finishes or needs input.
 *
 * Notifications only fire when the page is NOT focused — no point
 * notifying someone who's already looking at the screen.
 */

let swRegistration: ServiceWorkerRegistration | null = null;
let permissionGranted = false;

/** Register the service worker. Call once at startup. */
export async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js");
  } catch (e) {
    console.warn("[notifications] SW registration failed:", e);
  }
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
