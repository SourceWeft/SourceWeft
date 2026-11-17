import type { Hono } from "hono";
import { connectorOAuthService } from "../../modules/connectors";
import { ApiError, ApiResponse } from "../response/api-response";
import { requireRouteParam } from "./content/helpers";

function redirectWithOAuthResult(input: {
  accountId?: string | null;
  connectorType: string;
  error?: string | null;
  redirectAfter: string;
  status: "success" | "error";
  workspaceId: string;
}) {
  const redirectUrl = new URL(input.redirectAfter);
  redirectUrl.searchParams.set("connector_oauth", input.status);
  redirectUrl.searchParams.set("connector_type", input.connectorType);
  redirectUrl.searchParams.set("workspace_id", input.workspaceId);
  if (input.accountId) {
    redirectUrl.searchParams.set("account_id", input.accountId);
  }
  if (input.error) {
    redirectUrl.searchParams.set("error", input.error);
  }
  return redirectUrl.toString();
}

export function registerConnectorOAuthRoutes(app: Hono) {
  app.get("/v1/connectors/oauth/:connectorType/callback", async (c) => {
    const connectorType = requireRouteParam(c, "connectorType");
    const state = c.req.query("state");
    if (!state) {
      throw new ApiError(
        400,
        "CONNECTOR_OAUTH_CALLBACK_INVALID",
        "OAuth callback state is required",
      );
    }

    const brokered =
      connectorOAuthService.usesBrokeredAuthorization(connectorType);

    if (brokered) {
      const status = c.req.query("status");
      if (status !== "success") {
        const stateRow = await connectorOAuthService.getGlobalCallbackState({
          connectorType,
          state,
        });
        if (stateRow?.redirectAfter) {
          return c.redirect(
            redirectWithOAuthResult({
              connectorType,
              error:
                c.req.query("error_description") ||
                c.req.query("error") ||
                "Connector authorization did not complete.",
              redirectAfter: stateRow.redirectAfter,
              status: "error",
              workspaceId: stateRow.workspaceId,
            }),
          );
        }
        throw new ApiError(
          400,
          "CONNECTOR_OAUTH_CALLBACK_INVALID",
          "Connector authorization did not complete",
        );
      }

      const result = await connectorOAuthService.finishGlobalCallback({
        connectorType,
        state,
        callbackParams: { ...c.req.query() },
      });
      if (result.redirectAfter) {
        return c.redirect(
          redirectWithOAuthResult({
            accountId: result.account.id,
            connectorType: result.account.connectorType,
            redirectAfter: result.redirectAfter,
            status: "success",
            workspaceId: result.account.workspaceId,
          }),
        );
      }
      return ApiResponse.success(c, result);
    }

    const code = c.req.query("code");
    const oauthError = c.req.query("error");
    const oauthErrorDescription = c.req.query("error_description");
    if (oauthError || !code) {
      const stateRow = await connectorOAuthService.getGlobalCallbackState({
        connectorType,
        state,
      });
      if (stateRow?.redirectAfter) {
        return c.redirect(
          redirectWithOAuthResult({
            connectorType,
            error:
              oauthErrorDescription ||
              oauthError ||
              "Connector authorization did not complete.",
            redirectAfter: stateRow.redirectAfter,
            status: "error",
            workspaceId: stateRow.workspaceId,
          }),
        );
      }
      throw new ApiError(
        400,
        "CONNECTOR_OAUTH_CALLBACK_INVALID",
        "OAuth callback code is required",
      );
    }

    const result = await connectorOAuthService.finishGlobalCallback({
      connectorType,
      code,
      state,
    });
    if (result.redirectAfter) {
      return c.redirect(
        redirectWithOAuthResult({
          accountId: result.account.id,
          connectorType: result.account.connectorType,
          redirectAfter: result.redirectAfter,
          status: "success",
          workspaceId: result.account.workspaceId,
        }),
      );
    }
    return ApiResponse.success(c, result);
  });
}
