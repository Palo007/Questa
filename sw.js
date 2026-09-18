/* Questa service worker - network-first for the app shell so updates appear
   on the next launch; cache fallback keeps it working fully offline. */
const CACHE = "questa-v214";
const ASSETS = ["./", "./index.html", "./app.js", "./sync.js", "./manifest.json", "./icon.svg",
                "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  /* 2026-09-18: fill the versioned cache FROM THE NETWORK. Cache.addAll fetches
     with the default RequestCache, so each asset could come from the browser's
     HTTP cache instead. GitHub Pages serves max-age=600 and app.js / sync.js
     enter that window at different moments, so one bumped CACHE could end up
     holding build N's app.js beside build N+1's sync.js -- and the pair then
     merges and uploads with no version handshake between them. register()'s
     updateViaCache:'none' (app.js) covers sw.js only, not these fetches. */
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  const isShell = e.request.mode === "navigate"
    || url.pathname.endsWith("/")
    || url.pathname.endsWith("index.html")
    || url.pathname.endsWith("app.js")
    || url.pathname.endsWith("sync.js")
    || url.pathname.endsWith("manifest.json");
  if (isShell) {
    /* network-first: always try GitHub, fall back to cache when offline */
    e.respondWith(
      /* 2026-09-18: fetch only REJECTS on a network failure, so a 404 (Pages
         mid-rebuild) or a captive-portal 200 used to bypass the .catch, get
         served to the page, AND get written into CACHE -- poisoning the offline
         copy until the next CACHE bump. Treat a bad status like being offline,
         and only cache a response we would be willing to serve. */
      fetch(e.request).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
          return res;
        }
        return caches.match(e.request)
          .then(hit => hit || caches.match("./index.html"))
          .then(hit => hit || res);   // nothing cached -> the real response still beats nothing
      }).catch(() => caches.match(e.request).then(hit => hit || caches.match("./index.html")))
    );
  } else {
    /* cache-first for static assets (icons) */
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => {}))
    );
  }
});
self.addEventListener("message", e => {
  if (e.data && e.data.type === "SHOW_NOTIFICATION") {
    const { title, body, tag, data } = e.data;
    e.waitUntil(
      self.registration.showNotification(title, {
        body: body,
        icon: "./icon-192.png",
        badge: "./icon-192.png",
        tag: tag || "questa-reminder",
        data: data || {},
        vibrate: [100, 50, 100],
        renotify: true
      })
    );
  }
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (client.url && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow("./");
      }
    })
  );
});
