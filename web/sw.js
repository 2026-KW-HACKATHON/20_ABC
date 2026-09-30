// 월계온 서비스워커: 앱 화면은 오프라인에서도 열리고, 지도 데이터는 캐시 후 갱신
const VERSION = "wolgyeon-v8";  // 앱 파일을 바꾸면 숫자를 올려주세요
const SHELL = [
  "/", "/index.html", "/css/app.css", "/manifest.webmanifest",
  "/vendor/leaflet/leaflet.js", "/vendor/leaflet/leaflet.css",
  "/js/app.js", "/js/api.js", "/js/ui.js", "/js/basemap.js", "/js/graph.js", "/js/live.js", "/js/icons.js",
  "/js/views/news.js", "/js/views/event.js", "/js/views/route.js", "/js/views/plan.js",
  "/js/views/tip.js", "/js/views/me.js", "/js/views/pathedit.js",
  "/icons/icon-192.png",
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/map/basemap") || url.pathname.startsWith("/api/map/pois")) {
    // 지도: 캐시 먼저 보여주고 뒤에서 갱신
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); c.put(e.request, copy); } return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin")) return; // API는 항상 네트워크
  // 앱 파일: 네트워크 우선, 실패하면 캐시
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then(h => h || caches.match("/index.html"))));
});
