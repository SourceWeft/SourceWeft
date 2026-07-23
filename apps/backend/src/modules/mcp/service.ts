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
import { verifyMarketManifestSignature } from "./market-signature";
import { marketService } from "./market-service";
import { requireMcpWorkspace } from "./permissions";
import {
  createMcpActionRun,
  createMcpToolRun,
  createOrUpdateMarketMcpInstall,
  deleteWorkspaceMcpInstall,
  findMcpActionRun,
  findWorkspaceMcpCredential,
  findWorkspaceMcpInstall,
  findWorkspaceMcpInstallByMarketIdentifier,
  listMcpActionRuns,
  listMcpToolRuns,
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
  return process.env.NODE_ENV === "development";
}

function encryptionSecret() {
  return config.modelGatewayEncryptionSecret;
}

async function assertWebTransport(manifest: MarketMcpManifest) {
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
  await assertSafeMcpEndpoint(manifest.endpointUrl, {
    allowLocalhost: isDevelopment(),
  });
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

export function stripLangChainMcpToolPrefix(input: {
  serverKey: string;
  toolName: string;
}) {
  const prefix = `mcp__${input.serverKey}__`;
  return input.toolName.startsWith(prefix)
    ? input.toolName.slice(prefix.length)
    : input.toolName;
}

/**
 * Resolve the stored tool record for a LangChain tool name. LangChain names a
 * tool `mcp__<serverKey>__<rawServerToolName>`; the reliable join key is the raw
 * server tool name, which we also persist as `serverToolName`. Matching on the
 * lossy `normalizedToolName` (lowercased/slugified) fails for camelCase or
 * otherwise non-slug-safe names, so it is only a fallback for manifest-sourced
 * tools. Using one helper everywhere keeps discovery and approval in agreement.
 */
function findInstallToolByLangChainName(
  install: WorkspaceMcpInstallRecord,
  langChainToolName: string,
) {
  const rawName = stripLangChainMcpToolPrefix({
    serverKey: install.marketIdentifier ?? install.id,
    toolName: langChainToolName,
  });
  return (
    install.tools.find((candidate) => candidate.serverToolName === rawName) ??
    install.tools.find(
      (candidate) => candidate.normalizedToolName === langChainToolName,
    ) ??
    install.tools.find(
      (candidate) =>
        normalizedMcpToolName({
          serverSlug: install.marketIdentifier ?? install.id,
          toolName: candidate.serverToolName,
        }) === langChainToolName,
    )
  );
}

/**
 * Compare two dotted-numeric version strings. Returns <0 if a<b, >0 if a>b, and
 * 0 when equal OR when either side isn't cleanly comparable (so non-semver tags
 * never trigger a false downgrade block).
 */
function compareDottedVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const core = value.trim().replace(/^v/i, "").split(/[-+]/)[0] ?? "";
    const parts = core.split(".");
    if (parts.length === 0 || !parts.every((part) => /^\d+$/.test(part))) {
      return null;
    }
    return parts.map((part) => Number(part));
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) {
    return 0;
  }
  const length = Math.max(pa.length, pb.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
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
  toolCallId?: string;
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
      ...(input.tool.description
        ? { description: input.tool.description }
        : {}),
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
    // `approve_always` is deliberately absent. The HITL gate cannot resolve an
    // MCP tool's domain and risk level without contacting the install, so
    // `respond` degrades the decision to a plain approve and records nothing —
    // offering the button here would show the user a grant that was never made.
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
      sourceweft: {
        toolCallId: input.toolCallId ?? input.action.idempotencyKey,
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

// A hostile or buggy MCP server can return multi-MB output. The audit copy is
// already truncated; this caps the value handed back to the model so a single
// tool result can't blow up the context window (and cost) mid-turn.
const MCP_MODEL_OUTPUT_CHAR_LIMIT =
  Number(process.env.MCP_MAX_TOOL_OUTPUT_CHARS) || 100_000;

function capMcpModelText(value: string) {
  return value.length > MCP_MODEL_OUTPUT_CHAR_LIMIT
    ? `${value.slice(0, MCP_MODEL_OUTPUT_CHAR_LIMIT).trimEnd()}\n\n[MCP tool output truncated: ${value.length} characters]`
    : value;
}

function capMcpModelOutput(value: unknown): unknown {
  if (typeof value === "string") {
    return capMcpModelText(value);
  }
  // Preserve the shape of standard content-block arrays, capping only big text.
  if (Array.isArray(value)) {
    return value.map((item) =>
      item &&
      typeof item === "object" &&
      typeof (item as { text?: unknown }).text === "string"
        ? { ...item, text: capMcpModelText((item as { text: string }).text) }
        : item,
    );
  }
  return value;
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

  async listMarketMcpCategories(input: {
    workspaceId: string;
    userId: string;
  }) {
    await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.read",
    });
    return marketService.listMcpCategories();
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

  async listToolRuns(input: {
    workspaceId: string;
    userId: string;
    limit?: number;
    cursor?: string | null;
  }) {
    const { workspace } = await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.read",
    });
    return listMcpToolRuns({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      limit: input.limit,
      cursor: input.cursor,
    });
  }

  async listActionRuns(input: {
    workspaceId: string;
    userId: string;
    limit?: number;
    cursor?: string | null;
  }) {
    const { workspace } = await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.read",
    });
    return listMcpActionRuns({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      limit: input.limit,
      cursor: input.cursor,
    });
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
    // Verify the signature over the ORIGINAL, unmodified manifest. Applying an
    // endpoint override before this would change canonicalJson(manifest) and
    // break verification, so the override is treated as local install config
    // that lives outside the signed set and is applied afterwards.
    const parsed = marketMcpManifestSchema.safeParse(response.manifest);
    if (!parsed.success) {
      throw new McpError(
        422,
        "MCP_MARKET_MANIFEST_INVALID",
        "Market MCP manifest is invalid",
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const verification = verifyMarketManifestSignature({
      manifest: parsed.data,
      signature: response.signature,
      signingKeyId: response.signingKeyId,
      trustedPublicKeys: config.market.trustedPublicKeys,
      allowUnsigned: config.market.allowUnsigned,
      envelope: response.version?.provenanceJson?.marketSignatureEnvelope,
    });

    // Downgrade protection: refuse to replace an installed version with an
    // older one. Only enforced when both versions are comparable dotted-numeric
    // strings, to avoid false rejections on non-semver tags.
    const existingInstall = await findWorkspaceMcpInstallByMarketIdentifier({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      marketIdentifier: parsed.data.identifier,
    });
    if (
      existingInstall?.marketVersion &&
      compareDottedVersions(parsed.data.version, existingInstall.marketVersion) < 0
    ) {
      throw new McpError(
        409,
        "MCP_MARKET_VERSION_DOWNGRADE",
        `Refusing to install ${parsed.data.identifier}@${parsed.data.version}; a newer version (${existingInstall.marketVersion}) is already installed.`,
      );
    }

    let manifestForInstall = parsed.data;
    if (input.endpointUrlOverride) {
      const overridden = marketMcpManifestSchema.safeParse({
        ...parsed.data,
        endpointUrl: input.endpointUrlOverride,
      });
      if (!overridden.success) {
        throw new McpError(
          422,
          "MCP_MARKET_MANIFEST_INVALID",
          "Market MCP manifest is invalid",
          overridden.error.flatten() as Record<string, unknown>,
        );
      }
      manifestForInstall = overridden.data;
    }

    await assertWebTransport(manifestForInstall);

    const install = await createOrUpdateMarketMcpInstall({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      manifest: manifestForInstall,
      verified: verification.verified,
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

  async deleteInstall(input: {
    workspaceId: string;
    userId: string;
    installId: string;
  }) {
    const { workspace } = await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.manage",
    });
    const deleted = await deleteWorkspaceMcpInstall({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      installId: input.installId,
    });
    if (!deleted) {
      throw new McpError(404, "MCP_INSTALL_NOT_FOUND", "MCP install not found");
    }
    return { deleted: true as const, installId: input.installId };
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
    await assertSafeMcpEndpoint(install.endpointUrl, {
      allowLocalhost: isDevelopment(),
    });

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
        preserveExistingMetadata: true,
        tools: tools.map((tool) => ({
          name: stripLangChainMcpToolPrefix({
            serverKey: install.marketIdentifier ?? install.id,
            toolName: tool.name,
          }),
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
      throw new McpError(502, "MCP_CONNECTION_FAILED", message, {
        sourceRef: {
          kind: "mcp_tool",
          serverInstallId: install.id,
        },
        recoverable: true,
      });
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
      // Re-validate the stored endpoint at execution time. The install-time
      // check is not enough on its own: a hostname can be repointed at an
      // internal/metadata address after install (DNS rebinding). Skip — rather
      // than connect to — any install whose endpoint now resolves unsafely.
      if (install.endpointUrl) {
        try {
          await assertSafeMcpEndpoint(install.endpointUrl, {
            allowLocalhost: isDevelopment(),
          });
        } catch {
          continue;
        }
      }
      // Each install is isolated: one server being unreachable (getTools throws,
      // since onConnectionError is "throw") must neither leak its transport nor
      // abort the whole turn. Close the client and move on.
      const client = createLangChainMcpClient({ install, headers });
      let installTools: DynamicStructuredTool[];
      try {
        installTools = await client.getTools();
      } catch {
        await client.close().catch(() => undefined);
        continue;
      }
      clients.push(client);
      for (const tool of installTools) {
        const knownTool = findInstallToolByLangChainName(install, tool.name);
        // A tool disabled via updateInstall/setWorkspaceMcpToolsEnabled must not
        // be bound, regardless of whether an explicit toolIds filter is present.
        if (knownTool && !knownTool.enabled) {
          continue;
        }
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
            {
              sourceRef: {
                kind: "mcp_tool",
                serverInstallId: input.install.id,
                serverToolName: toolRecord.serverToolName,
                normalizedToolName: toolRecord.normalizedToolName,
                toolId: input.tool?.id ?? null,
              },
              recoverable: true,
            },
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
          return capMcpModelOutput(output);
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
    // input.toolName is the LangChain tool name from the interrupt; resolve it
    // with the same matcher discovery uses so camelCase/non-slug-safe tools
    // aren't left un-approvable (which would hard-fail the turn).
    let install: (typeof installs)[number] | undefined;
    let tool: WorkspaceMcpToolRecord | undefined;
    for (const candidate of installs) {
      const match = findInstallToolByLangChainName(candidate, input.toolName);
      if (match) {
        install = candidate;
        tool = match;
        break;
      }
    }
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
    return mcpConfirmationPayload({ action, install, tool, toolCallId: input.toolCallId });
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
    if (action.status !== "proposed") {
      throw new McpError(
        409,
        "MCP_CONFIRMATION_INVALID_STATE",
        "Only proposed MCP confirmations can be approved or rejected",
      );
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
        requestJson: input.editedArgs ?? action.requestJson,
        requestPreview: buildMcpRequestPreview({
          install,
          tool,
          args: input.editedArgs ?? action.requestJson,
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
