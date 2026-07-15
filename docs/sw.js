/* Service Worker: オフラインでも前回のデータで表示できるようにする */
const CACHE = "kouhaitou-v3";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  // data.json は常にネットワークから最新を取得（オフライン時のみキャッシュ）。
  // app.js がキャッシュ回避用のクエリ(?タイムスタンプ)を付けてくるため、
  // キャッシュキーはクエリを除いた1つに正規化する（肥大化防止＆確実なフォールバック）
  if (url.pathname.endsWith("data.json")) {
    const key = url.origin + url.pathname;
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(key, copy));
          }
          return res;
        })
        .catch(() => caches.match(key))
    );
    return;
  }

  // アプリ本体（HTML/JS/CSS等）もネットワーク優先（常に最新版）、オフライン時はキャッシュで表示
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
