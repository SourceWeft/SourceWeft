import type { Hono } from "hono";
import { createByokKeyRefRequestSchema } from "@sourceweft/contracts";
import { contentService } from "../../../modules/content";
import { getSessionUserId, requireSession } from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { ensureObjectBody, requireRouteParam } from "./helpers";

export function registerByokRoutes(app: Hono) {
  app.get("/model-gateway/byok-keys", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.listByokKeyRefs({
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
    const parsed = createByokKeyRefRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.createByokKeyRef({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      providerName: parsed.data.providerName,
      keyRef: parsed.data.keyRef,
      apiKey: parsed.data.apiKey,
      metadata: parsed.data.metadata,
    });

    return ApiResponse.success(c, result, 201);
  });

  app.delete("/model-gateway/byok-keys/:provider/:keyRef", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.deleteByokKeyRef({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      providerName: requireRouteParam(c, "provider"),
      keyRef: requireRouteParam(c, "keyRef"),
    });

    return ApiResponse.success(c, result);
  });
}
