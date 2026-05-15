import type { Hono } from "hono";
import {
  createConnectorActionRequestSchema,
  createConnectorRequestSchema,
  listConnectorOAuthAccountsRequestSchema,
  startConnectorOAuthRequestSchema,
  updateConnectorRequestSchema,
} from "@sourceweft/contracts";
import {
  connectorActionRunner,
  connectorOAuthService,
  connectorService,
  connectorSyncOrchestrator,
} from "../../../modules/connectors";
import { enqueueConnectorSyncJob } from "../../../modules/content/queue";
import { getSessionUserId, requireSession } from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { ensureObjectBody, requireRouteParam } from "./helpers";

export function registerConnectorRoutes(app: Hono) {
  app.get("/connectors/manifests", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    return ApiResponse.success(c, connectorService.listManifests());
  });

  app.post("/connectors/oauth/:connectorType/start", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = startConnectorOAuthRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(parsed.error.flatten() as Record<string, unknown>);
    }

    const result = await connectorOAuthService.start({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      connectorType: requireRouteParam(c, "connectorType"),
      redirectAfter: parsed.data.redirectAfter,
    });
    return ApiResponse.success(c, result, 201);
  });

  app.get("/connectors/oauth/:connectorType/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) {
      throw new ApiError(
        400,
        "CONNECTOR_OAUTH_CALLBACK_INVALID",
        "OAuth callback code and state are required",
      );
    }

    const result = await connectorOAuthService.finish({
      workspaceId: requireRouteParam(c, "workspaceId"),
      connectorType: requireRouteParam(c, "connectorType"),
      code,
      state,
    });
    return ApiResponse.success(c, result);
  });

  app.get("/connectors/accounts", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const parsed = listConnectorOAuthAccountsRequestSchema.safeParse({
      connectorType: c.req.query("connectorType"),
    });
    if (!parsed.success) {
      throw ApiError.validation(parsed.error.flatten() as Record<string, unknown>);
    }

    const result = await connectorService.listAccounts({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      connectorType: parsed.data.connectorType,
    });
    return ApiResponse.success(c, result);
  });

  app.post("/connectors", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = createConnectorRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(parsed.error.flatten() as Record<string, unknown>);
    }

    const result = await connectorService.createConnector({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      connectorType: parsed.data.connectorType,
      name: parsed.data.name,
      oauthAccountId: parsed.data.oauthAccountId,
      configJson: parsed.data.configJson,
      periodicIndexingEnabled: parsed.data.periodicIndexingEnabled,
      indexingFrequencyMinutes: parsed.data.indexingFrequencyMinutes,
    });
    return ApiResponse.success(c, result, 201);
  });

  app.get("/connectors", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await connectorService.listConnectors({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
    });
    return ApiResponse.success(c, result);
  });

  app.patch("/connectors/:connectorId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = updateConnectorRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(parsed.error.flatten() as Record<string, unknown>);
    }

    const result = await connectorService.updateConnector({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      connectorId: requireRouteParam(c, "connectorId"),
      name: parsed.data.name,
      configJson: parsed.data.configJson,
      status: parsed.data.status,
      periodicIndexingEnabled: parsed.data.periodicIndexingEnabled,
      indexingFrequencyMinutes: parsed.data.indexingFrequencyMinutes,
    });
    return ApiResponse.success(c, result);
  });

  app.delete("/connectors/:connectorId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await connectorService.deleteConnector({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      connectorId: requireRouteParam(c, "connectorId"),
    });
    return ApiResponse.success(c, result);
  });

  app.post("/connectors/:connectorId/sync", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await connectorSyncOrchestrator.enqueueManualRun({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      connectorId: requireRouteParam(c, "connectorId"),
      enqueue: enqueueConnectorSyncJob,
    });
    return ApiResponse.success(c, result, 202);
  });

  app.get("/connectors/:connectorId/sync-runs", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await connectorSyncOrchestrator.listRuns({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      connectorId: requireRouteParam(c, "connectorId"),
    });
    return ApiResponse.success(c, result);
  });

  app.post("/connectors/:connectorId/actions", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = createConnectorActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(parsed.error.flatten() as Record<string, unknown>);
    }

    const result = await connectorActionRunner.propose({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      connectorId: requireRouteParam(c, "connectorId"),
      actionType: parsed.data.actionType,
      requestJson: parsed.data.requestJson,
      requestPreview: parsed.data.requestPreview,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    return ApiResponse.success(c, result, 201);
  });

  app.post("/connectors/:connectorId/actions/:actionRunId/approve", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await connectorActionRunner.approve({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      connectorId: requireRouteParam(c, "connectorId"),
      actionRunId: requireRouteParam(c, "actionRunId"),
    });
    return ApiResponse.success(c, result);
  });

  app.post("/connectors/:connectorId/actions/:actionRunId/reject", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await connectorActionRunner.reject({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      connectorId: requireRouteParam(c, "connectorId"),
      actionRunId: requireRouteParam(c, "actionRunId"),
    });
    return ApiResponse.success(c, result);
  });

  app.post("/connectors/:connectorId/actions/:actionRunId/execute", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await connectorActionRunner.execute({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      connectorId: requireRouteParam(c, "connectorId"),
      actionRunId: requireRouteParam(c, "actionRunId"),
    });
    return ApiResponse.success(c, result);
  });

  app.get("/connectors/:connectorId/actions", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await connectorActionRunner.list({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      connectorId: requireRouteParam(c, "connectorId"),
    });
    return ApiResponse.success(c, result);
  });
}
