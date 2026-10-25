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
const VERSION = "dictation-v4-2026-10-25";
/* 2026-10-25：三个大数据文件（example-dict 835KB / exam-examples 347KB / quiz-pool 300KB）
   不再预缓存 —— 页面会带日期版本号请求它们，由运行时缓存接管，避免 install 时重复下 1.5MB。 */
const CORE = [
  "./word-dictation.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
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

  // 带版本参数的数据文件（页面用 example-dict.json?d=20261025 这种）：
  // URL 本身即版本号，可以安全地「缓存优先」。否则每次都走 network-first，
  // 国内拉 GitHub Pages 要 5-15 秒（2026-10-25 首屏变慢的根因）。
  if (isData && /[?&](d|v)=\d+/.test(url.search)) {
    e.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const cp = res.clone();
              caches.open(VERSION).then((c) => c.put(req, cp));
            }
            return res;
          })
          .catch(() => caches.match(req));
      })
    );
    return;
  }

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
