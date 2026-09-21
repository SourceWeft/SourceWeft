import { Hono } from "hono";
import { config } from "../../shared/config";
import { mailDeliveryConfigured } from "../../modules/mail/delivery";
import { ApiResponse } from "../response/api-response";

export function registerAuthMetaRoutes(app: Hono) {
  app.get("/v1/auth/config", (c) => {
    return ApiResponse.success(c, {
      oneTapEnabled: Boolean(config.auth.googleOneTapClientId),
      // The sign-in and sign-up views route on this, so it has to be the
      // server's answer rather than a constant in the client.
      requireEmailVerification: mailDeliveryConfigured(),
      extension: {
        enabled: config.auth.extensionEnabled,
        clientId: config.auth.extensionClientId,
        redirectUri: config.auth.extensionRedirectUri,
        resource: config.auth.baseUrl,
      },
    });
  });
}
