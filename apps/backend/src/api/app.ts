import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "../modules/auth";
import { handleCreemScheduledCancelWebhook } from "../modules/billing/providers/creem-webhook-bypass";
import { config } from "../shared/config";
import { logger } from "../shared/logger";
import { describeError } from "./response/error-detail";
import { ApiError, ApiResponse, toApiError } from "./response/api-response";
import { performanceLoggingMiddleware } from "./middleware/performance-logging";
import { workspaceRoleGuard } from "./middleware/workspace-role";
import { registerAuthMetaRoutes } from "./routes/auth-meta";
import { registerBillingRoutes } from "./routes/billing";
import { registerContentRoutes } from "./routes/content";
import { registerConnectorOAuthRoutes } from "./routes/connectors-oauth";
import { registerConnectorWebhookRoutes } from "./routes/connectors-webhooks";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerDesktopAuthRoutes } from "./routes/desktop-auth";
import { healthResponse } from "./routes/health";
import { registerJobRoutes } from "./routes/jobs";
import { registerPublicShareRoutes } from "./routes/public-shares";
import { registerMarketRoutes } from "./routes/market";
import { registerTeamLlmObservabilityRoutes } from "./routes/llm-observability";
import { registerUserSettingsRoutes } from "./routes/user-settings";
import { registerWorkspaceRoutes } from "./routes/workspace";
import { withBetterAuthClientIp } from "./better-auth-request";

export function createApp() {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) {
          return "";
        }

        if (
          origin.startsWith("chrome-extension://") ||
          origin.startsWith("moz-extension://")
        ) {
          return origin;
        }

        if (config.auth.trustedOrigins.length === 0) {
          return origin;
        }

        return config.auth.trustedOrigins.includes(origin) ? origin : "";
      },
      allowHeaders: ["Content-Type", "Authorization", "X-Workspace-Id"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      exposeHeaders: [
        "set-auth-token",
        "set-auth-jwt",
        "content-length",
        "content-disposition",
      ],
      credentials: true,
      maxAge: 600,
    }),
  );

  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const authRequest = withBetterAuthClientIp(c);

    if (c.req.method === "POST") {
      const scheduledCancelResponse = await handleCreemScheduledCancelWebhook(
        authRequest.clone(),
      );
      if (scheduledCancelResponse) {
        return scheduledCancelResponse;
      }
    }

    return auth.handler(authRequest);
  });

  app.get("/.well-known/oauth-authorization-server/api/auth", (c) =>
    oauthProviderAuthServerMetadata(auth)(withBetterAuthClientIp(c)),
  );

  app.get("/.well-known/openid-configuration", (c) =>
    oauthProviderOpenIdConfigMetadata(auth)(withBetterAuthClientIp(c)),
  );

  app.get("/v1/health", (c) => {
    return ApiResponse.success(c, healthResponse(), 200);
  });

  app.use("/v1/*", performanceLoggingMiddleware);

  // Must be registered before any workspace-scoped handler: Hono composes
  // middleware and handlers in registration order, so a guard added after a
  // route would never wrap it. Two patterns because `/*` does not stand in for
  // the bare workspace path that the rename endpoint uses.
  app.use("/v1/workspaces/:workspaceId", workspaceRoleGuard);
  app.use("/v1/workspaces/:workspaceId/*", workspaceRoleGuard);

  registerAuthMetaRoutes(app);
  registerDesktopAuthRoutes(app);
  registerConnectorOAuthRoutes(app);
  registerConnectorWebhookRoutes(app);
  registerWorkspaceRoutes(app);
  registerDashboardRoutes(app);
  registerUserSettingsRoutes(app);
  registerBillingRoutes(app);
  registerContentRoutes(app);
  registerMarketRoutes(app);
  registerJobRoutes(app);
  registerPublicShareRoutes(app);
  registerTeamLlmObservabilityRoutes(app);

  app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));

  app.onError((error, c) => {
    const apiError = toApiError(error);
    const errorDetail = describeError(error);
    logger.error("API request failed", {
      method: c.req.method,
      pathname: new URL(c.req.url).pathname,
      code: apiError.code,
      status: apiError.statusCode,
      errorName: errorDetail.name,
      error: errorDetail.message,
      errorStack: errorDetail.stack,
      errorResponseStatus: errorDetail.status,
      errorBodyCode: errorDetail.bodyCode,
      errorBodyMessage: errorDetail.bodyMessage,
      errorResponseStatusText: errorDetail.statusText,
      errorResponseUrl: errorDetail.url,
    });
    return ApiResponse.error(c, apiError);
  });

  return app;
}
