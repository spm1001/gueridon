// Guéridon service worker — notification handlers.
// Offline caching (gdn-gabeda) will be added here later.

// Activate immediately on install — don't wait for all tabs to close.
// Safe because we have no fetch handler yet (no cache to invalidate).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "Guéridon";
  const options = {
    body: data.body || "Claude finished",
    icon: "/icon-192.svg",
    badge: "/icon-192.svg",
    tag: data.tag || "gueridon-default",
    data: { folder: data.folder || "/" },
    vibrate: data.vibrate || [200],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const folder = event.notification.data?.folder || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus an existing Guéridon tab if one exists
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          // Tell the client which folder triggered the notification
          client.postMessage({ type: "notificationClick", folder });
          return;
        }
      }
      // No existing tab — open a new one
      return self.clients.openWindow("/");
    })
  );
});
