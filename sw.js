// Offline shell: the page opens even with no network, showing the last feed it decrypted.
const VERSION = "1795082443";
const CACHE = "bot-feed-" + VERSION;
const SHELL = ["./", "index.html", "loader.js", "app.css", "manifest.json",
  "apple-touch-icon.png", "icon-192.png", "icon-512.png", "data.enc.json"];
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
  // Network first (fresh feed), cache fallback (always opens).
  e.respondWith(fetch(e.request, { cache: "no-store" }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
