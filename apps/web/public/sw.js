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
 *   a file the server no longer has shows that the page on screen is from
 *   before a deploy, so the cached pages are dropped and the page reloads;
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
// Must match SHELL_STALE_MESSAGE in lib/mobile-app-shell.ts.
const SHELL_STALE_MESSAGE = "sourceweft-shell-stale";
// Must match SHELL_ADDRESS_MESSAGE in lib/mobile-app-shell.ts.
const SHELL_ADDRESS_MESSAGE = "sourceweft-shell-address";
// How long a page gets to say which address it is on before it is reloaded anyway.
const ADDRESS_WAIT_MS = 1000;
// Where the time of the last such reload is kept, so it survives the worker stopping.
const STALE_RELOAD_MARK = "/__shell-stale-reload";
const STALE_RELOAD_GAP_MS = 60_000;

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
    event.respondWith(staticFile(event));
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

async function staticFile(event) {
  const request = event.request;
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (cacheable(response)) {
    await cache.put(request, response.clone());
    void trim(cache);
  } else if (response.status === 404) {
    event.waitUntil(dropStaleShell(event.clientId).catch(() => undefined));
  }
  return response;
}

// A deploy removes the previous build's files from the server. A cached page
// names only the files it loads at once, so those are on the device, but the
// ones it loads later (the chat itself) are not. When the server answers 404
// for one of them, the page that asked is from before the deploy and cannot
// work: drop the cached pages and load the page again, now from the network.
// At most once a minute, in case the new page's files are missing as well.
async function dropStaleShell(clientId) {
  const cache = await caches.open(SHELL_CACHE);
  let dropped = false;
  for (const path of SHELL_PATHS) {
    if (await cache.delete(path)) dropped = true;
  }
  if (!dropped) return;

  const last = Number(await (await cache.match(STALE_RELOAD_MARK))?.text());
  if (Date.now() - last < STALE_RELOAD_GAP_MS) return;
  await cache.put(STALE_RELOAD_MARK, new Response(String(Date.now())));

  const asking = clientId ? await self.clients.get(clientId) : undefined;
  const pages = asking
    ? [asking]
    : await self.clients.matchAll({ type: "window" });
  await Promise.all(pages.map(reloadPage));
}

// Navigating from here also reloads a page whose own scripts are too old to
// know the message; the message is for a page this worker may not navigate.
async function reloadPage(client) {
  try {
    if (typeof client.navigate === "function") {
      await client.navigate(await currentAddress(client));
      return;
    }
  } catch {
    // Not a page this worker may navigate: ask the page instead.
  }
  client.postMessage({ type: SHELL_STALE_MESSAGE });
}

// The address the worker knows is the one the page was opened with; moving
// around inside the app (opening a conversation) does not change it. So the
// page is asked where it is now, and reloads there. A page that does not
// answer in time, or answers with anything but an address on this site, is
// reloaded at the address it was opened with.
function currentAddress(client) {
  return new Promise((resolve) => {
    const opened = client.url;
    const timer = setTimeout(() => resolve(opened), ADDRESS_WAIT_MS);
    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        resolve(sameSiteAddress(event.data) ?? opened);
      };
      client.postMessage({ type: SHELL_ADDRESS_MESSAGE }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(opened);
    }
  });
}

function sameSiteAddress(value) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.origin === self.location.origin ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Drops the oldest static files once the cache holds more than STATIC_LIMIT. */
async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - STATIC_LIMIT))) {
    await cache.delete(key);
  }
}
