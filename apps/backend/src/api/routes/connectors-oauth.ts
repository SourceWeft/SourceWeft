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
    if (result.redirectAfter) {
      const redirectUrl = new URL(result.redirectAfter);
      redirectUrl.searchParams.set("connector_oauth", "success");
      redirectUrl.searchParams.set("connector_type", result.account.connectorType);
      redirectUrl.searchParams.set("account_id", result.account.id);
      return c.redirect(redirectUrl.toString());
    }
    return ApiResponse.success(c, result);
  });
}
