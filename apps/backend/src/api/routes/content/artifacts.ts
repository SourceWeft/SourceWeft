import type { Hono } from "hono";
import { contentService } from "../../../modules/content";
import { getSessionUserId, requireSession } from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { requireRouteParam } from "./helpers";

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

    const result = await contentService.listArtifacts({
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

    const result = await contentService.getArtifactFile({
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

  app.get("/artifacts/:id/download", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.getArtifactFile({
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
}
