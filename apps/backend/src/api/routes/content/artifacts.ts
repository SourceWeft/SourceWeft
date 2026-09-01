import type { Hono } from "hono";
import {
  createArtifactShareRequestSchema,
  updateArtifactShareRequestSchema,
} from "@sourceweft/contracts";
import { contentArtifactsService } from "../../../modules/artifacts";
import { sharingService } from "../../../modules/sharing";
import type { ShareMutationResult } from "../../../modules/sharing";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { ensureObjectBody, requireRouteParam } from "./helpers";

/** `not_found` hides existence from callers who lack access to the artifact. */
function unwrapShareResult<T>(result: ShareMutationResult<T>): T {
  if (result.ok) {
    return result.value;
  }
  if (result.reason === "forbidden") {
    throw ApiError.forbidden(
      "Only the artifact's creator or a workspace admin can share it.",
    );
  }
  throw new ApiError(404, "ARTIFACT_NOT_FOUND", "Artifact not found");
}

export function registerArtifactRoutes(app: Hono) {
  app.get("/artifacts", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const limitParam = c.req.query("limit");
    const limit = limitParam
      ? Math.min(Math.max(Number.parseInt(limitParam, 10) || 100, 1), 200)
      : undefined;

    const view = c.req.query("view");
    if (view !== undefined && view !== "summary") {
      throw ApiError.validation({
        view: ["Expected 'summary' when the view parameter is provided."],
      });
    }

    const input = {
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      limit,
      cursor: c.req.query("cursor"),
    };
    const result =
      view === "summary"
        ? await contentArtifactsService.listArtifactSummaries(input)
        : await contentArtifactsService.listArtifacts(input);

    return ApiResponse.success(c, result);
  });

  app.get("/artifacts/:id/file", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentArtifactsService.getArtifactFile({
      workspaceId: requireRouteParam(c, "workspaceId"),
      artifactId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    c.header("Content-Type", result.contentType);
    c.header(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
    );
    c.header("Cache-Control", "private, max-age=60");
    if (result.renderer) {
      c.header("X-SourceWeft-Artifact-Renderer", result.renderer);
    }
    return c.body(result.body);
  });

  app.get("/artifacts/:id/versions/:versionId/media", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }
    const result = await contentArtifactsService.getArtifactVersionMedia({
      workspaceId: requireRouteParam(c, "workspaceId"),
      artifactId: requireRouteParam(c, "id"),
      artifactVersionId: requireRouteParam(c, "versionId"),
      userId: getSessionUserId(session),
    });
    return ApiResponse.success(c, result);
  });

  app.get("/artifacts/:id/versions/:versionId/media/:resource", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }
    const resource = requireRouteParam(c, "resource");
    if (resource !== "video" && resource !== "cover") {
      throw new ApiError(
        404,
        "ARTIFACT_VERSION_MEDIA_NOT_FOUND",
        "Artifact version media not found",
      );
    }
    const result = await contentArtifactsService.getArtifactVersionMediaBytes({
      workspaceId: requireRouteParam(c, "workspaceId"),
      artifactId: requireRouteParam(c, "id"),
      artifactVersionId: requireRouteParam(c, "versionId"),
      userId: getSessionUserId(session),
      resource,
      range: c.req.header("range"),
      ifNoneMatch: c.req.header("if-none-match"),
      download: c.req.query("download") === "1",
    });
    c.header("ETag", result.etag);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "private, no-cache, max-age=0, must-revalidate");
    if (result.kind === "not_modified") {
      return c.body(null, 304);
    }
    c.header("Accept-Ranges", "bytes");
    if (result.kind === "range_not_satisfiable") {
      c.header("Content-Range", `bytes */${result.totalLength}`);
      return c.body(null, 416);
    }
    c.header("Content-Type", result.contentType);
    c.header("Content-Length", String(result.contentLength));
    c.header(
      "Content-Disposition",
      `${result.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
    );
    if (result.contentRange) {
      c.header("Content-Range", result.contentRange);
    }
    return c.body(Buffer.from(result.body), result.status);
  });

  app.get("/artifacts/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentArtifactsService.getArtifact({
      workspaceId: requireRouteParam(c, "workspaceId"),
      artifactId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.delete("/artifacts/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentArtifactsService.deleteArtifact({
      workspaceId: requireRouteParam(c, "workspaceId"),
      artifactId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/artifacts/:id/source.json", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentArtifactsService.getArtifactSourceJson({
      workspaceId: requireRouteParam(c, "workspaceId"),
      artifactId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    c.header("Content-Type", result.contentType);
    c.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
    );
    c.header("Cache-Control", "private, max-age=60");
    return c.body(result.body);
  });

  app.get("/artifacts/:id/preview-image", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentArtifactsService.getArtifactPreviewImage({
      workspaceId: requireRouteParam(c, "workspaceId"),
      artifactId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    c.header("Content-Type", result.contentType);
    c.header(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
    );
    c.header("Cache-Control", "private, max-age=60");
    return c.body(result.body);
  });

  app.get("/artifacts/:id/assets/:fileName", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentArtifactsService.getArtifactAsset({
      workspaceId: requireRouteParam(c, "workspaceId"),
      artifactId: requireRouteParam(c, "id"),
      fileName: requireRouteParam(c, "fileName"),
      userId: getSessionUserId(session),
    });

    c.header("Content-Type", result.contentType);
    c.header(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
    );
    c.header("Cache-Control", "private, max-age=60");
    return c.body(result.body);
  });

  app.get("/artifacts/:id/download", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentArtifactsService.getArtifactFile({
      workspaceId: requireRouteParam(c, "workspaceId"),
      artifactId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    c.header("Content-Type", result.contentType);
    c.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
    );
    c.header("Cache-Control", "private, max-age=60");
    return c.body(result.body);
  });

  app.get("/artifacts/:id/share", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await sharingService.getArtifactShare({
      workspaceId: requireRouteParam(c, "workspaceId"),
      artifactId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, { share: unwrapShareResult(result) });
  });

  app.post("/artifacts/:id/share", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const parsed = createArtifactShareRequestSchema.safeParse(
      ensureObjectBody(await c.req.json().catch(() => ({}))),
    );
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await sharingService.shareArtifact({
      workspaceId: requireRouteParam(c, "workspaceId"),
      artifactId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      noindex: parsed.data.noindex,
      expiresAt: parsed.data.expiresAt,
    });

    return ApiResponse.success(c, { share: unwrapShareResult(result) }, 201);
  });

  app.patch("/artifacts/:id/share", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const parsed = updateArtifactShareRequestSchema.safeParse(
      ensureObjectBody(await c.req.json().catch(() => ({}))),
    );
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await sharingService.updateArtifactShare({
      workspaceId: requireRouteParam(c, "workspaceId"),
      artifactId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      noindex: parsed.data.noindex,
      expiresAt: parsed.data.expiresAt,
    });

    return ApiResponse.success(c, { share: unwrapShareResult(result) });
  });

  app.delete("/artifacts/:id/share", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await sharingService.revokeArtifactShare({
      workspaceId: requireRouteParam(c, "workspaceId"),
      artifactId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    unwrapShareResult(result);
    return ApiResponse.success(c, { ok: true });
  });
}
