import { Hono } from "hono";
import {
  createByokKeyRefRequestSchema,
  createSourceRequestSchema,
  createThreadRequestSchema,
  listThreadsRequestSchema,
  indexSourceRequestSchema,
  reparseSourceRequestSchema,
  streamThreadRequestSchema,
  updateThreadModelSettingsRequestSchema,
  updateSourceRequestSchema,
} from "@sourceweft/contracts";
import { contentService } from "../../modules/content";
import { getSessionUserId, requireSession } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";

function ensureObjectBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw ApiError.invalidJson();
  }

  return value;
}

function createSseResponse(stream: AsyncGenerator<string>) {
  const bodyStream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          controller.enqueue(chunk);
        }
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Stream failed";
        controller.enqueue(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
        controller.close();
      }
    },
  });

  return bodyStream;
}

export function registerContentRoutes(app: Hono) {
  app.post("/v1/workspaces/:workspaceId/sources/upload", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const form = await c.req.formData().catch(() => null);
    if (!form) {
      throw new ApiError(400, "INVALID_MULTIPART", "Invalid multipart form data");
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "FILE_REQUIRED", "file is required");
    }

    const result = await contentService.uploadSource({
      workspaceId: c.req.param("workspaceId"),
      userId: getSessionUserId(session),
      fileName: file.name || "upload.bin",
      mimeType: file.type || "application/octet-stream",
      content: Buffer.from(await file.arrayBuffer()),
      sizeBytes: file.size,
    });

    return ApiResponse.success(c, result, 201);
  });

  app.get("/v1/workspaces/:workspaceId/sources", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.listSources({
      workspaceId: c.req.param("workspaceId"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.post("/v1/workspaces/:workspaceId/sources", async (c) => {
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
      workspaceId: c.req.param("workspaceId"),
      userId: getSessionUserId(session),
      title: parsed.data.title,
      contentText: parsed.data.contentText,
      estimatedPages: parsed.data.estimatedPages,
      parsedTokens: parsed.data.parsedTokens,
    });

    return ApiResponse.success(c, result, 201);
  });

  app.get("/v1/workspaces/:workspaceId/sources/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.getSource({
      workspaceId: c.req.param("workspaceId"),
      sourceId: c.req.param("id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/v1/workspaces/:workspaceId/sources/:id/status", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.getSourceStatus({
      workspaceId: c.req.param("workspaceId"),
      sourceId: c.req.param("id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/v1/workspaces/:workspaceId/sources/:id/content", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.getSourceContent({
      workspaceId: c.req.param("workspaceId"),
      sourceId: c.req.param("id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.patch("/v1/workspaces/:workspaceId/sources/:id", async (c) => {
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
      workspaceId: c.req.param("workspaceId"),
      sourceId: c.req.param("id"),
      userId: getSessionUserId(session),
      title: parsed.data.title,
      contentText: parsed.data.contentText,
      estimatedPages: parsed.data.estimatedPages,
      parsedTokens: parsed.data.parsedTokens,
    });

    return ApiResponse.success(c, result);
  });

  app.delete("/v1/workspaces/:workspaceId/sources/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.deleteSource({
      workspaceId: c.req.param("workspaceId"),
      sourceId: c.req.param("id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.post("/v1/workspaces/:workspaceId/sources/:id/index", async (c) => {
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
      workspaceId: c.req.param("workspaceId"),
      sourceId: c.req.param("id"),
      userId: getSessionUserId(session),
      estimatedPages: parsed.data.estimatedPages,
      parsedTokens: parsed.data.parsedTokens,
      idempotencyKey: parsed.data.idempotencyKey,
    });

    return ApiResponse.success(c, result);
  });

  app.post("/v1/workspaces/:workspaceId/sources/:id/reparse", async (c) => {
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
      workspaceId: c.req.param("workspaceId"),
      sourceId: c.req.param("id"),
      userId: getSessionUserId(session),
      chunkSize: parsed.data.chunkSize,
    });

    return ApiResponse.success(c, result, 202);
  });

  app.get("/v1/workspaces/:workspaceId/model-gateway/byok-keys", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.listByokKeyRefs({
      workspaceId: c.req.param("workspaceId"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.post("/v1/workspaces/:workspaceId/model-gateway/byok-keys", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = createByokKeyRefRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.createByokKeyRef({
      workspaceId: c.req.param("workspaceId"),
      userId: getSessionUserId(session),
      providerName: parsed.data.providerName,
      keyRef: parsed.data.keyRef,
      apiKey: parsed.data.apiKey,
      metadata: parsed.data.metadata,
    });

    return ApiResponse.success(c, result, 201);
  });

  app.delete("/v1/workspaces/:workspaceId/model-gateway/byok-keys/:provider/:keyRef", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.deleteByokKeyRef({
      workspaceId: c.req.param("workspaceId"),
      userId: getSessionUserId(session),
      providerName: c.req.param("provider"),
      keyRef: c.req.param("keyRef"),
    });

    return ApiResponse.success(c, result);
  });


  app.get("/v1/workspaces/:workspaceId/threads", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const parsedQuery = listThreadsRequestSchema.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit")
        ? Number.parseInt(c.req.query("limit") as string, 10)
        : undefined,
    });
    if (!parsedQuery.success) {
      throw ApiError.validation(
        parsedQuery.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.listThreads({
      workspaceId: c.req.param("workspaceId"),
      userId: getSessionUserId(session),
      limit: parsedQuery.data.limit,
      cursor: parsedQuery.data.cursor,
    });

    return ApiResponse.success(c, result);
  });

  app.post("/v1/workspaces/:workspaceId/threads", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = createThreadRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.createThread({
      workspaceId: c.req.param("workspaceId"),
      userId: getSessionUserId(session),
      title: parsed.data.title,
      modelSettings: parsed.data.modelSettings,
    });

    return ApiResponse.success(c, result, 201);
  });

  app.get("/v1/workspaces/:workspaceId/model-gateway/models", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.listThreadModelCatalog({
      workspaceId: c.req.param("workspaceId"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/v1/workspaces/:workspaceId/threads/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.getThread({
      workspaceId: c.req.param("workspaceId"),
      threadId: c.req.param("id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.patch("/v1/workspaces/:workspaceId/threads/:id/model-settings", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = updateThreadModelSettingsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.updateThreadModelSettings({
      workspaceId: c.req.param("workspaceId"),
      threadId: c.req.param("id"),
      userId: getSessionUserId(session),
      llmProfileAlias: parsed.data.llmProfileAlias,
      imageProfileAlias: parsed.data.imageProfileAlias,
      visionProfileAlias: parsed.data.visionProfileAlias,
    });

    return ApiResponse.success(c, result);
  });

  app.get("/v1/workspaces/:workspaceId/messages/:messageId/citations/:rank", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const rank = Number.parseInt(c.req.param("rank"), 10);
    if (!Number.isFinite(rank) || rank <= 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "rank must be a positive integer");
    }

    const result = await contentService.getCitationDetail({
      workspaceId: c.req.param("workspaceId"),
      messageId: c.req.param("messageId"),
      rank,
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/v1/workspaces/:workspaceId/threads/:id/messages", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.listThreadMessages({
      workspaceId: c.req.param("workspaceId"),
      threadId: c.req.param("id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.post("/v1/workspaces/:workspaceId/threads/:id/stream", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = streamThreadRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const workspaceId = c.req.param("workspaceId");
    const threadId = c.req.param("id");
    const userId = getSessionUserId(session);
    const mode = parsed.data.mode ?? "send";

    if ((mode === "send" || mode === "edit") && !parsed.data.content) {
      throw new ApiError(400, "VALIDATION_ERROR", "content is required for send/edit mode");
    }

    if (parsed.data.stream === false) {
      const result =
        mode === "refresh"
          ? await contentService.refreshThread({
              workspaceId,
              threadId,
              userId,
              sourceIds: parsed.data.sourceIds,
              userMessageId: parsed.data.userMessageId,
              assistantMessageId: parsed.data.assistantMessageId,
              idempotencyKey: parsed.data.idempotencyKey,
              llm: parsed.data.llm,
            })
          : mode === "edit"
            ? await contentService.editThread({
                workspaceId,
                threadId,
                userId,
                content: parsed.data.content ?? "",
                sourceIds: parsed.data.sourceIds,
                userMessageId: parsed.data.userMessageId,
                assistantMessageId: parsed.data.assistantMessageId,
                idempotencyKey: parsed.data.idempotencyKey,
                llm: parsed.data.llm,
              })
            : await contentService.streamThread({
                workspaceId,
                threadId,
                userId,
                content: parsed.data.content ?? "",
                sourceIds: parsed.data.sourceIds,
                idempotencyKey: parsed.data.idempotencyKey,
                llm: parsed.data.llm,
              });

      return ApiResponse.success(c, result);
    }

    const stream =
      mode === "refresh"
        ? contentService.refreshThreadEvents({
            workspaceId,
            threadId,
            userId,
            sourceIds: parsed.data.sourceIds,
            userMessageId: parsed.data.userMessageId,
            assistantMessageId: parsed.data.assistantMessageId,
            idempotencyKey: parsed.data.idempotencyKey,
            llm: parsed.data.llm,
          })
        : mode === "edit"
          ? contentService.editThreadEvents({
              workspaceId,
              threadId,
              userId,
              content: parsed.data.content ?? "",
              sourceIds: parsed.data.sourceIds,
              userMessageId: parsed.data.userMessageId,
              assistantMessageId: parsed.data.assistantMessageId,
              idempotencyKey: parsed.data.idempotencyKey,
              llm: parsed.data.llm,
            })
          : contentService.streamThreadEvents({
              workspaceId,
              threadId,
              userId,
              content: parsed.data.content ?? "",
              sourceIds: parsed.data.sourceIds,
              idempotencyKey: parsed.data.idempotencyKey,
              llm: parsed.data.llm,
            });

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");
    return c.body(createSseResponse(stream));
  });
}
