// 家計簿アプリ Service Worker
// v4.1: キャッシュ優先で即起動 + 裏で最新を取得(stale-while-revalidate)。
// v4.0 はネットワーク優先だったため、電波が弱いと fetch がタイムアウトするまで
// 画面が真っ白のまま待たされていた。
const CACHE = "kakeibo-v4.2";
const FONT_CACHE = "kakeibo-fonts";   // フォントは版をまたいで使い回す
const ASSETS = ["./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", e => {
  // cache: "reload" = ブラウザの HTTP キャッシュに残った古いファイルを拾わない
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== FONT_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (FONT_HOSTS.includes(url.hostname)) { e.respondWith(fontFirst(req)); return; }
  if (url.origin !== self.location.origin) return;   // api.anthropic.com などは素通し

  // ページ本体は "./" と "./index.html" のどちらで開かれても同じキャッシュを使う
  const isPage = req.mode === "navigate" || url.pathname === new URL("./", self.registration.scope).pathname;
  const key = isPage ? new URL("./index.html", self.registration.scope).href : req;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key, { ignoreSearch: true });
    // 比較用のコピーは今のうちに取る。cached はこの後ページに返して読まれるので、
    // fetch 完了後に clone しようとすると例外になり、更新が保存されない
    const oldCopy = isPage && cached ? cached.clone() : null;
    // GitHub Pages の HTTP キャッシュ(10分)を挟むと更新が遅れるので no-cache で取りに行く
    const net = fetch(req.url, { cache: "no-cache" }).then(async res => {
      if (!res.ok) return res;
      let changed = false;
      if (oldCopy) {
        const [oldText, newText] = await Promise.all([oldCopy.text(), res.clone().text()]);
        changed = oldText !== newText;
      }
      // 保存してから知らせる(先に知らせると、すぐ再読み込みされたとき古い版が出る)
      await cache.put(key, res.clone());
      if (changed) notifyUpdate(e.resultingClientId || e.clientId);
      return res;
    });
    if (cached) {
      e.waitUntil(net.catch(err => console.warn("最新版の取得に失敗(オフライン?):", err)));
      return cached;
    }
    return net.catch(async () => (await cache.match(new URL("./index.html", self.registration.scope).href)) || Response.error());
  })());
});

async function fontFirst(req) {
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // <link rel=stylesheet> の CSS は no-cors なので opaque(status 0)で返ってくる
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}

// 新しい index.html を取得したらページに知らせる(ページ側で「更新」トーストを出す)
async function notifyUpdate(clientId) {
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const targets = clientId ? list.filter(c => c.id === clientId) : [];
  (targets.length ? targets : list).forEach(c => c.postMessage({ type: "app-updated" }));
}
