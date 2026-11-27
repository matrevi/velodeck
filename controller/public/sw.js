const CACHE_NAME = "velodeck-controller-v1";
const APP_SHELL_URLS = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];
const NETWORK_TIMEOUT_MS = 3000;

function isBypassPath(pathname) {
  return (
    pathname === "/ws" ||
    pathname.startsWith("/ws/") ||
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/health" ||
    pathname.startsWith("/health/")
  );
}

function fetchWithTimeout(request, timeoutMs) {
  if (typeof AbortController === "undefined") {
    return fetch(request);
  }
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { signal: controller.signal }).finally(() => {
    clearTimeout(timerId);
  });
}

function cacheResponse(event, cacheKey, response) {
  const copy = response.clone();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.put(cacheKey, copy))
      .catch(() => undefined),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_URLS))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Never intercept non-GET requests
  if (request.method !== "GET") {
    return;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Only handle same-origin http(s) requests
  if (
    url.origin !== self.location.origin ||
    (url.protocol !== "http:" && url.protocol !== "https:")
  ) {
    return;
  }

  // Never intercept or cache WebSocket upgrade, API, or health endpoints
  if (isBypassPath(url.pathname)) {
    return;
  }

  // Never cache any request carrying query parameters (could contain tokens/secrets)
  const hasQueryString = Boolean(url.search && url.search.length > 0);
  // Normalize cache key to pathname only (stripping any query string & hash fragment)
  const normalizedCacheKey = url.pathname;

  const isHtmlRequest =
    request.mode === "navigate" ||
    (request.headers.get("accept") || "").includes("text/html");

  // Network-first with 3s timeout for HTML so PWA always picks up latest app shell when online
  // without stalling on captive portals or flaky mobile links
  if (isHtmlRequest) {
    event.respondWith(
      fetchWithTimeout(request, NETWORK_TIMEOUT_MS)
        .then((response) => {
          if (
            !hasQueryString &&
            !isBypassPath(url.pathname) &&
            response &&
            response.ok &&
            response.type === "basic"
          ) {
            cacheResponse(event, normalizedCacheKey, response);
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(normalizedCacheKey);
          if (cached) return cached;
          const indexFallback = await caches.match("/index.html");
          if (indexFallback) return indexFallback;
          return new Response("Offline", { status: 503, statusText: "Offline" });
        }),
    );
    return;
  }

  // Never cache non-HTML requests that have query parameters
  if (hasQueryString) {
    return;
  }

  // Cache-first for content-hashed Vite build assets (/assets/*)
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(normalizedCacheKey).then((cached) => {
        if (cached) {
          return cached;
        }
        return fetch(request)
          .then((response) => {
            if (
              !isBypassPath(url.pathname) &&
              response &&
              response.ok &&
              response.type === "basic"
            ) {
              cacheResponse(event, normalizedCacheKey, response);
            }
            return response;
          })
          .catch(() => new Response("Offline", { status: 503, statusText: "Offline" }));
      }),
    );
    return;
  }

  // Network-first (with 3s timeout) and cache fallback for unhashed static files (manifest/icons)
  event.respondWith(
    fetchWithTimeout(request, NETWORK_TIMEOUT_MS)
      .then((response) => {
        if (
          !isBypassPath(url.pathname) &&
          response &&
          response.ok &&
          response.type === "basic"
        ) {
          cacheResponse(event, normalizedCacheKey, response);
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(normalizedCacheKey);
        if (cached) return cached;
        return new Response("Offline", { status: 503, statusText: "Offline" });
      }),
  );
});
