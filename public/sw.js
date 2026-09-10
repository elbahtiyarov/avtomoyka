// Service worker для PWA. Кэширует только "оболочку" приложения (HTML/CSS/JS/иконки),
// чтобы её можно было установить на телефон — API-запросы и WebSocket никогда не
// перехватываются и не кэшируются, потому что это живой бизнес-инструмент: данные о
// записях, кассе и клиентах всегда должны браться из сети, а не из старого кэша.

const CACHE_NAME = "avtomoyka-shell-v1";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // API и WebSocket — не перехватываем вообще, данные должны быть только живыми
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) {
    return;
  }
  if (event.request.method !== "GET") {
    return;
  }

  // Оболочка приложения: сеть в приоритете, кэш — только как резерв без связи
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
