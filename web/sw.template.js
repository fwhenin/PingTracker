// PingTracker service worker: makes the web app load offline and installable.
// Only same-origin requests (the app itself) are handled; latency test
// requests to other sites go straight to the network untouched.
const CACHE = "pingtracker-__BUILD_ID__";
const PRECACHE = __PRECACHE__;

self.addEventListener("install", (event) => {
  // Where supported, keep cross-origin requests from even waking this worker,
  // so it adds no delay to latency measurements.
  try {
    event.addRoutes?.({
      condition: { not: { urlPattern: new URLPattern({ origin: self.location.origin }) } },
      source: "network",
    })?.catch?.(() => {});
  } catch {}
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("pingtracker-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    // Network first so new versions show up right away; cached copy offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./", copy));
          return res;
        })
        .catch(() => caches.match("./", { ignoreSearch: true })),
    );
    return;
  }
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
