import {
  artifactExecutionCsp,
  inertArtifactCsp,
} from "@sourceweft/contracts/artifact-execution";
import type { Context, Hono } from "hono";
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
function requestedVersion(c: Context) {
  const values = c.req.queries("artifactVersionId");
  if (!values) return undefined;
  if (
    values.length !== 1 ||
    !values[0]?.trim() ||
    values[0] !== values[0].trim()
  )
    throw ApiError.validation({
      artifactVersionId: ["Expected one non-empty version identifier"],
    });
  return values[0];
}

const SANDBOX_CSP = [
  "sandbox",
  "default-src 'none'",
  "script-src 'none'",
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

  app.get(
    "/v1/public/shares/:token/versions/:versionId/media/:resource",
    async (c) => {
      const token = requireRouteParam(c, "token");
      const resource = requireRouteParam(c, "resource");
      if (resource !== "video" && resource !== "cover") {
        throw new ApiError(
          404,
          "ARTIFACT_VERSION_MEDIA_NOT_FOUND",
          "Artifact version media not found",
        );
      }
      const resolved = await sharingService.resolvePublicArtifactBytes(token, {
        countView:
          resource === "video" &&
          shouldCountView(
            token,
            clientIpOf({
              cfConnectingIp: c.req.header("cf-connecting-ip"),
              xRealIp: c.req.header("x-real-ip"),
              xForwardedFor: c.req.header("x-forwarded-for"),
            }),
            Date.now(),
          ),
      });
      if (!resolved) {
        throw new ApiError(
          404,
          "SHARE_NOT_FOUND",
          "This share is not available",
        );
      }
      const requestedVersionId = requireRouteParam(c, "versionId");
      const media =
        await contentArtifactsService.getSharedArtifactVersionMediaBytes(
          resolved.artifact,
          {
            artifactVersionId: requestedVersionId,
            resource,
            range: c.req.header("range"),
            ifNoneMatch: c.req.header("if-none-match"),
            download: c.req.query("download") === "1",
          },
        );
      if (!media) {
        // Serving is pinned to the artifact's exact current version by design
        // (see `getSharedArtifactVersionMediaBytes`) — a viewer's tab open on
        // an older publish must not silently start showing newer bytes under
        // the same URL. But the public projection bakes a specific versionId
        // into `fileUrl` at load time, so a same-tab republish turns that
        // baked URL into a permanent 404 with no client-visible signal to
        // recover from. Distinguish that recoverable case (the artifact still
        // has *a* current version, just not the one this URL was pinned to)
        // from a genuine miss, and surface the current version id so a caller
        // can re-fetch `/v1/public/shares/:token` and retry with the fresh
        // URL instead of leaving the viewer on a dead link.
        const current =
          await contentArtifactsService.getSharedCurrentArtifactVersionMedia(
            resolved.artifact,
          );
        if (current && current.versionId !== requestedVersionId) {
          throw new ApiError(
            404,
            "ARTIFACT_VERSION_STALE",
            "This artifact has been republished; the requested version is no longer available",
            { currentVersionId: current.versionId },
          );
        }
        throw new ApiError(
          404,
          "ARTIFACT_VERSION_MEDIA_NOT_FOUND",
          "Artifact version media not found",
        );
      }
      c.header("ETag", media.etag);
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Referrer-Policy", "no-referrer");
      c.header("Cache-Control", SHARE_BYTES_CACHE_CONTROL);
      if (resolved.share.noindex) c.header("X-Robots-Tag", "noindex");
      if (media.kind === "not_modified") return c.body(null, 304);
      c.header("Accept-Ranges", "bytes");
      if (media.kind === "range_not_satisfiable") {
        c.header("Content-Range", `bytes */${media.totalLength}`);
        return c.body(null, 416);
      }
      c.header("Content-Type", media.contentType);
      c.header("Content-Length", String(media.contentLength));
      c.header(
        "Content-Disposition",
        `${media.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(media.fileName)}`,
      );
      if (media.contentRange) c.header("Content-Range", media.contentRange);
      return c.body(Buffer.from(media.body), media.status);
    },
  );

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

    const versionId = requestedVersion(c);
    const file = versionId
      ? await contentArtifactsService.getSharedVersionFile(
          resolved.artifact,
          versionId,
          { kind: "file" },
        )
      : await contentArtifactsService.getSharedArtifactFile(resolved.artifact);

    c.header("Content-Type", file.contentType);
    c.header(
      "Content-Disposition",
      `${c.req.query("download") === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    c.header(
      "Content-Security-Policy",
      file.executionPolicy
        ? artifactExecutionCsp(file.executionPolicy, [config.auth.webBaseUrl])
        : SANDBOX_CSP,
    );
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

    const versionId = requestedVersion(c);
    const preview = versionId
      ? await contentArtifactsService.getSharedVersionFile(
          resolved.artifact,
          versionId,
          { kind: "previewImage" },
        )
      : await contentArtifactsService.getSharedArtifactPreview(
          resolved.artifact,
        );
    if (!preview) {
      throw new ApiError(404, "PREVIEW_NOT_FOUND", "No preview image");
    }

    c.header("Content-Type", preview.contentType);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", SHARE_BYTES_CACHE_CONTROL);
    return c.body(Buffer.from(preview.body));
  });

  // Sub-assets (narration, images) for a share that client-renders in the
  // viewer's browser. Access is the share token in the path — the same grant
  // `/raw` and `/preview` use — so no authentication. The asset URLs the share
  // projection hands the client already point here.
  app.get("/v1/public/shares/:token/assets/:fileName", async (c) => {
    const resolved = await sharingService.resolvePublicArtifactBytes(
      requireRouteParam(c, "token"),
    );
    if (!resolved) {
      throw new ApiError(404, "SHARE_NOT_FOUND", "This share is not available");
    }

    const versionId = requestedVersion(c);
    const fileName = requireRouteParam(c, "fileName");
    const asset = versionId
      ? await contentArtifactsService.getSharedVersionFile(
          resolved.artifact,
          versionId,
          { kind: "asset", fileName },
        )
      : await contentArtifactsService.getSharedArtifactAsset(
          resolved.artifact,
          fileName,
        );

    c.header(
      "Content-Security-Policy",
      inertArtifactCsp([config.auth.webBaseUrl]),
    );
    c.header("Content-Type", asset.contentType);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", SHARE_BYTES_CACHE_CONTROL);
    return c.body(asset.body);
  });
}
