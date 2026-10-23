/**
 * One favicon fetch for a publisher domain, through a favicon service rather
 * than the publisher's site: the catalog never reads publisher web pages (no
 * HTML, no `<link rel=icon>`, no `og:image`), and a service answers for the
 * ~2,000 domain namespaces without one of us crawling them. Google's s2
 * service is asked first (sz=128; 404 for an unknown domain), DuckDuckGo on a
 * 404 (its 404 carries a placeholder PNG body, so the STATUS decides).
 *
 * A 404 from both, a body under 1 KiB (the services' generic globe defaults)
 * or over the cap, and a non-image content type are a `miss`, cached by the
 * sync for 30 days. A network error, timeout, non-404 error status or a
 * redirect off the service's own hosts is thrown: the sync records an
 * `error` outcome and tries again after a day.
 *
 * Redirects are followed by hand: Google's s2 endpoint answers with a 301 to
 * `*.gstatic.com`, and only that family (and DuckDuckGo's own hosts for the
 * other service) is followed, over https, for at most three hops, so a
 * redirect can never send the fetch to an arbitrary address.
 */

export type FaviconService = "google" | "duckduckgo";

export type FaviconHit = {
  status: "hit";
  service: FaviconService;
  bytes: Buffer;
  contentType: string;
};
export type FaviconMiss = {
  status: "miss";
  reason: "not-found" | "too-small" | "too-large" | "not-an-image";
};
export type FaviconFetch = FaviconHit | FaviconMiss;

export const FAVICON_MIN_BYTES = 1024;
export const FAVICON_MAX_BYTES = 512 * 1024;
const FAVICON_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

/** The hosts each service may redirect to, besides its own. */
const REDIRECT_HOSTS: Record<FaviconService, RegExp> = {
  google:
    /^(?:www\.google\.com|[a-z0-9-]+\.gstatic\.com|[a-z0-9-]+\.googleusercontent\.com)$/i,
  duckduckgo: /^(?:[a-z0-9-]+\.)?duckduckgo\.com$/i,
};

/** Raster image types a favicon service serves; SVG is deliberately not one. */
const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/ico": "ico",
};

/** The media type of a `content-type` header, lowercased, parameters dropped. */
export function imageMediaType(contentType: string | null) {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return type in IMAGE_TYPES ? type : undefined;
}

/** The file extension stored icons of `mediaType` get. */
export function imageExtension(mediaType: string) {
  return IMAGE_TYPES[mediaType] ?? "img";
}

export function faviconServiceUrl(service: FaviconService, domain: string) {
  return service === "google"
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`
    : `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}

/** The body, or undefined once it passes `FAVICON_MAX_BYTES`. */
async function readCappedBody(response: Response): Promise<Buffer | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > FAVICON_MAX_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function fetchFromService(
  service: FaviconService,
  domain: string,
  fetchImpl: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<FaviconFetch | "not-found"> {
  let url = faviconServiceUrl(service, domain);
  let response: Response;
  for (let hop = 0; ; hop += 1) {
    response = await fetchImpl(url, {
      headers: { accept: "image/*" },
      redirect: "manual",
      signal,
    });
    if (response.status < 300 || response.status >= 400) break;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location || hop >= MAX_REDIRECTS) {
      throw new Error(`Favicon service ${service} redirected too many times`);
    }
    const next = new URL(location, url);
    if (
      next.protocol !== "https:" ||
      !REDIRECT_HOSTS[service].test(next.hostname)
    ) {
      throw new Error(
        `Favicon service ${service} redirected off its hosts (${next.hostname})`,
      );
    }
    url = next.toString();
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return "not-found";
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Favicon service ${service} responded ${response.status}`);
  }
  const contentType = imageMediaType(response.headers.get("content-type"));
  if (!contentType) {
    await response.body?.cancel();
    return { status: "miss", reason: "not-an-image" };
  }
  const bytes = await readCappedBody(response);
  if (!bytes) return { status: "miss", reason: "too-large" };
  if (bytes.byteLength < FAVICON_MIN_BYTES) {
    return { status: "miss", reason: "too-small" };
  }
  return { status: "hit", service, bytes, contentType };
}

/**
 * Fetch `domain`'s favicon: Google first, DuckDuckGo when Google has none.
 * One time budget covers both. Throws on network failures and error statuses
 * other than 404.
 */
export async function fetchFavicon(
  domain: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<FaviconFetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FAVICON_TIMEOUT_MS);
  try {
    const google = await fetchFromService(
      "google",
      domain,
      fetchImpl,
      controller.signal,
    );
    if (google !== "not-found") return google;
    const duckduckgo = await fetchFromService(
      "duckduckgo",
      domain,
      fetchImpl,
      controller.signal,
    );
    return duckduckgo === "not-found"
      ? { status: "miss", reason: "not-found" }
      : duckduckgo;
  } finally {
    clearTimeout(timer);
  }
}
