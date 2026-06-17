import type { Hono } from "hono";
import { contentThreadService } from "../../../modules/threads";
import { getSessionUserId, requireSession } from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { requireRouteParam } from "./helpers";

export function registerModelGatewayRoutes(app: Hono) {
  app.get("/model-gateway/models", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentThreadService.listThreadModelCatalog({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });
}
