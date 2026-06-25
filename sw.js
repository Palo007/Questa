/* Questa service worker - network-first for the app shell so updates appear
   on the next launch; cache fallback keeps it working fully offline. */
const CACHE = "questa-v37";
const ASSETS = ["./", "./index.html", "./app.js", "./manifest.json", "./icon.svg",
                "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
    || url.pathname.endsWith("manifest.json");
  if (isShell) {
    /* network-first: always try GitHub, fall back to cache when offline */
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request).then(hit => hit || caches.match("./index.html")))
    );
  } else {
    /* cache-first for static assets (icons) */
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match("./index.html")))
    );
  }
});
