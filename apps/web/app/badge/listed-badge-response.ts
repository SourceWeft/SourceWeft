import {
  LISTED_BADGE_ETAG,
  renderListedBadgeSvg,
} from "../../lib/catalog-badge";

// Longer than any identifier or slug the market issues: not worth a lookup.
const MAX_KEY_LENGTH = 256;

// GitHub's image proxy (camo) passes these through to every README, and keeps
// a picture for a year when told nothing. An hour in browsers and camo, a day
// at the edge — a withdrawn entry turns into a 404 within a day — and a week
// of the last good copy if the origin fails.
const BADGE_HEADERS = {
  "cache-control":
    "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400, stale-if-error=604800",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "content-type": "image/svg+xml; charset=utf-8",
  etag: LISTED_BADGE_ETAG,
  "x-content-type-options": "nosniff",
  // The entry's page is the one to index.
  "x-robots-tag": "noindex",
};

/**
 * The entry's key from the path: what precedes `.svg`, its segments decoded and
 * rejoined, so an MCP identifier may be written `a%2Fb.svg` or `a/b.svg`. Null
 * for anything else.
 */
export function badgeKeyFromPath(segments: readonly string[]): string | null {
  let path: string;
  try {
    path = segments.map((segment) => decodeURIComponent(segment)).join("/");
  } catch {
    return null;
  }
  if (!path.endsWith(".svg")) return null;
  const key = path.slice(0, -".svg".length);
  return key && key.length <= MAX_KEY_LENGTH ? key : null;
}

export function badgeNotFound() {
  return new Response("Not found\n", {
    status: 404,
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    },
  });
}

function matchesBadgeEtag(header: string | null) {
  if (!header) return false;
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === "*" || tag === LISTED_BADGE_ETAG);
}

/**
 * The badge, for an entry the caller has just found listed with the same
 * cached read as its detail page. The caller answers `badgeNotFound()` when
 * the market says "not found" and rethrows anything else, so an outage is a
 * 5xx and never a badge. The lookup runs before the ETag check too, so a
 * withdrawn entry stops answering 304.
 */
export function listedBadge(request: Request) {
  if (matchesBadgeEtag(request.headers.get("if-none-match"))) {
    return new Response(null, { status: 304, headers: BADGE_HEADERS });
  }
  return new Response(renderListedBadgeSvg(), { headers: BADGE_HEADERS });
}
