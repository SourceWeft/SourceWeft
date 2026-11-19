/*
 * The SourceWeft iOS app's service worker. Only the iOS app registers it
 * (lib/mobile-app-shell.ts); the website never does.
 *
 * It keeps two things on the device so a launch does not wait for the network:
 * - the app shell pages (sign-in and the chat dashboard), served from the cache
 *   at once and refreshed in the background (stale-while-revalidate). These
 *   pages carry no account data: the signed-in state and all content load
 *   through the API afterwards, which this worker never touches;
 * - the build's static files under /_next/static, which never change at a URL
 *   (cache first), so a cached page still finds its scripts after a deploy;
 * - the few brand images those pages show from /public, kept like the pages
 *   (served from the cache, refreshed in the background).
 *
 * Everything else goes to the network untouched.
 */
const VERSION = "v1";
const SHELL_CACHE = `sourceweft-shell-${VERSION}`;
const STATIC_CACHE = `sourceweft-static-${VERSION}`;
const SHELL_PATHS = new Set(["/dashboard/chat", "/auth/sign-in"]);
const SHELL_IMAGES = new Set([
  "/logo.svg",
  "/logo-white-bg.svg",
  "/icon.svg",
  "/icon-192.png",
]);
const STATIC_LIMIT = 600;
// Must match SHELL_CACHE_TIMING in lib/mobile-app-shell.ts.
const SHELL_CACHE_TIMING = "sw-shell-cache";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, STATIC_CACHE]);
      for (const name of await caches.keys()) {
        if (name.startsWith("sourceweft-") && !keep.has(name)) {
          await caches.delete(name);
        }
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (
    request.mode === "navigate" &&
    SHELL_PATHS.has(url.pathname) &&
    !url.search
  ) {
    event.respondWith(shellPage(event));
  } else if (SHELL_IMAGES.has(url.pathname) && !url.search) {
    event.respondWith(shellPage(event));
  } else if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(staticFile(request));
  }
});

// Same-origin requests only reach here; `ok` also rules out opaque responses (status 0).
function cacheable(response) {
  return response.ok && !response.redirected;
}

async function shellPage(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(event.request);
  const fresh = fetch(event.request).then(async (response) => {
    if (cacheable(response)) await cache.put(event.request, response.clone());
    return response;
  });

  if (!cached) return fresh;
  event.waitUntil(fresh.catch(() => undefined));
  return markedFromCache(cached);
}

/** Adds a Server-Timing entry the page reads to tell a cached launch from a network one. */
function markedFromCache(response) {
  const headers = new Headers(response.headers);
  headers.append("Server-Timing", SHELL_CACHE_TIMING);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function staticFile(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (cacheable(response)) {
    await cache.put(request, response.clone());
    void trim(cache);
  }
  return response;
}

/** Drops the oldest static files once the cache holds more than STATIC_LIMIT. */
async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - STATIC_LIMIT))) {
    await cache.delete(key);
  }
}
