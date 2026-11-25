// Pit Log service worker.
// Versioned files (?v=N) never change once published, so they come straight from the cache.
// The page itself is network-first (so updates show up right away), falling back to the cache when the
// network is slow or offline. Everything else same-site: network first, cache as backup.
const V = "79";
const CACHE = "pitlog-v79";
const SHELL = ["./", "./index.html", `./app.min.js?v=${V}`, `./styles.css?v=${V}`, `./venues.js?v=${V}`, "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./brand/emblem-128.webp", "./brand/wordmark-180.webp"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("pitlog-v") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
const put = (req, r) => { if (r && r.ok && r.type === "basic") { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; };
self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== location.origin) return;
  if (u.searchParams.has("v") || /\/(brand|icons|tour)\//.test(u.pathname)) {
    e.respondWith(caches.match(req).then(m => m || fetch(req).then(r => put(req, r))));
    return;
  }
  if (req.mode === "navigate") {
    e.respondWith(new Promise(resolve => {
      let done = false; const fallback = () => caches.match(req).then(m => m || caches.match("./index.html")).then(m => { if (m && !done) { done = true; resolve(m); } });
      const t = setTimeout(fallback, 3500);
      fetch(req).then(r => { put(req, r); clearTimeout(t); if (!done) { done = true; resolve(r); } })
        .catch(() => { clearTimeout(t); caches.match(req).then(m => m || caches.match("./index.html")).then(m => { if (!done) { done = true; resolve(m || Response.error()); } }); });
    }));
    return;
  }
  e.respondWith(fetch(req).then(r => put(req, r)).catch(() => caches.match(req)));
});

// Phone notifications (sent through Firebase Cloud Messaging as data messages, drawn here).
self.addEventListener("push", e => {
  let j = {}; try { j = e.data ? e.data.json() : {}; } catch (_) { j = { data: { title: "Pit Log", body: e.data ? e.data.text() : "" } }; }
  const d = j.data || j.notification || j || {};
  const title = d.title || "Pit Log";
  e.waitUntil(self.registration.showNotification(title, { body: d.body || "", tag: d.tag || undefined, renotify: !!d.tag, icon: "icons/icon-192.png", badge: "icons/favicon-64.png", data: { url: d.url || "./" } }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope)) { c.postMessage({ go: url }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
