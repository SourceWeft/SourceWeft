import { Hono } from "hono";
import { config } from "../../shared/config";
import { ApiResponse } from "../response/api-response";

export function registerAuthMetaRoutes(app: Hono) {
  app.get("/v1/auth/config", (c) => {
    return ApiResponse.success(c, {
      oneTapEnabled: Boolean(config.auth.googleOneTapClientId),
      extension: {
        clientId: config.auth.extensionClientId,
        redirectUri: config.auth.extensionRedirectUri,
      },
    });
  });
}
