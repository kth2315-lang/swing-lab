// 오프라인 준비: 온라인이면 항상 최신 파일을 받고, 인터넷이 안 되면 저장해 둔 파일로 열어요.
// 이 주소의 파일만 다루고, 바깥 주소 요청에는 손대지 않아요.
// 새로 올린 파일이 바로 보이게, 매번 서버에 '바뀌었나요?'만 물어봐요 (안 바뀌었으면 다시 받지 않아요).
const CACHE = 'swinglab-v4';
const CORE = [
  './', './index.html', './style.css', './app.js', './core.js', './capture.js', './screens.js', './fieldui.js',
  './util.js', './refs.js', './store.js', './camera.js', './sound.js', './pose.js', './swing.js', './draw.js',
  './field.js', './reel.js', './maptiles.js', './osm.js', './holemap.js', './tracker.js', './manifest.webmanifest', './icon-180.png',
  './vision_bundle_esm.js', './vision_wasm_internal.js', './vision_wasm_internal.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: 'no-cache' }))))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const fresh =
    req.mode === 'navigate'
      ? fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then((r) => (r.redirected ? Response.redirect(r.url, 302) : r))
      : fetch(req, { cache: 'no-cache' });
  e.respondWith(
    fresh
      .then((res) => {
        if (res.ok && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
  );
});
