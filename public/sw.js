const CACHE_NAME = 'work-report-v3';
const STATIC_ASSETS = [
  '/report.html',
  '/manifest.json',
];

// 安裝：快取靜態資源（不自動 skipWaiting，讓新版進入 waiting，由頁面提示使用者後再啟用）
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
});

// 啟動：清理舊快取並接管頁面
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 收到頁面「使用者同意更新」指示後才接管
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 攔截請求：網路優先，失敗時用快取
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // 只處理同源請求；跨來源（地圖圖磚等）交給瀏覽器直接處理，避免干擾
  if (new URL(event.request.url).origin !== self.location.origin) return;
  // API 請求不快取
  if (event.request.url.includes('/api/')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
