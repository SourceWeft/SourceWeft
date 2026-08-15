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
import { logger } from "../../shared/logger";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { decryptSecret, encryptSecret } from "../../shared/secrets";
import { McpError } from "./errors";
import {
  createLangChainMcpClient,
  langChainMcpServerKey,
  langChainMcpToolName,
} from "./langchain-client";
import { McpOAuthClientProvider } from "./oauth-provider";
import {
  createDbMcpOAuthStore,
  getMcpOAuthStatus,
  listUserConnectedOAuthInstallIds,
} from "./oauth-repository";
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
  listUserCredentialInstallIds,
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
  redactErrorMessage,
  redactMcpSecrets,
  resolveCredentialEnvRef,
  sanitizeHeaderName,
  sanitizeHeaders,
} from "./security";
import type {
  McpActionRunRecord,
  WorkspaceMcpCredentialStatus,
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
    allowPrivateNetwork: isDevelopment(),
  });
}

/**
 * Does this endpoint demand authentication? One cheap unauthenticated MCP
 * initialize; a 401 is the spec's signal for OAuth. A network/protocol failure
 * aborts installation because treating an unverified probe as "no auth" would
 * silently create an unusable install.
 */
export async function mcpEndpointRequiresAuth(
  endpointUrl: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      // Don't follow redirects: the endpoint passed SSRF validation, but a 3xx
      // could bounce the probe to an internal/metadata address (blind SSRF). A
      // redirect is simply "not a 401".
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "sourceweft-auth-probe", version: "1" },
        },
      }),
      signal: controller.signal,
    });
    return response.status === 401;
  } catch (error) {
    throw new McpError(
      502,
      "MCP_AUTH_PROBE_FAILED",
      `MCP endpoint authentication probe failed: ${redactErrorMessage(
        error instanceof Error ? error.message : String(error),
      )}`,
      { recoverable: true },
    );
  } finally {
    clearTimeout(timer);
  }
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
    const decrypted = decryptSecret(
      input.encryptedHeaders ?? "",
      encryptionSecret(),
    );
    if (!decrypted) {
      return {};
    }
    // Each header value may be an `env:VAR` reference resolved at use time.
    const parsed = JSON.parse(decrypted) as Record<string, string>;
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      resolved[key] = resolveCredentialEnvRef(value);
    }
    return resolved;
  }
  const secret = resolveCredentialEnvRef(
    decryptSecret(input.encryptedSecret ?? "", encryptionSecret()),
  );
  if (input.authType === "bearer") {
    return secret ? { Authorization: `Bearer ${secret}` } : {};
  }
  const headerName = input.headerName
    ? sanitizeHeaderName(input.headerName)
    : "";
  return headerName && secret ? { [headerName]: secret } : {};
}

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function discoveredMcpToolSchema(tool: DynamicStructuredTool) {
  const schema = toObject(tool.schema);
  if (Object.keys(schema).length === 0) {
    throw new McpError(
      502,
      "MCP_TOOL_SCHEMA_INVALID",
      `MCP tool '${tool.name}' did not provide a usable input schema`,
    );
  }
  return schema;
}

function discoveredMcpToolAnnotations(tool: DynamicStructuredTool) {
  return toObject(toObject(tool.metadata).annotations);
}

function isHighRisk(risk: McpRiskLevel) {
  return risk === "write" || risk === "destructive" || risk === "unknown";
}

/**
 * The risk the HITL gate actually acts on — never the manifest's self-asserted
 * value alone. An unverified install (federated-but-catalog-unverified, or a
 * user submission) can declare any tool `read` to slip past approval, so every
 * tool from an unverified install is forced to `unknown` (which hard-requires
 * approval). A tool with no stored record is likewise `unknown`. Only a
 * verified install's catalog risk is trusted. Both mount-time (interruptOn) and
 * execute-time (backstop) go through this so they can never disagree.
 */
function effectiveMcpRisk(input: {
  install: Pick<WorkspaceMcpInstallRecord, "verified">;
  tool?: Pick<WorkspaceMcpToolRecord, "risk"> | null;
}): McpRiskLevel {
  if (!input.tool) {
    return "unknown";
  }
  if (!input.install.verified) {
    return "unknown";
  }
  return input.tool.risk;
}

// Aggregate ceiling on tools bound into a single turn. installIds is already
// capped (10), but a server can expose unlimited tools; without this the tool
// schema handed to the model can balloon (cost/latency/provider 400s).
const MCP_MAX_BOUND_TOOLS = Number(process.env.MCP_MAX_BOUND_TOOLS) || 128;

// Per-connection deadlines. A selected install that accepts the socket but
// stalls on discovery/execution must not hang turn assembly (installs are
// awaited in sequence). Mirrors the install-time auth probe's 5s abort.
const MCP_GET_TOOLS_TIMEOUT_MS =
  Number(process.env.MCP_GET_TOOLS_TIMEOUT_MS) || 15_000;
const MCP_INVOKE_TIMEOUT_MS =
  Number(process.env.MCP_INVOKE_TIMEOUT_MS) || 30_000;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new McpError(504, "MCP_TIMEOUT", `${label} timed out`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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
    serverKey: langChainMcpServerKey(install),
    toolName: langChainToolName,
  });
  return (
    install.tools.find((candidate) => candidate.serverToolName === rawName) ??
    install.tools.find(
      (candidate) =>
        langChainMcpToolName({
          install,
          serverToolName: candidate.serverToolName,
        }) === langChainToolName,
    ) ??
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

export type McpActionExecutionRef = {
  actionRunId: string;
  toolName: string;
  requestJson: Record<string, unknown>;
};

/**
 * Approved MCP calls threaded into a resumed turn, matched by args (never by
 * tool-call id) so an interrupt raised inside a sub-agent subgraph — whose
 * tool-call id never appears in the top-level graph — still resolves. Each ref
 * is consumed once, so two identically-argumented approved calls execute twice.
 */
export type McpActionExecutionCursor = {
  refs: McpActionExecutionRef[];
  consumedActionRunIds?: Set<string>;
};

function resolveApprovedMcpActionRef(
  cursor: McpActionExecutionCursor | undefined,
  input: { toolName: string; requestJson: Record<string, unknown> },
): McpActionExecutionRef | null {
  if (!cursor) {
    return null;
  }
  const ref = cursor.refs.find(
    (candidate) =>
      !cursor.consumedActionRunIds?.has(candidate.actionRunId) &&
      candidate.toolName === input.toolName &&
      hashJson(candidate.requestJson) === hashJson(input.requestJson),
  );
  if (!ref) {
    return null;
  }
  cursor.consumedActionRunIds ??= new Set<string>();
  cursor.consumedActionRunIds.add(ref.actionRunId);
  return ref;
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

/**
 * Overlay per-user credential status onto installs. `credentialStatus` is a
 * per-user fact now (static credentials and OAuth tokens are both keyed by
 * user), so the value returned to a caller reflects THAT user's configuration,
 * not a shared install-level flag: `none` → not_required; otherwise
 * `configured` iff the user has their own credential/token, else `required`.
 */
async function overlayUserCredentialStatus<
  T extends WorkspaceMcpInstallRecord,
>(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  installs: T[];
}): Promise<T[]> {
  const authRequired = input.installs.filter(
    (install) => install.authType !== "none",
  );
  const oauthIds = authRequired
    .filter((install) => install.authType === "oauth")
    .map((install) => install.id);
  const staticIds = authRequired
    .filter((install) => install.authType !== "oauth")
    .map((install) => install.id);
  const [connected, credentialed] = await Promise.all([
    listUserConnectedOAuthInstallIds({
      userId: input.userId,
      installIds: oauthIds,
    }),
    listUserCredentialInstallIds({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      installIds: staticIds,
    }),
  ]);
  return input.installs.map((install) => {
    let status: WorkspaceMcpCredentialStatus;
    if (install.authType === "none") {
      status = "not_required";
    } else if (install.authType === "oauth") {
      status = connected.has(install.id) ? "configured" : "required";
    } else {
      status = credentialed.has(install.id) ? "configured" : "required";
    }
    return { ...install, credentialStatus: status };
  });
}

export class McpService {
  async listMarketMcp(input: {
    workspaceId: string;
    userId: string;
    query?: string;
    category?: string;
    includeDesktopOnly?: boolean;
    limit?: number;
    cursor?: string;
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
        limit: input.limit,
        cursor: input.cursor,
      }),
      listWorkspaceMcpInstalls({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
      }),
    ]);
    const installsWithStatus = await overlayUserCredentialStatus({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      installs,
    });
    const installsByIdentifier = new Map(
      installsWithStatus
        .filter((install) => install.marketIdentifier)
        .map((install) => [install.marketIdentifier, install]),
    );
    return {
      items: market.items.map((item) => ({
        market: item,
        install: installsByIdentifier.get(item.identifier) ?? null,
      })),
      nextCursor: market.nextCursor ?? null,
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

  async countMarketMcpCategories(input: {
    workspaceId: string;
    userId: string;
    query?: string;
  }) {
    await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.read",
    });
    return marketService.countMcpByCategory({ query: input.query });
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
    const [installWithStatus] = install
      ? await overlayUserCredentialStatus({
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          userId: input.userId,
          installs: [install],
        })
      : [null];
    return { market, install: installWithStatus ?? null };
  }

  async listInstalls(input: { workspaceId: string; userId: string }) {
    const { workspace } = await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.read",
    });
    return {
      items: await overlayUserCredentialStatus({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        userId: input.userId,
        installs: await listWorkspaceMcpInstalls({
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
        }),
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
    const parsed = marketMcpManifestSchema.safeParse(response.manifest);
    if (!parsed.success) {
      throw new McpError(
        422,
        "MCP_MARKET_MANIFEST_INVALID",
        "Market MCP manifest is invalid",
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

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
      compareDottedVersions(
        parsed.data.version,
        existingInstall.marketVersion,
      ) < 0
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

    // The official registry carries no auth metadata, so federated manifests
    // all claim auth "none" — which left OAuth-gated servers (GitHub, Notion…)
    // installed with no Connect path and failed at turn time. Probe
    // the (already SSRF-validated) endpoint once at install: a 401 means the
    // server wants OAuth per the MCP spec. Probe failure aborts installation.
    if (
      manifestForInstall.auth.type === "none" &&
      manifestForInstall.endpointUrl &&
      (await mcpEndpointRequiresAuth(manifestForInstall.endpointUrl))
    ) {
      manifestForInstall = {
        ...manifestForInstall,
        auth: { type: "oauth", required: true, allowedHeaderNames: [] },
      };
    }

    const install = await createOrUpdateMarketMcpInstall({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      manifest: manifestForInstall,
      // Trust comes from the catalog ROW (federation forces upstream-verified;
      // submissions are forced unverified at ingest), never from the submitted
      // manifest's self-asserted flag. Reading response.item — not the manifest
      // — is what makes the "submissions can't self-assert verified" guarantee
      // robust instead of relying on a coincidental parser hardcode.
      verified: response.item.verified,
    });
    if (!install) {
      throw new McpError(500, "MCP_INSTALL_FAILED", "Failed to install MCP");
    }

    const [installWithStatus] = await overlayUserCredentialStatus({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      installs: [install],
    });
    return { install: installWithStatus ?? install };
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
    const [installWithStatus] = await overlayUserCredentialStatus({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      installs: [install],
    });
    return { install: installWithStatus ?? install };
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
        throw new McpError(
          400,
          "MCP_CREDENTIAL_REQUIRED",
          "Bearer token is required",
        );
      }
      encryptedSecret = encryptSecret(input.bearerToken, encryptionSecret());
    } else if (input.authType === "api_key_header") {
      if (!input.apiKeyHeaderName || !input.apiKey) {
        throw new McpError(
          400,
          "MCP_CREDENTIAL_REQUIRED",
          "API key header and value are required",
        );
      }
      headerName = sanitizeHeaderName(input.apiKeyHeaderName);
      encryptedSecret = encryptSecret(input.apiKey, encryptionSecret());
    } else if (input.authType === "custom_headers") {
      const headers = sanitizeHeaders(input.headers ?? {});
      encryptedHeaders = encryptSecret(
        JSON.stringify(headers),
        encryptionSecret(),
      );
    }

    // Credentials are per-user: store them keyed to the caller and DON'T touch
    // the install-level credentialStatus (which would misrepresent every other
    // member as configured). The status returned below is overlaid per user.
    await upsertWorkspaceMcpCredential({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      installId: input.installId,
      userId: input.userId,
      authType: input.authType,
      encryptedSecret,
      encryptedHeaders,
      headerName,
      configuredBy: input.userId,
    });
    const [installWithStatus] = await overlayUserCredentialStatus({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      installs: [install],
    });
    return { install: installWithStatus ?? install };
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
    if (
      install.transport === "stdio" ||
      install.desktopOnly ||
      !install.webExecutable
    ) {
      throw new McpError(
        400,
        "MCP_DESKTOP_ONLY",
        "This MCP can only run from SourceWeft Desktop",
      );
    }
    if (!install.endpointUrl) {
      throw new McpError(
        400,
        "MCP_ENDPOINT_REQUIRED",
        "MCP endpoint is required",
      );
    }
    await assertSafeMcpEndpoint(install.endpointUrl, {
      allowLocalhost: isDevelopment(),
      allowPrivateNetwork: isDevelopment(),
    });

    // Same auth split as buildLangChainToolsForTurn: an oauth install tests
    // with the caller's token provider. Testing an unconnected oauth install
    // fails fast WITHOUT flipping status to "error" — a status flip here would
    // silently drop the install from every turn until a later successful test.
    let headers: Record<string, string> = {};
    let authProvider: OAuthClientProvider | undefined;
    if (install.authType === "oauth") {
      const scope = {
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        installId: install.id,
        userId: input.userId,
      };
      const status = await getMcpOAuthStatus(scope);
      if (!status.connected || !status.issuer) {
        throw new McpError(
          400,
          "MCP_OAUTH_NOT_CONNECTED",
          "Connect this MCP server before testing it",
        );
      }
      authProvider = new McpOAuthClientProvider({
        redirectUrl: config.mcpOAuth.redirectUrl,
        clientName: config.mcpOAuth.clientName,
        issuer: status.issuer,
        configuredClients: config.mcpOAuth.clients,
        store: createDbMcpOAuthStore(scope, status.issuer),
      });
    } else {
      const credential = await findWorkspaceMcpCredential({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        installId: input.installId,
        userId: input.userId,
      });
      headers = credential ? headersFromCredential(credential) : {};
    }
    const client = createLangChainMcpClient({ install, headers, authProvider });
    try {
      const tools = await withTimeout(
        client.getTools(),
        MCP_GET_TOOLS_TIMEOUT_MS,
        `MCP ${install.name} tool discovery`,
      );
      await upsertWorkspaceMcpTools({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        installId: install.id,
        serverSlug: install.marketIdentifier ?? install.id,
        preserveExistingMetadata: true,
        tools: tools.map((tool) => {
          const serverToolName = stripLangChainMcpToolPrefix({
            serverKey: langChainMcpServerKey(install),
            toolName: tool.name,
          });
          return {
            name: serverToolName,
            normalizedToolName: langChainMcpToolName({
              install,
              serverToolName,
            }),
            title: serverToolName,
            description: tool.description,
            inputSchema: discoveredMcpToolSchema(tool),
            annotations: discoveredMcpToolAnnotations(tool),
            risk: "unknown" as const,
          };
        }),
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
    mcpActions?: McpActionExecutionRef[];
  }) {
    const { workspace } = await requireMcpWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "mcp.execute",
    });
    // One cursor shared across every wrapped tool this turn: an approved ref is
    // consumed once, so a resumed turn that approved the same call twice runs it
    // twice rather than collapsing to one execution.
    const mcpActionCursor: McpActionExecutionCursor | undefined = input
      .mcpActions?.length
      ? { refs: input.mcpActions }
      : undefined;
    const installs = await listWorkspaceMcpInstalls({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });
    const requestedInstallIds = Array.from(new Set(input.installIds));
    const installsById = new Map(
      installs.map((install) => [install.id, install]),
    );
    const missingInstallIds = requestedInstallIds.filter(
      (installId) => !installsById.has(installId),
    );
    if (missingInstallIds.length > 0) {
      throw new McpError(
        404,
        "MCP_INSTALL_NOT_FOUND",
        "One or more selected MCP installs are not available in this workspace",
        { installIds: missingInstallIds },
      );
    }
    const selected = requestedInstallIds.map((installId) => {
      const install = installsById.get(installId)!;
      if (!install.enabled || install.status !== "active") {
        throw new McpError(
          409,
          "MCP_INSTALL_UNAVAILABLE",
          `Selected MCP install '${install.name}' is not active`,
          {
            installId: install.id,
            enabled: install.enabled,
            status: install.status,
          },
        );
      }
      if (
        install.transport === "stdio" ||
        install.desktopOnly ||
        !install.webExecutable
      ) {
        throw new McpError(
          400,
          "MCP_DESKTOP_ONLY",
          `Selected MCP install '${install.name}' cannot execute in the hosted backend`,
          { installId: install.id, transport: install.transport },
        );
      }
      return install;
    });
    const clients: Array<{ close: () => Promise<void> }> = [];
    const tools: DynamicStructuredTool[] = [];
    const boundToolNames = new Set<string>();
    const interruptOn: Record<string, InterruptOnConfig> = {};
    const availableToolIds = new Set<string>();
    try {
      for (const install of selected) {
        // Re-validate the stored endpoint at execution time. The install-time
        // check is not enough on its own: a hostname can be repointed at an
        // internal/metadata address after install (DNS rebinding).
        if (install.endpointUrl) {
          try {
            await assertSafeMcpEndpoint(install.endpointUrl, {
              allowLocalhost: isDevelopment(),
              allowPrivateNetwork: isDevelopment(),
            });
          } catch (error) {
            if (error instanceof McpError) {
              throw error;
            }
            throw new McpError(
              400,
              "MCP_ENDPOINT_UNSAFE",
              `Selected MCP install '${install.name}' failed endpoint validation`,
              {
                installId: install.id,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
        // Resolve auth per install: OAuth installs use a per-user token provider
        // (the SDK attaches the bearer and refreshes on 401); the other auth types
        // use static credential headers. A selected install without its required
        // per-user credential fails preparation.
        let headers: Record<string, string> = {};
        let authProvider: OAuthClientProvider | undefined;
        if (install.authType === "oauth") {
          const scope = {
            teamId: workspace.organizationId,
            workspaceId: workspace.id,
            installId: install.id,
            userId: input.userId,
          };
          const status = await getMcpOAuthStatus(scope);
          if (!status.connected || !status.issuer) {
            throw new McpError(
              409,
              "MCP_OAUTH_NOT_CONNECTED",
              `Selected MCP install '${install.name}' is not connected for this user`,
              { installId: install.id },
            );
          }
          authProvider = new McpOAuthClientProvider({
            redirectUrl: config.mcpOAuth.redirectUrl,
            clientName: config.mcpOAuth.clientName,
            issuer: status.issuer,
            configuredClients: config.mcpOAuth.clients,
            store: createDbMcpOAuthStore(scope, status.issuer),
          });
        } else {
          // Static credentials are per-user: use the INVOKING user's own
          // credential, never a workspace-shared one. A user who hasn't
          // configured this install has no headers (the connection fails as
          // unauthenticated) rather than borrowing another member's token.
          const credential = await findWorkspaceMcpCredential({
            teamId: workspace.organizationId,
            workspaceId: workspace.id,
            installId: install.id,
            userId: input.userId,
          });
          if (install.authType !== "none" && !credential) {
            throw new McpError(
              409,
              "MCP_CREDENTIAL_REQUIRED",
              `Selected MCP install '${install.name}' has no credential for this user`,
              { installId: install.id },
            );
          }
          headers = credential ? headersFromCredential(credential) : {};
        }
        // Discovery is strict (`onConnectionError: "throw"`). Any selected
        // server failure closes all clients opened for this turn.
        const client = createLangChainMcpClient({
          install,
          headers,
          authProvider,
        });
        let installTools: DynamicStructuredTool[];
        try {
          installTools = await withTimeout(
            client.getTools(),
            MCP_GET_TOOLS_TIMEOUT_MS,
            `MCP ${install.name} tool discovery`,
          );
        } catch (error) {
          await client.close().catch(() => undefined);
          throw new McpError(
            502,
            "MCP_CONNECTION_FAILED",
            `Failed to discover tools for selected MCP install '${install.name}': ${redactErrorMessage(
              error instanceof Error ? error.message : String(error),
            )}`,
            {
              details: { installId: install.id },
              sourceRef: {
                kind: "mcp_tool",
                serverInstallId: install.id,
              },
              recoverable: true,
            },
          );
        }
        clients.push(client);
        const discoveredToolIds = new Set<string>();
        for (const tool of installTools) {
          const serverToolName = stripLangChainMcpToolPrefix({
            serverKey: langChainMcpServerKey(install),
            toolName: tool.name,
          });
          const boundToolName = langChainMcpToolName({
            install,
            serverToolName,
          });
          const storedTool = findInstallToolByLangChainName(install, tool.name);
          const liveInputSchema = discoveredMcpToolSchema(tool);
          const liveAnnotations = discoveredMcpToolAnnotations(tool);
          if (!storedTool) {
            throw new McpError(
              502,
              "MCP_TOOL_DISCOVERY_MISMATCH",
              `Selected MCP install '${install.name}' exposed an unregistered tool`,
              { installId: install.id, serverToolName },
            );
          }
          const knownTool = {
            ...storedTool,
            normalizedToolName: boundToolName,
            description: tool.description || storedTool.description,
            inputSchema: liveInputSchema,
            annotations: liveAnnotations,
          };
          discoveredToolIds.add(knownTool.id);
          // A tool disabled via updateInstall/setWorkspaceMcpToolsEnabled must not
          // be bound, regardless of whether an explicit toolIds filter is present.
          if (!knownTool.enabled) {
            if (input.toolIds?.includes(knownTool.id)) {
              throw new McpError(
                409,
                "MCP_TOOL_DISABLED",
                `Selected MCP tool '${knownTool.serverToolName}' is disabled`,
                { installId: install.id, toolId: knownTool.id },
              );
            }
            continue;
          }
          if (input.toolIds?.length && !input.toolIds.includes(knownTool.id)) {
            continue;
          }
          if (boundToolNames.has(boundToolName)) {
            throw new McpError(
              502,
              "MCP_TOOL_NAME_COLLISION",
              `Two selected MCP tools resolve to the same model-visible name '${boundToolName}'`,
              { installId: install.id, serverToolName },
            );
          }
          if (tools.length >= MCP_MAX_BOUND_TOOLS) {
            throw new McpError(
              413,
              "MCP_TOOL_LIMIT_EXCEEDED",
              `Selected MCP tools exceed the per-turn limit of ${MCP_MAX_BOUND_TOOLS}`,
              { installId: install.id, limit: MCP_MAX_BOUND_TOOLS },
            );
          }
          // Gate on the EFFECTIVE risk, not the manifest's self-asserted value: an
          // unverified install's tools are all forced to "unknown" and therefore
          // require an approval interrupt.
          const risk = effectiveMcpRisk({ install, tool: knownTool });
          if (isHighRisk(risk)) {
            interruptOn[boundToolName] = {
              allowedDecisions: ["approve", "edit", "reject"],
              description: `${install.name} MCP tool ${knownTool?.serverToolName ?? tool.name} may perform external ${risk} actions. Review before execution.`,
              argsSchema: liveInputSchema,
            };
          }
          tools.push(
            this.wrapLangChainMcpTool({
              install,
              originalTool: tool,
              tool: knownTool,
              boundToolName,
              teamId: workspace.organizationId,
              workspaceId: workspace.id,
              userId: input.userId,
              threadId: input.threadId ?? null,
              runId: input.runId ?? null,
              mcpActionCursor,
            }),
          );
          boundToolNames.add(boundToolName);
          availableToolIds.add(knownTool.id);
        }
        const missingEnabledToolIds = install.tools
          .filter(
            (tool) =>
              tool.enabled &&
              (!input.toolIds?.length || input.toolIds.includes(tool.id)),
          )
          .filter((tool) => !discoveredToolIds.has(tool.id))
          .map((tool) => tool.id);
        if (missingEnabledToolIds.length > 0) {
          throw new McpError(
            502,
            "MCP_TOOL_DISCOVERY_MISMATCH",
            `Selected MCP install '${install.name}' did not expose every enabled tool`,
            { installId: install.id, toolIds: missingEnabledToolIds },
          );
        }
      }
      const missingRequestedToolIds = (input.toolIds ?? []).filter(
        (toolId) => !availableToolIds.has(toolId),
      );
      if (missingRequestedToolIds.length > 0) {
        throw new McpError(
          404,
          "MCP_TOOL_NOT_AVAILABLE",
          "One or more selected MCP tools could not be bound",
          { toolIds: missingRequestedToolIds },
        );
      }
    } catch (error) {
      await Promise.allSettled(clients.map((client) => client.close()));
      throw error;
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
    tool: WorkspaceMcpToolRecord;
    boundToolName: string;
    teamId: string;
    workspaceId: string;
    userId: string;
    threadId: string | null;
    runId: string | null;
    mcpActionCursor?: McpActionExecutionCursor;
  }) {
    const toolRecord = input.tool;
    const risk = effectiveMcpRisk({ install: input.install, tool: input.tool });
    return new DynamicStructuredTool({
      name: input.boundToolName,
      description: input.originalTool.description,
      schema: input.originalTool.schema,
      metadata: input.originalTool.metadata,
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
          toolId: input.tool.id,
          serverToolName: toolRecord.serverToolName,
          normalizedToolName: toolRecord.normalizedToolName,
          risk,
          status: isHighRisk(risk) ? "proposed" : "running",
          requestJson,
          requestPreview: buildMcpRequestPreview({
            install: input.install,
            tool: toolRecord,
            args: requestJson,
          }),
          idempotencyKey:
            toolCallId ??
            // No tool-call id: key on the ORIGINAL args hash (not the redacted
            // one) so two calls differing only in a sensitive-named field don't
            // collide onto one action run. The key is a hash, never stored
            // plaintext.
            `${input.runId ?? input.threadId ?? input.workspaceId}:${input.boundToolName}:${hashJson(toObject(args))}`,
        });
        if (isHighRisk(risk)) {
          // Approval is resolved by args from the refs threaded into this
          // resumed turn, never by tool-call id: an interrupt raised inside a
          // sub-agent subgraph has a tool-call id that never surfaces in the
          // top-level graph, so a tool-call-id gate dead-ends there. Each
          // approved ref is consumed once (two identical approved calls both
          // run), and the authoritative DB run is re-checked so a ref
          // reconstructed from persisted confirmation metadata cannot approve
          // un-approved args.
          const approvedRef = resolveApprovedMcpActionRef(
            input.mcpActionCursor,
            { toolName: input.boundToolName, requestJson },
          );
          const approvedRun = approvedRef
            ? await findMcpActionRun({
                teamId: input.teamId,
                workspaceId: input.workspaceId,
                actionRunId: approvedRef.actionRunId,
              })
            : null;
          const approvedForTheseArgs =
            approvedRun?.status === "approved" &&
            hashJson(approvedRun.requestJson) === hashJson(requestJson);
          if (!approvedForTheseArgs) {
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
                  toolId: input.tool.id,
                },
                recoverable: true,
              },
            );
          }
        }
        const toolRun = await createMcpToolRun({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          runId: input.runId,
          toolCallId,
          installId: input.install.id,
          toolId: input.tool.id,
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
          const output = await withTimeout(
            input.originalTool.invoke(args, configValue),
            MCP_INVOKE_TIMEOUT_MS,
            `MCP ${input.install.name}.${toolRecord.serverToolName}`,
          );
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
          const message =
            error instanceof Error ? error.message : String(error);
          // A hostile/buggy server (or an auth failure echoing the presented
          // header) can put secrets into the error text; redact before it is
          // persisted or later streamed to co-participants.
          const safeMessage = redactErrorMessage(message);
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
              errorMessage: safeMessage,
            }),
            updateMcpActionRun({
              teamId: input.teamId,
              workspaceId: input.workspaceId,
              actionRunId: actionRun.id,
              status: "failed",
              errorCode: "MCP_TOOL_CALL_FAILED",
              errorMessage: safeMessage,
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
    // id is null for a synthesized (no-DB-record) tool; the fields below are all
    // that the confirmation/action-run need — never the id.
    let tool:
      (Omit<WorkspaceMcpToolRecord, "id"> & { id: string | null }) | undefined;
    for (const candidate of installs) {
      const match = findInstallToolByLangChainName(candidate, input.toolName);
      if (match) {
        install = candidate;
        tool = match;
        break;
      }
    }
    if (!install || !tool) {
      // No stored tool record (the server added a tool since the last test, or a
      // fresh federated install). Locate the owning install by its sanitized
      // server key and synthesize an unknown-risk tool record so the call can
      // still be approved, instead of hard-failing the turn with a 500.
      const owner = installs.find((candidate) =>
        input.toolName.startsWith(`mcp__${langChainMcpServerKey(candidate)}__`),
      );
      if (!owner) {
        return null;
      }
      const serverToolName = stripLangChainMcpToolPrefix({
        serverKey: langChainMcpServerKey(owner),
        toolName: input.toolName,
      });
      install = owner;
      tool = {
        id: null,
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        installId: owner.id,
        serverToolName,
        normalizedToolName: input.toolName,
        title: serverToolName,
        description: null,
        inputSchema: {},
        outputSchema: null,
        annotations: {},
        risk: "unknown",
        enabled: true,
        lastDiscoveredHash: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    const requestJson = redactMcpSecrets(input.args) as Record<string, unknown>;
    const action = await createMcpActionRun({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      installId: install.id,
      toolId: tool.id,
      serverToolName: tool.serverToolName,
      normalizedToolName: tool.normalizedToolName,
      // Never the manifest's self-asserted risk: an unverified install or a
      // synthesized tool is forced to require approval.
      risk: effectiveMcpRisk({ install, tool }),
      status: "proposed",
      requestJson,
      requestPreview: buildMcpRequestPreview({
        install,
        tool: tool as WorkspaceMcpToolRecord,
        args: requestJson,
      }),
      idempotencyKey: input.toolCallId,
    });
    return mcpConfirmationPayload({
      action,
      install,
      tool: tool as WorkspaceMcpToolRecord,
      toolCallId: input.toolCallId,
    });
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
      throw new McpError(
        404,
        "MCP_CONFIRMATION_NOT_FOUND",
        "MCP confirmation request not found",
      );
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
    if (!install) {
      throw new McpError(404, "MCP_TOOL_NOT_FOUND", "MCP tool not found");
    }
    // Match by toolId when the action run has one; a synthesized (server-added)
    // tool has none, so fall back to the server tool name and finally
    // reconstruct a minimal record from the action run itself — an approval for
    // a tool with no stored row must still resolve rather than 404.
    const tool: WorkspaceMcpToolRecord =
      install.tools.find((candidate) =>
        action.toolId
          ? candidate.id === action.toolId
          : candidate.serverToolName === action.serverToolName,
      ) ??
      ({
        id: action.toolId,
        teamId: action.teamId,
        workspaceId: action.workspaceId,
        installId: action.installId,
        serverToolName: action.serverToolName,
        normalizedToolName: action.normalizedToolName,
        title: action.serverToolName,
        description: null,
        inputSchema: {},
        outputSchema: null,
        annotations: {},
        risk: action.risk,
        enabled: true,
        lastDiscoveredHash: null,
        createdAt: action.createdAt,
        updatedAt: action.updatedAt,
      } as WorkspaceMcpToolRecord);
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
        confirmation: mcpConfirmationPayload({
          action: rejected,
          install,
          tool,
        }),
        resume: {
          decisions: [
            {
              type: "reject" as const,
              message:
                input.note ?? "User rejected the MCP action in SourceWeft.",
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
    // When the user edited the args, the resume decision must carry them as an
    // "edit" so the interrupted tool re-executes with the edited args. A plain
    // "approve" would re-run the model's ORIGINAL args while the audit record
    // above claims the edited ones ran. Mirrors the sandbox confirmation path.
    //
    // The resume target is ALWAYS reconstructed server-side from the DB-approved
    // install+tool — never taken from the client-submitted confirmation. The
    // payload we emit carries the lossy normalizedToolName (which wouldn't match
    // the bound `mcp__<serverKey>__<serverToolName>`), and trusting the client
    // would also let it redirect the edit to a different tool than the one the
    // action run records as approved.
    const editedToolName = `mcp__${langChainMcpServerKey(install)}__${tool.serverToolName}`;
    const resumeDecision = input.editedArgs
      ? {
          type: "edit" as const,
          editedAction: { name: editedToolName, args: input.editedArgs },
        }
      : { type: "approve" as const };
    return {
      confirmation: mcpConfirmationPayload({ action: approved, install, tool }),
      resume: {
        decisions: [resumeDecision],
      },
    };
  }
}

export const mcpService = new McpService();
