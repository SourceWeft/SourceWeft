import type { Hono } from "hono";
import { connectorOAuthService } from "../../modules/connectors";
import { ApiError, ApiResponse } from "../response/api-response";
import { requireRouteParam } from "./content/helpers";

export function registerConnectorOAuthRoutes(app: Hono) {
  app.get("/v1/connectors/oauth/:connectorType/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) {
      throw new ApiError(
        400,
        "CONNECTOR_OAUTH_CALLBACK_INVALID",
        "OAuth callback code and state are required",
      );
    }

    const result = await connectorOAuthService.finishGlobalCallback({
      connectorType: requireRouteParam(c, "connectorType"),
      code,
      state,
    });
    return ApiResponse.success(c, result);
  });
}

