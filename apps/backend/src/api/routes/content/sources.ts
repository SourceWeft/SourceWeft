import type { Hono } from "hono";
import {
  bulkDeleteSourcesRequestSchema,
  createSourceRequestSchema,
  createSourceUploadIntentRequestSchema,
  createUrlSourceRequestSchema,
  indexSourceRequestSchema,
  listSourcesRequestSchema,
  listSourceStatusesRequestSchema,
  listSourceMentionsRequestSchema,
  reparseSourceRequestSchema,
  retrySourceRequestSchema,
  updateSourceRequestSchema,
} from "@sourceweft/contracts";
import {
  contentSourceService,
  sourceIndexingService,
  sourceParsingService,
} from "../../../modules/sources";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { ensureObjectBody, requireRouteParam } from "./helpers";

function parseOptionalBooleanQuery(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return value;
}

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

    const result = await contentSourceService.uploadSource({
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

  // Direct upload, first leg: the bytes never reach this process. The client
  // takes the presigned PUT from here straight to the object store, then calls
  // the completion route below.
  app.post("/sources/upload-intent", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = createSourceUploadIntentRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentSourceService.createSourceUploadIntent({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      fileName: parsed.data.fileName,
      mimeType: parsed.data.mimeType,
      sizeBytes: parsed.data.sizeBytes,
      parentSourceId: parsed.data.parentSourceId ?? null,
    });

    return ApiResponse.success(c, result, 201);
  });

  // Direct upload, second leg: verifies what actually landed in the store and
  // queues the parse. Idempotent — a retry after a lost response returns the
  // already-queued source instead of enqueuing twice.
  app.post("/sources/:id/upload-complete", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentSourceService.completeSourceUpload({
      workspaceId: requireRouteParam(c, "workspaceId"),
      sourceId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/sources", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const parsed = listSourcesRequestSchema.safeParse({
      view: c.req.query("view"),
      includeContent: parseOptionalBooleanQuery(c.req.query("includeContent")),
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
      parentSourceId:
        c.req.query("parentSourceId") === "__root"
          ? null
          : c.req.query("parentSourceId"),
      connectorId: c.req.query("connectorId"),
      syncRunId: c.req.query("syncRunId"),
      updatedAfter: c.req.query("updatedAfter"),
    });
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentSourceService.listSources({
      view: parsed.data.view,
      includeContent: parsed.data.includeContent ?? true,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
      parentSourceId: parsed.data.parentSourceId,
      connectorId: parsed.data.connectorId,
      syncRunId: parsed.data.syncRunId,
      updatedAfter: parsed.data.updatedAfter,
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

    const result = await contentSourceService.listSourceMentions({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      query: parsed.data.query,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    });

    return ApiResponse.success(c, result);
  });

  app.post("/sources/bulk-delete", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = bulkDeleteSourcesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentSourceService.bulkDeleteSources({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      sourceIds: parsed.data.sourceIds,
    });

    return ApiResponse.success(c, result);
  });

  app.post("/sources/status", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = listSourceStatusesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentSourceService.listSourceStatuses({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      sourceIds: parsed.data.ids,
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

    const result = await contentSourceService.createSource({
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

    const result = await contentSourceService.createUrlSource({
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

    const result = await contentSourceService.getSource({
      workspaceId: requireRouteParam(c, "workspaceId"),
      sourceId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/sources/:id/documents/:documentId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentSourceService.getSourceDocument({
      workspaceId: requireRouteParam(c, "workspaceId"),
      sourceId: requireRouteParam(c, "id"),
      documentId: requireRouteParam(c, "documentId"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/sources/:id/status", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentSourceService.getSourceStatus({
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

    const result = await contentSourceService.getSourceContent({
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

    const result = await contentSourceService.downloadSource({
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

    const result = await contentSourceService.updateSource({
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

    const result = await contentSourceService.deleteSource({
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

    const result = await sourceIndexingService.indexSource({
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

    const result = await sourceParsingService.reparseSource({
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

    const retryInput = {
      workspaceId: requireRouteParam(c, "workspaceId"),
      sourceId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      chunkSize: parsed.data.chunkSize,
      forceRefresh: parsed.data.forceRefresh,
    };
    const reparsed =
      await sourceParsingService.tryQueueSourceReparse(retryInput);
    const result = reparsed
      ? { ...reparsed, mode: "reparse" as const }
      : {
          ...(await sourceIndexingService.indexSource(retryInput)),
          mode: "index" as const,
        };

    return ApiResponse.success(c, result, 202);
  });
}
