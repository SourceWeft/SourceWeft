import { McpError } from "../mcp/errors";

export type HostedMcpTransport = "sse" | "streamable_http" | "http_sse_compat";
export type WorkspaceMcpInstallTransport = HostedMcpTransport | "stdio";
export type WorkspaceMcpInstallSource = "marketplace" | "custom_remote";
export type WorkspaceMcpCapabilityRisk =
  | "low"
  | "medium"
  | "high"
  | "read"
  | "write"
  | "destructive"
  | "unknown";

export type WorkspaceMcpManifestTool = {
  id: string;
  serverInstallId: string;
  serverToolName: string;
  normalizedToolName: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  risk: WorkspaceMcpCapabilityRisk;
  enabled: boolean;
  schemaHash: string;
};

export type WorkspaceMcpManifestPrompt = {
  id: string;
  serverInstallId: string;
  name: string;
  title: string | null;
  description: string | null;
  argumentsSchema: Record<string, unknown> | null;
  enabled: boolean;
  schemaHash: string;
};

export type WorkspaceMcpManifestResource = {
  id: string;
  serverInstallId: string;
  uri: string;
  title: string | null;
  description: string | null;
  mimeType: string | null;
  enabled: boolean;
  schemaHash: string;
};

export type WorkspaceMcpManifestSnapshot = {
  serverInstallId: string;
  discoveredAt: string;
  schemaHash: string;
  tools: WorkspaceMcpManifestTool[];
  prompts: WorkspaceMcpManifestPrompt[];
  resources: WorkspaceMcpManifestResource[];
};

export type WorkspaceMcpInstall = {
  id: string;
  workspaceId: string;
  source: WorkspaceMcpInstallSource;
  marketIdentifier?: string;
  transport: WorkspaceMcpInstallTransport;
  endpointUrl: string | null;
  manifest: WorkspaceMcpManifestSnapshot;
  enabled: boolean;
  status?: "active" | "disabled" | "needs_auth" | "unreachable";
  credentialStatus?: "not_required" | "required" | "configured" | "invalid";
};

export function isHostedMcpTransport(
  transport: WorkspaceMcpInstallTransport,
): transport is HostedMcpTransport {
  return (
    transport === "sse" ||
    transport === "streamable_http" ||
    transport === "http_sse_compat"
  );
}

export function getHostedMcpTransport(
  transport: WorkspaceMcpInstallTransport,
): HostedMcpTransport {
  if (!isHostedMcpTransport(transport)) {
    throw new McpError(
      400,
      "MCP_TRANSPORT_UNSUPPORTED",
      "Hosted backend does not support stdio MCP transport",
    );
  }
  return transport;
}

export function createWorkspaceMcpManifestSnapshot(
  input: WorkspaceMcpManifestSnapshot,
): WorkspaceMcpManifestSnapshot {
  return input;
}

export function createWorkspaceMcpInstall(input: {
  id: string;
  workspaceId: string;
  source: WorkspaceMcpInstallSource;
  marketIdentifier?: string;
  transport: WorkspaceMcpInstallTransport;
  endpointUrl: string | null;
  manifest: WorkspaceMcpManifestSnapshot;
  enabled?: boolean;
}): WorkspaceMcpInstall {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    source: input.source,
    marketIdentifier: input.marketIdentifier,
    transport: input.transport,
    endpointUrl: input.endpointUrl,
    manifest: input.manifest,
    enabled: input.enabled ?? true,
    status: input.enabled === false ? "disabled" : "active",
    credentialStatus: "not_required",
  };
}
