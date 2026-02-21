// Guéridon service worker — push notification handlers.
// Deep-link via hash fragments (/#folder-name).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  // Wipe all old caches (Vite PWA precache from Guéridon v1)
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.map((name) => caches.delete(name)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "Guéridon";
  const options = {
    body: data.body || "Claude finished",
    icon: "/icon-192.svg",
    badge: "/icon-192.svg",
    tag: data.tag || "gueridon-default",
    renotify: true,
    data: { folder: data.folder || "" },
    vibrate: data.vibrate || [200],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const folder = event.notification.data?.folder || "";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.postMessage({ type: "notificationClick", folder });
          return;
        }
      }
      // No existing tab — open with hash fragment for deep linking
      const url = folder ? `/#${encodeURIComponent(folder)}` : "/";
      return self.clients.openWindow(url);
    })
  );
});
