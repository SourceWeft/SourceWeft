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

    const result = await contentArtifactsService.listArtifacts({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      limit,
      cursor: c.req.query("cursor"),
    });

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
