import type { Hono } from "hono";
import {
  createSourceRequestSchema,
  createUrlSourceRequestSchema,
  indexSourceRequestSchema,
  listSourceMentionsRequestSchema,
  reparseSourceRequestSchema,
  retrySourceRequestSchema,
  updateSourceRequestSchema,
} from "@sourceweft/contracts";
import { contentService } from "../../../modules/content";
import { getSessionUserId, requireSession } from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { ensureObjectBody, requireRouteParam } from "./helpers";

export function registerSourceRoutes(app: Hono) {
  app.post("/sources/upload", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const form = await c.req.formData().catch(() => null);
    if (!form) {
      throw new ApiError(
        400,
        "INVALID_MULTIPART",
        "Invalid multipart form data",
      );
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "FILE_REQUIRED", "file is required");
    }

    const result = await contentService.uploadSource({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      fileName: file.name || "upload.bin",
      mimeType: file.type || "application/octet-stream",
      content: Buffer.from(await file.arrayBuffer()),
      sizeBytes: file.size,
      parentSourceId:
        typeof form.get("parentSourceId") === "string"
          ? String(form.get("parentSourceId")).trim() || null
          : null,
    });

    return ApiResponse.success(c, result, 201);
  });

  app.get("/sources", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.listSources({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/sources/mentions", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const parsed = listSourceMentionsRequestSchema.safeParse({
      query: c.req.query("query"),
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
    });
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.listSourceMentions({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      query: parsed.data.query,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    });

    return ApiResponse.success(c, result);
  });

  app.post("/sources", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = createSourceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.createSource({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      title: parsed.data.title,
      contentText: parsed.data.contentText,
      sourceType: parsed.data.sourceType,
      parentSourceId: parsed.data.parentSourceId,
    });

    return ApiResponse.success(c, result, 201);
  });

  app.post("/sources/url", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = createUrlSourceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.createUrlSource({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      url: parsed.data.url,
      title: parsed.data.title,
      parentSourceId: parsed.data.parentSourceId,
      forceRefresh: parsed.data.forceRefresh,
    });

    return ApiResponse.success(c, result, 201);
  });

  app.get("/sources/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.getSource({
      workspaceId: requireRouteParam(c, "workspaceId"),
      sourceId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get(
    "/sources/:id/documents/:documentId",
    async (c) => {
      const session = await requireSession(c);
      if (!session) {
        throw ApiError.unauthorized();
      }

      const result = await contentService.getSourceDocument({
        workspaceId: requireRouteParam(c, "workspaceId"),
        sourceId: requireRouteParam(c, "id"),
        documentId: requireRouteParam(c, "documentId"),
        userId: getSessionUserId(session),
      });

      return ApiResponse.success(c, result);
    },
  );

  app.get("/sources/:id/status", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.getSourceStatus({
      workspaceId: requireRouteParam(c, "workspaceId"),
      sourceId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/sources/:id/content", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.getSourceContent({
      workspaceId: requireRouteParam(c, "workspaceId"),
      sourceId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/sources/:id/download", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.downloadSource({
      workspaceId: requireRouteParam(c, "workspaceId"),
      sourceId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return c.redirect(result.url, 302);
  });

  app.patch("/sources/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = updateSourceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.updateSource({
      workspaceId: requireRouteParam(c, "workspaceId"),
      sourceId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      title: parsed.data.title,
      contentText: parsed.data.contentText,
      parentSourceId: parsed.data.parentSourceId,
    });

    return ApiResponse.success(c, result);
  });

  app.delete("/sources/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.deleteSource({
      workspaceId: requireRouteParam(c, "workspaceId"),
      sourceId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.post("/sources/:id/index", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = indexSourceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.indexSource({
      workspaceId: requireRouteParam(c, "workspaceId"),
      sourceId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      idempotencyKey: parsed.data.idempotencyKey,
    });

    return ApiResponse.success(c, result);
  });

  app.post("/sources/:id/reparse", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = reparseSourceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.reparseSource({
      workspaceId: requireRouteParam(c, "workspaceId"),
      sourceId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      chunkSize: parsed.data.chunkSize,
      forceRefresh: parsed.data.forceRefresh,
    });

    return ApiResponse.success(c, result, 202);
  });

  app.post("/sources/:id/retry", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = retrySourceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.retrySource({
      workspaceId: requireRouteParam(c, "workspaceId"),
      sourceId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      chunkSize: parsed.data.chunkSize,
      forceRefresh: parsed.data.forceRefresh,
    });

    return ApiResponse.success(c, result, 202);
  });
}
