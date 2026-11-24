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

// Fills the cache as soon as the worker installs, so the next launch is served
// from the device even if the person has not opened those pages yet. A page or
// file that fails to load is skipped; installing never waits on the network.
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(precache().catch(() => undefined));
});

async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(
    [...SHELL_PATHS, ...SHELL_IMAGES].map(async (path) => {
      try {
        const response = await fetch(path, { credentials: "same-origin" });
        if (!cacheable(response)) return;
        if (SHELL_PATHS.has(path)) await warmStaticFiles(response.clone());
        await cache.put(path, response);
      } catch {
        // Offline or failed: the page is cached the next time it loads.
      }
    }),
  );
}

// A shell page names the build's scripts and styles it needs. Caching them
// along with the page means a cached page also starts without the network,
// including right after a deploy, when the page names new files.
const STATIC_REFERENCE = /\/_next\/static\/[^"'\s)\\]+/g;

async function warmStaticFiles(pageResponse) {
  const html = await pageResponse.text();
  const paths = new Set(html.match(STATIC_REFERENCE) ?? []);
  const cache = await caches.open(STATIC_CACHE);
  await Promise.all(
    [...paths].map(async (path) => {
      try {
        if (await cache.match(path)) return;
        const response = await fetch(path);
        if (cacheable(response)) await cache.put(path, response);
      } catch {
        // Fetched on demand instead.
      }
    }),
  );
  await trim(cache);
}

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
    if (cacheable(response)) {
      if (event.request.mode === "navigate") {
        event.waitUntil(
          warmStaticFiles(response.clone()).catch(() => undefined),
        );
      }
      await cache.put(event.request, response.clone());
    }
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
