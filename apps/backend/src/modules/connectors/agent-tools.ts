import { tool } from "langchain";
import type { ToolRuntime } from "@langchain/core/tools";
import {
  connectorActionRunner,
  connectorOAuthService,
  connectorRegistry,
} from ".";
import { listSourceConnectorRecords } from "./repository";
import type {
  ConnectorActionRunRecord,
  ConnectorActionSpec,
  ConnectorManifest,
  SourceConnectorRecord,
} from "./types";
import {
  chooseConnector,
  connectorActionApprovalPayload,
} from "./agent-tool-payload";
import { connectorToolResult } from "./agent-tool-errors";
import {
  resolveConnectorActionExecutionRef,
  resolveConnectorActionToolIdempotencyKey,
  type ConnectorActionApprovalCursor,
  type ConnectorActionExecutionCursor,
} from "./agent-tool-idempotency";
import type { ToolConfirmationRequest } from "@sourceweft/contracts";

type ConnectorActionToolContext = {
  actionApprovalCursor?: ConnectorActionApprovalCursor;
  actionExecutionCursor?: ConnectorActionExecutionCursor;
  actionApprovalScope?: string;
  teamId: string;
  workspaceId: string;
  userId: string;
};

type JsonSchemaObject = {
  additionalProperties?: unknown;
  properties?: unknown;
  required?: unknown;
  type?: unknown;
};

type ConnectorActionToolRuntime = ToolRuntime<unknown, Record<string, never>>;
type ToolApprovalDecision = "approve" | "edit" | "reject";

function jsonSchemaWithConnectorId(schema: Record<string, unknown>) {
  const objectSchema = schema as JsonSchemaObject;
  const properties =
    objectSchema.properties &&
    typeof objectSchema.properties === "object" &&
    !Array.isArray(objectSchema.properties)
      ? (objectSchema.properties as Record<string, unknown>)
      : {};
  return {
    ...schema,
    type: "object" as const,
    additionalProperties:
      typeof schema.additionalProperties === "boolean"
        ? schema.additionalProperties
        : true,
    properties: {
      ...properties,
      connectorId: {
        type: "string",
        description:
          "Optional active SourceWeft connector id to use when multiple connectors of this type exist.",
      },
    },
  };
}

function actionDescription(input: {
  action: ConnectorActionSpec;
  manifest: ConnectorManifest;
}) {
  const base = input.action.description ?? input.action.displayName;
  const approval = input.action.requiresApproval
    ? " This action requires user approval before execution."
    : "";
  return `${base} Connector: ${input.manifest.displayName}.${approval}`;
}

function activeConnectorsByType(connectors: SourceConnectorRecord[]) {
  const byType = new Map<string, SourceConnectorRecord[]>();
  for (const connector of connectors) {
    if (connector.status !== "active") {
      continue;
    }
    const current = byType.get(connector.connectorType) ?? [];
    current.push(connector);
    byType.set(connector.connectorType, current);
  }
  return byType;
}

function resolveToolCallId(runtime: ConnectorActionToolRuntime) {
  return runtime.toolCall?.id ?? null;
}

function connectorActionIdempotencyKey(input: {
  context: ConnectorActionToolContext;
  fallback?: string | null;
  toolName: string;
}) {
  return resolveConnectorActionToolIdempotencyKey(input.context, {
    fallback: input.fallback ?? undefined,
    toolName: input.toolName,
  });
}

function connectorActionExecutionRef(input: {
  connectorId?: string;
  context: ConnectorActionToolContext;
  toolName: string;
}) {
  return resolveConnectorActionExecutionRef(input.context, {
    connectorId: input.connectorId,
    toolName: input.toolName,
  });
}

function connectorActionToolOutput(input: {
  action: ConnectorActionRunRecord;
}) {
  if (input.action.status === "succeeded") {
    return input.action.resultJson ?? {
      ok: true,
      actionType: input.action.actionType,
    };
  }
  return {
    type: "connector_tool_error" as const,
    code: input.action.errorCode ?? "CONNECTOR_ACTION_FAILED",
    message: input.action.errorMessage ?? "Connector action failed.",
    statusCode: 400,
  };
}

function findAgentAction(input: {
  excludeConnectorTypes?: readonly string[];
  toolName: string;
}) {
  const excluded = new Set(input.excludeConnectorTypes ?? []);
  for (const manifest of connectorRegistry.listManifests()) {
    if (excluded.has(manifest.type)) {
      continue;
    }
    const action = manifest.actions.find(
      (candidate) =>
        candidate.visibility === "agent" &&
        candidate.agentToolName === input.toolName,
    );
    if (action) {
      return { action, manifest };
    }
  }
  return null;
}

function isDestructiveAction(action: ConnectorActionSpec) {
  if (action.riskLevel === "high") {
    return true;
  }
  if (
    action.capabilities?.some((capability) =>
      [
        "connector_delete",
        "connector_archive",
        "connector_move",
      ].includes(capability),
    )
  ) {
    return true;
  }
  return /\b(delete|trash|archive|move|remove)\b/i.test(
    `${action.type} ${action.agentToolName ?? ""} ${action.displayName}`,
  );
}

export function createConnectorActionInterruptConfigs(
  options: { excludeConnectorTypes?: readonly string[] } = {},
) {
  const excluded = new Set(options.excludeConnectorTypes ?? []);
  const configs: Record<
    string,
    {
      allowedDecisions: ToolApprovalDecision[];
      description: string;
      argsSchema?: Record<string, unknown>;
    }
  > = {};

  for (const manifest of connectorRegistry.listManifests()) {
    if (excluded.has(manifest.type)) {
      continue;
    }
    for (const action of manifest.actions) {
      if (
        action.visibility !== "agent" ||
        !action.agentToolName ||
        !action.requiresApproval
      ) {
        continue;
      }
      configs[action.agentToolName] = {
        allowedDecisions: isDestructiveAction(action)
          ? ["approve", "reject"]
          : ["approve", "edit", "reject"],
        description: `Review ${manifest.displayName} action before execution: ${action.displayName}`,
        argsSchema: jsonSchemaWithConnectorId(action.inputSchema),
      };
    }
  }

  return configs;
}

export async function createConnectorActionApprovalRequest(
  context: ConnectorActionToolContext,
  input: {
    args: Record<string, unknown>;
    excludeConnectorTypes?: readonly string[];
    toolCallId: string;
    toolName: string;
  },
): Promise<ToolConfirmationRequest | null> {
  const match = findAgentAction({
    excludeConnectorTypes: input.excludeConnectorTypes,
    toolName: input.toolName,
  });
  if (!match || !match.action.requiresApproval) {
    return null;
  }
  const connectors = await listSourceConnectorRecords({
    teamId: context.teamId,
    workspaceId: context.workspaceId,
  });
  const activeConnectors =
    activeConnectorsByType(connectors).get(match.manifest.type) ?? [];
  if (activeConnectors.length === 0) {
    return null;
  }
  const connectorId =
    typeof input.args.connectorId === "string"
      ? input.args.connectorId
      : undefined;
  const connector = chooseConnector({
    connectorId,
    connectorType: match.manifest.type,
    connectors: activeConnectors,
  });
  const { connectorId: _connectorId, ...requestJson } = input.args;
  const result = await connectorActionRunner.propose({
    workspaceId: context.workspaceId,
    userId: context.userId,
    connectorId: connector.id,
    actionType: match.action.type,
    agentToolName: match.action.agentToolName,
    requestJson,
    idempotencyKey: connectorActionIdempotencyKey({
      context,
      fallback: input.toolCallId,
      toolName: input.toolName,
    }),
  });
  return connectorActionApprovalPayload({
    action: result.action,
    agentToolName: match.action.agentToolName,
    connector,
  });
}

export async function createConnectorActionTools(
  context: ConnectorActionToolContext,
  options: { excludeConnectorTypes?: readonly string[] } = {},
) {
  const excluded = new Set(options.excludeConnectorTypes ?? []);
  const connectors = await listSourceConnectorRecords({
    teamId: context.teamId,
    workspaceId: context.workspaceId,
  });
  const connectorsByType = activeConnectorsByType(connectors);
  const tools = [];

  for (const manifest of connectorRegistry.listManifests()) {
    if (excluded.has(manifest.type)) {
      continue;
    }
    const activeConnectors = connectorsByType.get(manifest.type) ?? [];
    if (activeConnectors.length === 0) {
      continue;
    }
    for (const action of manifest.actions) {
      if (action.visibility !== "agent" || !action.agentToolName) {
        continue;
      }
      const agentToolName = action.agentToolName;
      tools.push(
        tool(
          async (
            rawArgs: Record<string, unknown>,
            runtime: ConnectorActionToolRuntime,
          ) =>
            connectorToolResult(
              async () => {
                const connectorId =
                  typeof rawArgs.connectorId === "string"
                    ? rawArgs.connectorId
                    : undefined;
                if (action.requiresApproval) {
                  const executionRef = connectorActionExecutionRef({
                    context,
                    connectorId,
                    toolName: agentToolName,
                  });
                  if (executionRef) {
                    const executed = await connectorActionRunner.execute({
                      workspaceId: context.workspaceId,
                      userId: context.userId,
                      connectorId: executionRef.connectorId,
                      actionRunId: executionRef.actionRunId,
                    });
                    return connectorActionToolOutput({
                      action: executed.action,
                    });
                  }
                }
                const connector = chooseConnector({
                  connectorId,
                  connectorType: manifest.type,
                  connectors: activeConnectors,
                });
                const { connectorId: _connectorId, ...requestJson } = rawArgs;
                if (action.requiresApproval) {
                  const result = await connectorActionRunner.propose({
                    workspaceId: context.workspaceId,
                    userId: context.userId,
                    connectorId: connector.id,
                    actionType: action.type,
                    agentToolName: action.agentToolName,
                    requestJson,
                    idempotencyKey: connectorActionIdempotencyKey({
                      context,
                      fallback: resolveToolCallId(runtime),
                      toolName: agentToolName,
                    }),
                  });
                  const executed = await connectorActionRunner.execute({
                    workspaceId: context.workspaceId,
                    userId: context.userId,
                    connectorId: connector.id,
                    actionRunId: result.action.id,
                  });
                  return connectorActionToolOutput({
                    action: executed.action,
                  });
                }

                const accessToken = await connectorOAuthService.getRuntimeToken({
                  teamId: context.teamId,
                  workspaceId: context.workspaceId,
                  accountId: connector.oauthAccountId,
                  connectorType: connector.connectorType,
                });
                const adapter = connectorRegistry.getAdapter(
                  connector.connectorType,
                );
                const result = await adapter.executeAction({
                  teamId: context.teamId,
                  workspaceId: context.workspaceId,
                  connectorId: connector.id,
                  connectorType: connector.connectorType,
                  actionType: action.type,
                  request: requestJson,
                  config: connector.configJson,
                  accessToken,
                  idempotencyKey: `connector-read:${connector.id}:${action.type}:${Date.now()}`,
                });
                return result.result;
              },
              {
                connectorType: manifest.type,
                toolName: agentToolName,
              },
            ),
          {
            name: agentToolName,
            description: actionDescription({ action, manifest }),
            schema: jsonSchemaWithConnectorId(action.inputSchema),
          },
        ),
      );
    }
  }

  return tools;
}
