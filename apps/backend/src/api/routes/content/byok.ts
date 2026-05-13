import type { Hono } from "hono";
import { createByokKeyRefRequestSchema } from "@sourceweft/contracts";
import { z } from "zod";
import { contentByokService } from "../../../modules/content/byok";
import { getSessionUserId, requireSession } from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { ensureObjectBody, requireRouteParam } from "./helpers";

const createByokKeyRefRouteSchema = createByokKeyRefRequestSchema.extend({
  providerKind: z.string().trim().min(1).max(100).optional(),
  baseUrl: z.string().trim().url().max(2048).optional(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
});

export function registerByokRoutes(app: Hono) {
  app.get("/model-gateway/byok-keys", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentByokService.listByokKeyRefs({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.post("/model-gateway/byok-keys", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = createByokKeyRefRouteSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    const parsedData = parsed.data as {
      providerName: string;
      keyRef: string;
      apiKey: string;
      providerKind?: string;
      baseUrl?: string;
      defaultHeaders?: Record<string, string>;
      metadata?: Record<string, unknown>;
    };

    const result = await contentByokService.createByokKeyRef({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      providerName: parsedData.providerName,
      keyRef: parsedData.keyRef,
      apiKey: parsedData.apiKey,
      providerKind: parsedData.providerKind,
      baseUrl: parsedData.baseUrl,
      defaultHeaders: parsedData.defaultHeaders,
      metadata: parsedData.metadata,
    });

    return ApiResponse.success(c, result, 201);
  });

  app.delete("/model-gateway/byok-keys/:provider/:keyRef", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentByokService.deleteByokKeyRef({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      providerName: requireRouteParam(c, "provider"),
      keyRef: requireRouteParam(c, "keyRef"),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/model-gateway/byok-providers", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentByokService.listByokProviders({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });
}
