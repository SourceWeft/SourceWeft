import type { Hono } from "hono";
import {
  connectorWebhookConfigResponseSchema,
  createConnectorActionRequestSchema,
  createConnectorRequestSchema,
  deleteConnectorAccountRequestSchema,
  deleteConnectorRequestSchema,
  listConnectorActivityRequestSchema,
  listConnectorsRequestSchema,
  listConnectorOAuthAccountsRequestSchema,
  listWorkspaceConnectorSyncRunsRequestSchema,
  listConnectorWebhookEventsRequestSchema,
  startConnectorOAuthRequestSchema,
  updateConnectorRequestSchema,
} from "@sourceweft/contracts";
import { config } from "../../../shared/config";
import {
  connectorActionRunner,
  connectorOAuthService,
  connectorService,
  connectorSyncOrchestrator,
  connectorWebhookService,
} from "../../../modules/connectors";
import { requireConnectorWorkspace } from "../../../modules/connectors/permissions";
import {
  findSourceConnectorRecord,
  listConnectorActivityRecords,
} from "../../../modules/connectors/repository";
import { enqueueConnectorSyncJob } from "../../../modules/content/queue";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { ensureObjectBody, requireRouteParam } from "./helpers";

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function resolveConnectorWebhookBaseUrl() {
  const configured = process.env.CONNECTOR_WEBHOOK_PUBLIC_BASE_URL?.trim();
  if (configured) {
    return stripTrailingSlash(configured);
  }

  const notionRedirectUri = process.env.NOTION_REDIRECT_URI?.trim();
  if (notionRedirectUri) {
    try {
      return new URL(notionRedirectUri).origin;
    } catch {
      // Fall back to the API base URL; response validation will catch bad values.
    }
  }

  return config.auth.baseUrl;
}

function isPublicHttpsBaseUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      hostname !== "localhost" &&
      hostname !== "127.0.0.1" &&
      hostname !== "::1"
    );
  } catch {
    return false;
  }
}

function buildConnectorWebhookUrl(input: {
  connectorType: string;
  connectorId?: string | null;
}) {
  const url = new URL(
    `/v1/connectors/webhooks/${encodeURIComponent(input.connectorType)}`,
    resolveConnectorWebhookBaseUrl(),
  );
  if (input.connectorId) {
    url.searchParams.set("connectorId", input.connectorId);
  }
  return url.toString();
}

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
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
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
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await connectorService.listAccounts({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      connectorType: parsed.data.connectorType,
    });
    return ApiResponse.success(c, result);
  });

  app.delete("/connectors/accounts/:accountId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const parsed = deleteConnectorAccountRequestSchema.safeParse({});
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await connectorService.deleteOAuthAccount({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      accountId: requireRouteParam(c, "accountId"),
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
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
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

    const parsed = listConnectorsRequestSchema.safeParse({
      includeDisabled:
        c.req.query("includeDisabled") === "true" ? true : undefined,
    });
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await connectorService.listConnectors({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      includeDisabled: parsed.data.includeDisabled,
    });
    return ApiResponse.success(c, result);
  });

  app.get("/connectors/sync-runs", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const parsed = listWorkspaceConnectorSyncRunsRequestSchema.safeParse({
      status: c.req.query("status"),
    });
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await connectorSyncOrchestrator.listWorkspaceRuns({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      status: parsed.data.status,
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
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
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

    const parsed = deleteConnectorRequestSchema.safeParse({
      disable: c.req.query("disable") === "true" ? true : undefined,
    });
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await connectorService.deleteConnector({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      connectorId: requireRouteParam(c, "connectorId"),
      disable: parsed.data.disable,
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

  app.get("/connectors/:connectorId/activity", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const parsed = listConnectorActivityRequestSchema.safeParse({
      kind: c.req.query("kind"),
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      cursor: c.req.query("cursor"),
    });
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const workspaceId = requireRouteParam(c, "workspaceId");
    const connectorId = requireRouteParam(c, "connectorId");
    const { workspace } = await requireConnectorWorkspace({
      workspaceId,
      userId: getSessionUserId(session),
      permission: "connector.read",
    });
    const connector = await findSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId,
    });
    if (!connector || connector.status === "disabled") {
      throw new ApiError(404, "CONNECTOR_NOT_FOUND", "Connector not found");
    }

    const result = await listConnectorActivityRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId,
      kind: parsed.data.kind,
      limit: parsed.data.limit ?? 50,
      cursor: parsed.data.cursor,
    });
    return ApiResponse.success(c, result);
  });

  app.get("/connectors/:connectorId/webhook-config", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const workspaceId = requireRouteParam(c, "workspaceId");
    const connectorId = requireRouteParam(c, "connectorId");
    const { workspace } = await requireConnectorWorkspace({
      workspaceId,
      userId: getSessionUserId(session),
      permission: "connector.read",
    });
    const connector = await findSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId,
    });
    if (!connector) {
      throw new ApiError(404, "CONNECTOR_NOT_FOUND", "Connector not found");
    }

    const webhookBaseUrl = resolveConnectorWebhookBaseUrl();
    const result = {
      webhookUrl: buildConnectorWebhookUrl({
        connectorType: connector.connectorType,
        connectorId: connector.id,
      }),
      baseUrl: webhookBaseUrl,
      connectorId: connector.id,
      connectorType: connector.connectorType,
      isConfigured: isPublicHttpsBaseUrl(webhookBaseUrl),
      setupRequired: true,
    };

    const parsed = connectorWebhookConfigResponseSchema.safeParse(result);
    if (!parsed.success) {
      throw new ApiError(
        500,
        "CONNECTOR_WEBHOOK_CONFIG_INVALID",
        "Connector webhook config is invalid",
      );
    }

    return ApiResponse.success(c, parsed.data);
  });

  app.post("/connectors/:connectorId/actions", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = createConnectorActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
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

  app.post(
    "/connectors/:connectorId/actions/:actionRunId/approve",
    async (c) => {
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
    },
  );

  app.post(
    "/connectors/:connectorId/actions/:actionRunId/reject",
    async (c) => {
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
    },
  );

  app.post(
    "/connectors/:connectorId/actions/:actionRunId/execute",
    async (c) => {
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
    },
  );

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

  app.get("/connectors/webhook-events", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const parsed = listConnectorWebhookEventsRequestSchema.safeParse({
      connectorType: c.req.query("connectorType"),
      connectorId: c.req.query("connectorId"),
    });
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await connectorWebhookService.list({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      connectorType: parsed.data.connectorType,
      connectorId: parsed.data.connectorId,
    });
    return ApiResponse.success(c, result);
  });

}
