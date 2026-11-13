// App-shell cache for offline/flaky-network reloads. Deliberately does NOT
// touch /api/* (TURN credentials must always be fetched fresh) or
// cross-origin CDN requests (left to the browser's own HTTP cache).
// The self-hosted QR reader (/vendor/zxing-wasm, ~1 MB) isn't precached; the fetch
// handler below keeps it once a phone has used the camera transfer.
const CACHE = "beam-shell-v3";
const SHELL = [
  "/",
  "/index.html",
  "/js/config.js",
  "/js/qr-save-pair.js",
  "/js/qr-restore-pair.js",
  "/js/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let CDN requests pass through untouched
  if (url.pathname.startsWith("/api/")) return; // never cache TURN credential responses

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("/index.html")))
  );
});
