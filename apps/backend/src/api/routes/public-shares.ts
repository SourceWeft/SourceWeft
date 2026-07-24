import type { Hono } from "hono";
import { contentArtifactsService } from "../../modules/artifacts";
import { sharingService } from "../../modules/sharing";
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
].join("; ");

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
    const resolved = await sharingService.resolvePublicArtifactBytes(
      requireRouteParam(c, "token"),
      { countView: true },
    );
    if (!resolved) {
      throw new ApiError(404, "SHARE_NOT_FOUND", "This share is not available");
    }

    const file = await contentArtifactsService.getSharedArtifactFile(
      resolved.artifact,
    );

    c.header("Content-Type", file.contentType);
    c.header("Content-Security-Policy", SANDBOX_CSP);
    c.header("X-Content-Type-Options", "nosniff");
    // A direct top-level visit to /raw is still isolated by the CSP sandbox, but
    // this keeps it from being framed anywhere except our own share page.
    c.header("X-Frame-Options", "SAMEORIGIN");
    if (resolved.share.noindex) {
      c.header("X-Robots-Tag", "noindex");
    }
    c.header("Cache-Control", "public, max-age=300");
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
    c.header("Cache-Control", "public, max-age=300");
    return c.body(preview.body);
  });
}
