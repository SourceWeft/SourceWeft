import type { Hono } from "hono";
import { contentArtifactsService } from "../../modules/artifacts";
import { sharingService } from "../../modules/sharing";
import { config } from "../../shared/config";
import { ApiError, ApiResponse } from "../response/api-response";
import { requireRouteParam } from "./content/helpers";

/**
 * Content-Security-Policy for served artifact bytes.
 *
 * `sandbox allow-scripts` is the load-bearing directive: it forces the document
 * into an opaque origin, so even served from the app's own host the artifact's
 * JavaScript cannot read the app's cookies or storage, and two artifacts cannot
 * read each other. `default-src 'none'` plus the self-contained allowances then
 * block phoning home — the same "no external hosts" posture Claude uses. This
 * is what makes it safe to serve arbitrary AI-generated markup on the main
 * domain (best for SEO) without a separate origin.
 */
const SANDBOX_CSP = [
  "sandbox allow-scripts allow-forms allow-popups allow-modals",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  // Only our own share page may frame these bytes. The share page lives on the
  // WEB origin, which is cross-origin to this API — so `X-Frame-Options:
  // SAMEORIGIN` (API-origin only) wrongly blocked our own `<iframe>`. Express
  // the real allow-list with `frame-ancestors` (self = direct visits, plus the
  // web origin) and drop the legacy header.
  `frame-ancestors 'self' ${config.auth.webBaseUrl}`,
].join("; ");

/**
 * Best-effort view-count throttle. The count increment on `/raw` is
 * unauthenticated and outside better-auth's rate limiter, so a scripted loop
 * could otherwise inflate the number and drive one DB write per request. We
 * de-duplicate on (token, client-ip) within a window: a repeat fetch from the
 * same client neither re-counts nor writes. It is per-process (multi-instance
 * deployments count at most once per instance per window) — acceptable for a
 * vanity metric. The map is bounded to cap memory under a flood.
 */
const VIEW_DEDUP_WINDOW_MS = 30 * 60 * 1000;
const VIEW_DEDUP_MAX_ENTRIES = 50_000;
const recentViews = new Map<string, number>();

function shouldCountView(token: string, clientIp: string, now: number) {
  const key = `${token}:${clientIp}`;
  const last = recentViews.get(key);
  if (last !== undefined && now - last < VIEW_DEDUP_WINDOW_MS) {
    return false;
  }

  // Bounded eviction: drop the oldest-inserted entries when over the cap so a
  // flood of distinct (token, ip) pairs can't grow the map without limit.
  if (recentViews.size >= VIEW_DEDUP_MAX_ENTRIES) {
    const overflow = recentViews.size - VIEW_DEDUP_MAX_ENTRIES + 1;
    let removed = 0;
    for (const staleKey of recentViews.keys()) {
      recentViews.delete(staleKey);
      if (++removed >= overflow) break;
    }
  }

  recentViews.set(key, now);
  return true;
}

/**
 * Best-effort client IP for the throttle key. Deliberately NOT the left-most
 * X-Forwarded-For token: that is fully client-controlled, so keying on it lets
 * an attacker rotate a fake IP per request and defeat the throttle. Prefer
 * headers our own edge sets and a client cannot forge — Cloudflare's
 * `cf-connecting-ip`, then `x-real-ip`, then the RIGHT-most XFF hop (the one our
 * closest trusted proxy appended; an external caller can only prepend on the
 * left). Falls back to a single bucket, which just makes the throttle stricter.
 */
function clientIpOf(headers: {
  cfConnectingIp: string | undefined;
  xRealIp: string | undefined;
  xForwardedFor: string | undefined;
}) {
  const cf = headers.cfConnectingIp?.trim();
  if (cf) return cf;

  const realIp = headers.xRealIp?.trim();
  if (realIp) return realIp;

  if (headers.xForwardedFor) {
    const hops = headers.xForwardedFor
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    const rightMost = hops[hops.length - 1];
    if (rightMost) return rightMost;
  }

  return "unknown";
}

// Revocable, token-gated bytes: a short max-age caps how long a shared/CDN cache
// keeps serving a link after it is revoked, while still allowing brief caching.
const SHARE_BYTES_CACHE_CONTROL = "public, max-age=60, must-revalidate";

/**
 * Public, unauthenticated share endpoints. Registered OUTSIDE the workspace
 * mount and with no session middleware: the live share token is the entire
 * access grant. These handlers never read cookies, so a request carrying an app
 * session gains nothing here.
 */
export function registerPublicShareRoutes(app: Hono) {
  app.get("/v1/public/shares/:token", async (c) => {
    const artifact = await sharingService.resolvePublicArtifact(
      requireRouteParam(c, "token"),
    );
    if (!artifact) {
      throw new ApiError(404, "SHARE_NOT_FOUND", "This share is not available");
    }

    if (artifact.noindex) {
      c.header("X-Robots-Tag", "noindex");
    }
    return ApiResponse.success(c, { artifact });
  });

  app.get("/v1/public/shares/:token/raw", async (c) => {
    const token = requireRouteParam(c, "token");
    const countView = shouldCountView(
      token,
      clientIpOf({
        cfConnectingIp: c.req.header("cf-connecting-ip"),
        xRealIp: c.req.header("x-real-ip"),
        xForwardedFor: c.req.header("x-forwarded-for"),
      }),
      Date.now(),
    );
    const resolved = await sharingService.resolvePublicArtifactBytes(token, {
      countView,
    });
    if (!resolved) {
      throw new ApiError(404, "SHARE_NOT_FOUND", "This share is not available");
    }

    const file = await contentArtifactsService.getSharedArtifactFile(
      resolved.artifact,
    );

    c.header("Content-Type", file.contentType);
    c.header("Content-Security-Policy", SANDBOX_CSP);
    c.header("X-Content-Type-Options", "nosniff");
    // Framing is controlled by the CSP `frame-ancestors` above (our web origin
    // only). No `X-Frame-Options`: SAMEORIGIN would block our own cross-origin
    // share page, and XFO can't express a specific external origin.
    // The token lives in the URL path; never leak it in a Referer to anything
    // the served (untrusted) markup might reach.
    c.header("Referrer-Policy", "no-referrer");
    if (resolved.share.noindex) {
      c.header("X-Robots-Tag", "noindex");
    }
    c.header("Cache-Control", SHARE_BYTES_CACHE_CONTROL);
    return c.body(file.body);
  });

  app.get("/v1/public/shares/:token/preview", async (c) => {
    const resolved = await sharingService.resolvePublicArtifactBytes(
      requireRouteParam(c, "token"),
    );
    if (!resolved) {
      throw new ApiError(404, "SHARE_NOT_FOUND", "This share is not available");
    }

    const preview = await contentArtifactsService.getSharedArtifactPreview(
      resolved.artifact,
    );
    if (!preview) {
      throw new ApiError(404, "PREVIEW_NOT_FOUND", "No preview image");
    }

    c.header("Content-Type", preview.contentType);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", SHARE_BYTES_CACHE_CONTROL);
    return c.body(preview.body);
  });
}
