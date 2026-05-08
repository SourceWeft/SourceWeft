import type { Context, Hono } from "hono";
import { putWorkingFileRequestSchema } from "@sourceweft/contracts";
import { contentService } from "../../../modules/content";
import { getSessionUserId, requireSession } from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { ensureObjectBody, requireRouteParam } from "./helpers";

function requirePathQuery(c: Context) {
  const path = c.req.query("path")?.trim();
  if (!path) {
    throw new ApiError(400, "VALIDATION_ERROR", "path query parameter is required");
  }
  return path;
}

export function registerWorkingFileRoutes(app: Hono) {
  app.get("/threads/:id/working-files", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.listWorkingFiles({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/threads/:id/working-files/content", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.getWorkingFile({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      path: requirePathQuery(c),
    });

    return ApiResponse.success(c, result);
  });

  app.put("/threads/:id/working-files/content", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = putWorkingFileRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.putWorkingFile({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      path: requirePathQuery(c),
      contentText: parsed.data.contentText,
      mimeType: parsed.data.mimeType,
      purpose: parsed.data.purpose,
    });

    return ApiResponse.success(c, result);
  });

  app.delete("/threads/:id/working-files", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.deleteWorkingFile({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      path: requirePathQuery(c),
    });

    return ApiResponse.success(c, result);
  });
}
