// Offline shell: the page opens even with no network, showing the last feed it decrypted.
const VERSION = "1795442994";
const CACHE = "bot-feed-" + VERSION;
const SHELL = ["./", "index.html", "loader.js", "app.css", "manifest.json",
  "apple-touch-icon.png", "icon-192.png", "icon-512.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  const path = url.pathname;
  const isFeed = path.endsWith("/data.enc.json") || path.endsWith("data.enc.json");
  if (isFeed) {
    // Network-first, never serve a stale encrypted feed on a normal load.
    e.respondWith(fetch(e.request, { cache: "no-store" }).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put("data.enc.json", copy));
      }
      return res;
    }).catch(() => caches.match("data.enc.json").then((cached) => cached || caches.match(e.request, { ignoreSearch: true }))));
    return;
  }
  // Network first for the shell, cache fallback (always opens).
  e.respondWith(fetch(e.request, { cache: "no-store" }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
