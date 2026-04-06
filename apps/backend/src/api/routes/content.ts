import { Hono } from "hono";
import {
  createSourceRequestSchema,
  createThreadRequestSchema,
  indexSourceRequestSchema,
  streamThreadRequestSchema,
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

export function registerContentRoutes(app: Hono) {
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
    });

    return ApiResponse.success(c, result, 201);
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

    const result = await contentService.streamThread({
      workspaceId: c.req.param("workspaceId"),
      threadId: c.req.param("id"),
      userId: getSessionUserId(session),
      content: parsed.data.content,
      idempotencyKey: parsed.data.idempotencyKey,
    });

    return ApiResponse.success(c, result);
  });
}
