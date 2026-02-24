// Guéridon service worker — push notification handlers + offline app shell cache.
// Deep-link via hash fragments (/#folder-name).

const CACHE_NAME = "gueridon-shell-v1";
const SHELL_URLS = ["/", "/manifest.json", "/icon-192.svg", "/icon-512.svg"];

self.addEventListener("install", (event) => {
  // Precache the app shell so it loads offline
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Wipe old caches (Vite PWA precache from v1 + stale versions)
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for API, cache-first for shell assets
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // API routes and SSE — always network, never cache
  if (url.pathname.startsWith("/events") ||
      url.pathname.startsWith("/session/") ||
      url.pathname.startsWith("/prompt/") ||
      url.pathname.startsWith("/abort/") ||
      url.pathname.startsWith("/exit/") ||
      url.pathname.startsWith("/push/") ||
      url.pathname === "/folders" ||
      url.pathname === "/status" ||
      url.pathname === "/client-error") {
    return;
  }

  // Shell assets: network-first, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Update cache with fresh version
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Network failed — serve from cache (offline)
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // Fallback: serve index.html for navigation requests
          if (event.request.mode === "navigate") {
            return caches.match("/");
          }
          return new Response("Offline", { status: 503 });
        });
      })
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
