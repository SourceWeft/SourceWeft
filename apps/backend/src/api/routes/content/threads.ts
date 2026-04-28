import type { Hono } from "hono";
import {
  createThreadRequestSchema,
  listThreadsRequestSchema,
  streamThreadRequestSchema,
  updateThreadModelSettingsRequestSchema,
} from "@sourceweft/contracts";
import { contentService } from "../../../modules/content";
import { getSessionUserId, requireSession } from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { createSseResponse, ensureObjectBody, requireRouteParam } from "./helpers";

export function registerThreadRoutes(app: Hono) {
  app.get("/threads", async (c) => {
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
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      limit: parsedQuery.data.limit,
      cursor: parsedQuery.data.cursor,
    });

    return ApiResponse.success(c, result);
  });

  app.post("/threads", async (c) => {
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
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      title: parsed.data.title,
      modelSettings: parsed.data.modelSettings,
    });

    return ApiResponse.success(c, result, 201);
  });

  app.get("/threads/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.getThread({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.patch("/threads/:id/model-settings", async (c) => {
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
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      llmModelAlias: parsed.data.llmModelAlias,
      imageModelAlias: parsed.data.imageModelAlias,
      visionModelAlias: parsed.data.visionModelAlias,
    });

    return ApiResponse.success(c, result);
  });

  app.get("/messages/:messageId/citations/:rank", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const rank = Number.parseInt(c.req.param("rank"), 10);
    if (!Number.isFinite(rank) || rank <= 0) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "rank must be a positive integer",
      );
    }

    const result = await contentService.getCitationDetail({
      workspaceId: requireRouteParam(c, "workspaceId"),
      messageId: requireRouteParam(c, "messageId"),
      rank,
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/threads/:id/messages", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.listThreadMessages({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.post("/threads/:id/stream", async (c) => {
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

    const workspaceId = requireRouteParam(c, "workspaceId");
    const threadId = requireRouteParam(c, "id");
    const userId = getSessionUserId(session);
    const mode = parsed.data.mode ?? "send";

    if ((mode === "send" || mode === "edit") && !parsed.data.content) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "content is required for send/edit mode",
      );
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
