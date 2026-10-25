/* 英语单词听写 · Service Worker（2026-10-23 加，给 PWA 用）
 *
 * 目的：手机上"添加到主屏幕"后能全屏打开，断网也能练（词表和词典已经缓存）。
 *
 * 策略：
 *   页面/JSON —— 先网络再缓存（保证能拿到新版），离线时回缓存
 *   图标/词表 txt —— 缓存优先（这些不常变）
 *   /api/* —— 直接放行，不缓存（电脑端 server 才有，手机上没有）
 *   跨域（如有道音频）—— 不介入
 *
 * 改版本号会让旧缓存整体作废，重新预缓存。
 */
const VERSION = "dictation-v2-2026-10-25";
const CORE = [
  "./word-dictation.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./exam-examples.json",
  "./example-dict.json",
  "./quiz-pool.json",
  "./dates.json",
    "./wallpaper.jpg",
    "./wallpaper-blur.jpg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      // 个别文件拉不到不该让整次安装失败（addAll 是原子的）
      .then((c) => Promise.all(CORE.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // 有道音频等外部资源不碰
  if (/\/api\//.test(url.pathname)) return;             // 电脑端接口，手机上本来就没有

  const isPage = /\.html?$/i.test(url.pathname) || url.pathname.endsWith("/");
  const isData = /\.(json|txt)$/i.test(url.pathname);

  if (isPage || isData) {
    // 先网络，失败回缓存
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const cp = res.clone();
            caches.open(VERSION).then((c) => c.put(req, cp));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match("./word-dictation.html"))
        )
    );
    return;
  }

  // 图标等：缓存优先
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const cp = res.clone();
              caches.open(VERSION).then((c) => c.put(req, cp));
            }
            return res;
          })
          .catch(() => hit)
    )
  );
});
