import { createPublicKey, verify } from "node:crypto";
import {
  marketMcpManifestSchema,
  type McpAuthType,
  type McpRiskLevel,
  type MarketMcpManifest,
} from "@sourceweft/market-sdk";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { InterruptOnConfig } from "langchain";
import type { ToolConfirmationRequest } from "@sourceweft/contracts";
import { config } from "../../shared/config";
import { decryptSecret, encryptSecret } from "../../shared/secrets";
import { McpError } from "./errors";
import { createLangChainMcpClient } from "./langchain-client";
import { marketService } from "./market-service";
import { requireMcpWorkspace } from "./permissions";
import {
  createMcpActionRun,
  createMcpToolRun,
  createOrUpdateMarketMcpInstall,
  findMcpActionRun,
  findWorkspaceMcpCredential,
  findWorkspaceMcpInstall,
  findWorkspaceMcpInstallByMarketIdentifier,
  listWorkspaceMcpInstalls,
  setWorkspaceMcpToolsEnabled,
  updateMcpActionRun,
  updateMcpToolRun,
  updateWorkspaceMcpInstall,
  upsertWorkspaceMcpCredential,
  upsertWorkspaceMcpTools,
} from "./repository";
import {
  assertSafeMcpEndpoint,
  canonicalJson,
  hashJson,
  normalizedMcpToolName,
  redactMcpSecrets,
  sanitizeHeaderName,
  sanitizeHeaders,
} from "./security";
import type {
  McpActionRunRecord,
  WorkspaceMcpInstallRecord,
  WorkspaceMcpToolRecord,
} from "./types";

function isDevelopment() {
  return process.env.NODE_ENV !== "production";
}

function encryptionSecret() {
  return config.modelGatewayEncryptionSecret;
}

function assertWebTransport(manifest: MarketMcpManifest) {
  if (manifest.transport === "stdio") {
    return;
  }
  if (!manifest.endpointUrl) {
    throw new McpError(
      400,
      "MCP_ENDPOINT_REQUIRED",
      "HTTP/SSE MCP manifest must include endpointUrl",
    );
  }
  assertSafeMcpEndpoint(manifest.endpointUrl, {
    allowLocalhost: isDevelopment(),
  });
}

function decodeBase64(value: string) {
  try {
    return Buffer.from(value, "base64");
  } catch {
    throw new McpError(
      422,
      "MCP_MARKET_SIGNATURE_INVALID",
      "MCP market signature or public key is not valid base64",
    );
  }
}

function parseTrustedPublicKey(value: string) {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  return {
    keyId: value.slice(0, separatorIndex),
    publicKey: value.slice(separatorIndex + 1),
  };
}

function createEd25519PublicKey(value: string) {
  const bytes = decodeBase64(value);
  const der =
    bytes.length === 32
      ? Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          bytes,
        ])
      : bytes;
  try {
    return createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new McpError(
      422,
      "MCP_MARKET_PUBLIC_KEY_INVALID",
      "MCP market signing public key is invalid",
    );
  }
}

function verifyMarketManifestSignature(input: {
  manifest: MarketMcpManifest;
  signature?: string | null;
  signingKeyId?: string | null;
}) {
  if (config.market.trustedPublicKeys.length > 0) {
    if (!input.signature || !input.signingKeyId) {
      throw new McpError(
        422,
        "MCP_MARKET_SIGNATURE_REQUIRED",
        "MCP manifests must include a signature and signing key id when trusted market keys are configured",
      );
    }
    const key = config.market.trustedPublicKeys
      .map(parseTrustedPublicKey)
      .find((candidate) => candidate?.keyId === input.signingKeyId);
    if (!key) {
      throw new McpError(
        422,
        "MCP_MARKET_SIGNING_KEY_UNTRUSTED",
        "MCP manifest signing key is not trusted by this SourceWeft deployment",
      );
    }
    const valid = verify(
      null,
      Buffer.from(canonicalJson(input.manifest)),
      createEd25519PublicKey(key.publicKey),
      decodeBase64(input.signature),
    );
    if (!valid) {
      throw new McpError(
        422,
        "MCP_MARKET_SIGNATURE_INVALID",
        "MCP manifest signature is invalid",
      );
    }
  }
  return {
    verified: input.manifest.verified,
    signingKeyId: input.signingKeyId ?? null,
    manifestHash: hashJson(input.manifest),
  };
}

function credentialStatusFor(authType: McpAuthType) {
  return authType === "none" ? "not_required" : "configured";
}

function headersFromCredential(input: {
  authType: McpAuthType;
  encryptedSecret?: string | null;
  encryptedHeaders?: string | null;
  headerName?: string | null;
}) {
  if (input.authType === "none") {
    return {};
  }
  if (input.authType === "custom_headers") {
    const decrypted = decryptSecret(input.encryptedHeaders ?? "", encryptionSecret());
    return decrypted ? (JSON.parse(decrypted) as Record<string, string>) : {};
  }
  const secret = decryptSecret(input.encryptedSecret ?? "", encryptionSecret());
  if (input.authType === "bearer") {
    return secret ? { Authorization: `Bearer ${secret}` } : {};
  }
  const headerName = input.headerName ? sanitizeHeaderName(input.headerName) : "";
  return headerName && secret ? { [headerName]: secret } : {};
}

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isHighRisk(risk: McpRiskLevel) {
  return risk === "write" || risk === "destructive" || risk === "unknown";
}

function connectorRiskFromMcpRisk(risk: McpRiskLevel) {
  return risk === "read" ? "low" : "high";
}

function mcpRiskLabel(risk: McpRiskLevel) {
  if (risk === "destructive") {
    return "Destructive";
  }
  if (risk === "write") {
    return "Write";
  }
  if (risk === "read") {
    return "Read";
  }
  return "Unknown";
}

function buildMcpRequestPreview(input: {
  install: WorkspaceMcpInstallRecord;
  tool: WorkspaceMcpToolRecord;
  args: Record<string, unknown>;
}) {
  const keys = Object.keys(input.args);
  const argSummary =
    keys.length > 0 ? ` with ${keys.slice(0, 4).join(", ")}` : "";
  return `${mcpRiskLabel(input.tool.risk)} MCP call: ${input.install.name}.${input.tool.serverToolName}${argSummary}`;
}

function mcpConfirmationPayload(input: {
  action: McpActionRunRecord;
  install: WorkspaceMcpInstallRecord;
  tool: WorkspaceMcpToolRecord;
}): ToolConfirmationRequest {
  const providerStatus =
    input.action.status === "running"
      ? "running"
      : input.action.status === "succeeded"
        ? "succeeded"
        : input.action.status === "failed"
          ? "failed"
          : "not_executed";
  return {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: input.action.id,
    domain: "mcp",
    subject: {
      label: input.install.name,
      provider: "mcp",
      externalUri: input.install.endpointUrl,
    },
    action: {
      type: input.tool.serverToolName,
      toolName: input.tool.normalizedToolName,
      label: input.tool.title ?? input.tool.serverToolName,
      riskLevel: connectorRiskFromMcpRisk(input.action.risk),
      status: input.action.status,
      requiresApproval: true,
    },
    preview: {
      title: input.action.requestPreview,
      summary:
        input.tool.description ??
        `Review this ${input.action.risk} MCP tool call before execution.`,
      requestJson: input.action.requestJson,
      target: {
        type: "mcp_server",
        label: input.install.name,
        id: input.install.id,
        externalUri: input.install.endpointUrl,
      },
    },
    editableArgs: {
      value: input.action.requestJson,
      schema: input.tool.inputSchema,
    },
    decisionOptions: [
      {
        decision: "reject",
        label: "Reject",
        description: "Do not run this MCP tool call.",
      },
      {
        decision: "approve",
        label: "Approve",
        description: "Run this MCP tool call once.",
      },
    ],
    execution: {
      providerStatus,
      executor: {
        kind: "mcp_action_run",
        actionRunId: input.action.id,
      },
    },
    status: input.action.status,
    userMessage:
      providerStatus === "succeeded"
        ? "This MCP tool call finished successfully in SourceWeft."
        : "This MCP tool call is waiting for confirmation in SourceWeft. The remote MCP server has not been called yet.",
  };
}

function getToolCallIdFromConfig(configValue: unknown) {
  const config = toObject(configValue);
  const toolCall = toObject(config.toolCall);
  if (typeof toolCall.id === "string" && toolCall.id.length > 0) {
    return toolCall.id;
  }
  const configurable = toObject(config.configurable);
  if (
    typeof configurable.tool_call_id === "string" &&
    configurable.tool_call_id.length > 0
  ) {
    return configurable.tool_call_id;
  }
  return null;
}

function truncateText(value: string, limit = 12_000) {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit).trimEnd()}\n\nOutput truncated for MCP audit.`;
}

function normalizeMcpOutputForAudit(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return { content: truncateText(value) };
  }
  if (Array.isArray(value)) {
    return { items: value.slice(0, 50) };
  }
  return toObject(value);
}

export class McpService {
  async listMarketMcp(input: {
    workspaceId: string;
    userId: string;
    query?: string;
    category?: string;
    includeDesktopOnly?: boolean;
  }) {
    const { workspace } = await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.read",
    });
    const [market, installs] = await Promise.all([
      marketService.listMcp({
        query: input.query,
        category: input.category,
        includeDesktopOnly: input.includeDesktopOnly,
      }),
      listWorkspaceMcpInstalls({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
      }),
    ]);
    const installsByIdentifier = new Map(
      installs
        .filter((install) => install.marketIdentifier)
        .map((install) => [install.marketIdentifier, install]),
    );
    return {
      items: market.items.map((item) => ({
        market: item,
        install: installsByIdentifier.get(item.identifier) ?? null,
      })),
    };
  }

  async getMarketMcp(input: {
    workspaceId: string;
    userId: string;
    identifier: string;
  }) {
    const { workspace } = await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.read",
    });
    const [market, install] = await Promise.all([
      marketService.getMcp(input.identifier),
      findWorkspaceMcpInstallByMarketIdentifier({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        marketIdentifier: input.identifier,
      }),
    ]);
    return { market, install };
  }

  async listInstalls(input: { workspaceId: string; userId: string }) {
    const { workspace } = await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.read",
    });
    return {
      items: await listWorkspaceMcpInstalls({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
      }),
    };
  }

  async installMarketMcp(input: {
    workspaceId: string;
    userId: string;
    identifier: string;
    version?: string;
    endpointUrlOverride?: string;
  }) {
    const { workspace } = await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.manage",
    });
    const response = await marketService.getMcpManifest(input.identifier, {
      version: input.version,
    });
    const parsed = marketMcpManifestSchema.safeParse({
      ...response.manifest,
      ...(input.endpointUrlOverride
        ? { endpointUrl: input.endpointUrlOverride }
        : {}),
    });
    if (!parsed.success) {
      throw new McpError(
        422,
        "MCP_MARKET_MANIFEST_INVALID",
        "Market MCP manifest is invalid",
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    assertWebTransport(parsed.data);
    verifyMarketManifestSignature({
      manifest: parsed.data,
      signature: response.signature,
      signingKeyId: response.signingKeyId,
    });

    const install = await createOrUpdateMarketMcpInstall({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      manifest: parsed.data,
      signature: response.signature,
      signingKeyId: response.signingKeyId,
    });
    if (!install) {
      throw new McpError(500, "MCP_INSTALL_FAILED", "Failed to install MCP");
    }

    return { install };
  }

  async updateInstall(input: {
    workspaceId: string;
    userId: string;
    installId: string;
    enabled?: boolean;
    toolIds?: string[];
  }) {
    const { workspace } = await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.manage",
    });
    if (input.toolIds) {
      await setWorkspaceMcpToolsEnabled({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        installId: input.installId,
        toolIds: input.toolIds,
      });
    }
    const install = await updateWorkspaceMcpInstall({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      installId: input.installId,
      ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
    });
    if (!install) {
      throw new McpError(404, "MCP_INSTALL_NOT_FOUND", "MCP install not found");
    }
    return { install };
  }

  async upsertCredentials(input: {
    workspaceId: string;
    userId: string;
    installId: string;
    authType: McpAuthType;
    bearerToken?: string;
    apiKeyHeaderName?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  }) {
    const { workspace } = await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.manage",
    });
    const install = await findWorkspaceMcpInstall({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      installId: input.installId,
    });
    if (!install) {
      throw new McpError(404, "MCP_INSTALL_NOT_FOUND", "MCP install not found");
    }

    let encryptedSecret: string | null = null;
    let encryptedHeaders: string | null = null;
    let headerName: string | null = null;
    if (input.authType === "bearer") {
      if (!input.bearerToken) {
        throw new McpError(400, "MCP_CREDENTIAL_REQUIRED", "Bearer token is required");
      }
      encryptedSecret = encryptSecret(input.bearerToken, encryptionSecret());
    } else if (input.authType === "api_key_header") {
      if (!input.apiKeyHeaderName || !input.apiKey) {
        throw new McpError(400, "MCP_CREDENTIAL_REQUIRED", "API key header and value are required");
      }
      headerName = sanitizeHeaderName(input.apiKeyHeaderName);
      encryptedSecret = encryptSecret(input.apiKey, encryptionSecret());
    } else if (input.authType === "custom_headers") {
      const headers = sanitizeHeaders(input.headers ?? {});
      encryptedHeaders = encryptSecret(JSON.stringify(headers), encryptionSecret());
    }

    await upsertWorkspaceMcpCredential({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      installId: input.installId,
      authType: input.authType,
      encryptedSecret,
      encryptedHeaders,
      headerName,
      configuredBy: input.userId,
    });
    const updated = await updateWorkspaceMcpInstall({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      installId: input.installId,
      credentialStatus: credentialStatusFor(input.authType),
    });
    if (!updated) {
      throw new McpError(404, "MCP_INSTALL_NOT_FOUND", "MCP install not found");
    }
    return { install: updated };
  }

  async testInstall(input: {
    workspaceId: string;
    userId: string;
    installId: string;
  }) {
    const { workspace } = await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.manage",
    });
    const install = await findWorkspaceMcpInstall({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      installId: input.installId,
    });
    if (!install) {
      throw new McpError(404, "MCP_INSTALL_NOT_FOUND", "MCP install not found");
    }
    if (install.transport === "stdio" || install.desktopOnly || !install.webExecutable) {
      throw new McpError(
        400,
        "MCP_DESKTOP_ONLY",
        "This MCP can only run from SourceWeft Desktop",
      );
    }
    if (!install.endpointUrl) {
      throw new McpError(400, "MCP_ENDPOINT_REQUIRED", "MCP endpoint is required");
    }
    assertSafeMcpEndpoint(install.endpointUrl, { allowLocalhost: isDevelopment() });

    const credential = await findWorkspaceMcpCredential({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      installId: input.installId,
    });
    const headers = credential ? headersFromCredential(credential) : {};
    const client = createLangChainMcpClient({ install, headers });
    try {
      const tools = await client.getTools();
      await upsertWorkspaceMcpTools({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        installId: install.id,
        serverSlug: install.marketIdentifier ?? install.id,
        tools: tools.map((tool) => ({
          name: tool.name.replace(/^mcp__[^_]+__/, ""),
          title: tool.name,
          description: tool.description,
          inputSchema: {},
          annotations: {},
          risk: "unknown",
        })),
      });
      const updated = await updateWorkspaceMcpInstall({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        installId: install.id,
        status: "active",
        lastTestedAt: new Date(),
        lastError: null,
      });
      return {
        install: updated ?? install,
        toolCount: tools.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateWorkspaceMcpInstall({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        installId: install.id,
        status: "error",
        lastTestedAt: new Date(),
        lastError: message,
      });
      throw new McpError(502, "MCP_CONNECTION_FAILED", message);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async buildLangChainToolsForTurn(input: {
    workspaceId: string;
    userId: string;
    threadId?: string | null;
    runId?: string | null;
    installIds: string[];
    toolIds?: string[];
  }) {
    const { workspace } = await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.execute",
    });
    const installs = await listWorkspaceMcpInstalls({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });
    const selected = installs.filter(
      (install) =>
        input.installIds.includes(install.id) &&
        install.enabled &&
        install.status === "active" &&
        install.transport !== "stdio" &&
        !install.desktopOnly &&
        install.webExecutable,
    );
    const clients: Array<{ close: () => Promise<void> }> = [];
    const tools: DynamicStructuredTool[] = [];
    const interruptOn: Record<string, InterruptOnConfig> = {};
    for (const install of selected) {
      const credential = await findWorkspaceMcpCredential({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        installId: install.id,
      });
      const headers = credential ? headersFromCredential(credential) : {};
      const client = createLangChainMcpClient({ install, headers });
      clients.push(client);
      const installTools = await client.getTools();
      for (const tool of installTools) {
        const knownTool = install.tools.find(
          (candidate) =>
            candidate.normalizedToolName === tool.name ||
            normalizedMcpToolName({
              serverSlug: install.marketIdentifier ?? install.id,
              toolName: candidate.serverToolName,
            }) === tool.name,
        );
        if (input.toolIds?.length && (!knownTool || !input.toolIds.includes(knownTool.id))) {
          continue;
        }
        if (knownTool && isHighRisk(knownTool.risk)) {
          interruptOn[tool.name] = {
            allowedDecisions: ["approve", "edit", "reject"],
            description: `${install.name} MCP tool ${knownTool.serverToolName} may perform external ${knownTool.risk} actions. Review before execution.`,
            argsSchema: knownTool.inputSchema,
          };
        }
        tools.push(
          this.wrapLangChainMcpTool({
            install,
            originalTool: tool,
            tool: knownTool,
            teamId: workspace.organizationId,
            workspaceId: workspace.id,
            userId: input.userId,
            threadId: input.threadId ?? null,
            runId: input.runId ?? null,
          }),
        );
      }
    }
    return {
      tools,
      interruptOn,
      close: async () => {
        await Promise.allSettled(clients.map((client) => client.close()));
      },
    };
  }

  private wrapLangChainMcpTool(input: {
    install: WorkspaceMcpInstallRecord;
    originalTool: DynamicStructuredTool;
    tool?: WorkspaceMcpToolRecord;
    teamId: string;
    workspaceId: string;
    userId: string;
    threadId: string | null;
    runId: string | null;
  }) {
    const toolRecord =
      input.tool ??
      ({
        id: null,
        serverToolName: input.originalTool.name,
        normalizedToolName: input.originalTool.name,
        title: input.originalTool.name,
        description: input.originalTool.description,
        inputSchema: {},
        risk: "unknown",
      } as const);
    const risk = toolRecord.risk;
    return new DynamicStructuredTool({
      name: input.originalTool.name,
      description: input.originalTool.description,
      schema: input.originalTool.schema,
      func: async (args, _runManager, configValue) => {
        const requestJson = redactMcpSecrets(toObject(args)) as Record<
          string,
          unknown
        >;
        const toolCallId = getToolCallIdFromConfig(configValue);
        const actionRun = await createMcpActionRun({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          installId: input.install.id,
          toolId: input.tool?.id ?? null,
          serverToolName: toolRecord.serverToolName,
          normalizedToolName: toolRecord.normalizedToolName,
          risk,
          status: isHighRisk(risk) ? "proposed" : "running",
          requestJson,
          requestPreview: buildMcpRequestPreview({
            install: input.install,
            tool: toolRecord as WorkspaceMcpToolRecord,
            args: requestJson,
          }),
          idempotencyKey:
            toolCallId ??
            `${input.runId ?? input.threadId ?? input.workspaceId}:${input.originalTool.name}:${hashJson(requestJson)}`,
        });
        if (isHighRisk(risk) && actionRun.status !== "approved") {
          throw new McpError(
            409,
            "MCP_APPROVAL_REQUIRED",
            "This MCP tool call requires approval before execution.",
          );
        }
        const toolRun = await createMcpToolRun({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          runId: input.runId,
          toolCallId,
          installId: input.install.id,
          toolId: input.tool?.id ?? null,
          actionRunId: actionRun.id,
          serverToolName: toolRecord.serverToolName,
          normalizedToolName: toolRecord.normalizedToolName,
          risk,
          status: "running",
          redactedInput: requestJson,
          createdBy: input.userId,
        });
        const startedAt = Date.now();
        await updateMcpActionRun({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          actionRunId: actionRun.id,
          status: "running",
          executedBy: input.userId,
        });
        try {
          const output = await input.originalTool.invoke(args, configValue);
          const redactedOutput = redactMcpSecrets(
            normalizeMcpOutputForAudit(output),
          ) as Record<string, unknown>;
          const latencyMs = Date.now() - startedAt;
          await Promise.all([
            updateMcpToolRun({
              teamId: input.teamId,
              workspaceId: input.workspaceId,
              toolRunId: toolRun.id,
              status: "succeeded",
              redactedOutput,
              latencyMs,
            }),
            updateMcpActionRun({
              teamId: input.teamId,
              workspaceId: input.workspaceId,
              actionRunId: actionRun.id,
              status: "succeeded",
              resultJson: redactedOutput,
              executedBy: input.userId,
            }),
          ]);
          return output;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const latencyMs = Date.now() - startedAt;
          await Promise.all([
            updateMcpToolRun({
              teamId: input.teamId,
              workspaceId: input.workspaceId,
              toolRunId: toolRun.id,
              status: "failed",
              redactedOutput: {},
              latencyMs,
              errorCode: "MCP_TOOL_CALL_FAILED",
              errorMessage: message,
            }),
            updateMcpActionRun({
              teamId: input.teamId,
              workspaceId: input.workspaceId,
              actionRunId: actionRun.id,
              status: "failed",
              errorCode: "MCP_TOOL_CALL_FAILED",
              errorMessage: message,
              executedBy: input.userId,
            }),
          ]);
          throw error;
        }
      },
    });
  }

  async createApprovalForInterruptedTool(input: {
    workspaceId: string;
    userId: string;
    toolName: string;
    args: Record<string, unknown>;
    toolCallId: string;
  }) {
    const { workspace } = await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.execute",
    });
    const installs = await listWorkspaceMcpInstalls({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });
    const install = installs.find((candidate) =>
      candidate.tools.some((tool) => tool.normalizedToolName === input.toolName),
    );
    const tool = install?.tools.find(
      (candidate) => candidate.normalizedToolName === input.toolName,
    );
    if (!install || !tool) {
      return null;
    }
    const requestJson = redactMcpSecrets(input.args) as Record<string, unknown>;
    const action = await createMcpActionRun({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      installId: install.id,
      toolId: tool.id,
      serverToolName: tool.serverToolName,
      normalizedToolName: tool.normalizedToolName,
      risk: tool.risk,
      status: "proposed",
      requestJson,
      requestPreview: buildMcpRequestPreview({ install, tool, args: requestJson }),
      idempotencyKey: input.toolCallId,
    });
    return mcpConfirmationPayload({ action, install, tool });
  }

  async respondToApproval(input: {
    workspaceId: string;
    userId: string;
    confirmationId: string;
    confirmation?: ToolConfirmationRequest;
    decision: "approve" | "reject";
    editedArgs?: Record<string, unknown>;
    note?: string;
  }) {
    const { workspace } = await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.execute",
    });
    const action = await findMcpActionRun({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      actionRunId: input.confirmationId,
    });
    if (!action) {
      throw new McpError(404, "MCP_CONFIRMATION_NOT_FOUND", "MCP confirmation request not found");
    }
    const install = await findWorkspaceMcpInstall({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      installId: action.installId,
    });
    const tool = install?.tools.find(
      (candidate) => candidate.id === action.toolId,
    );
    if (!install || !tool) {
      throw new McpError(404, "MCP_TOOL_NOT_FOUND", "MCP tool not found");
    }
    if (input.decision === "reject") {
      const rejected =
        (await updateMcpActionRun({
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          actionRunId: action.id,
          status: "rejected",
          approvedBy: input.userId,
          errorMessage: input.note ?? null,
        })) ?? action;
      return {
        confirmation: mcpConfirmationPayload({ action: rejected, install, tool }),
        resume: {
          decisions: [
            {
              type: "reject" as const,
              message: input.note ?? "User rejected the MCP action in SourceWeft.",
            },
          ],
        },
      };
    }
    const approved =
      (await updateMcpActionRun({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        actionRunId: action.id,
        status: "approved",
        requestJson: action.requestJson,
        requestPreview: buildMcpRequestPreview({
          install,
          tool,
          args: action.requestJson,
        }),
        approvedBy: input.userId,
      })) ?? action;
    return {
      confirmation: mcpConfirmationPayload({ action: approved, install, tool }),
      resume: {
        decisions: [{ type: "approve" as const }],
      },
    };
  }
}

export const mcpService = new McpService();
