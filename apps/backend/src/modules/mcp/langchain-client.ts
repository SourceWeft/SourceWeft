import { MultiServerMCPClient, type ClientConfig } from "@langchain/mcp-adapters";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpError } from "./errors";
import type { WorkspaceMcpInstallRecord } from "./types";

function langChainTransportFor(transport: WorkspaceMcpInstallRecord["transport"]) {
  if (transport === "stdio") {
    throw new McpError(
      400,
      "MCP_TRANSPORT_UNSUPPORTED",
      "Hosted backend does not support stdio MCP transport",
    );
  }
  return transport === "sse" ? "sse" : "http";
}

function automaticSSEFallbackFor(
  transport: WorkspaceMcpInstallRecord["transport"],
) {
  if (transport === "http_sse_compat") {
    return true;
  }
  if (transport === "streamable_http") {
    return false;
  }
  return false;
}

export function createLangChainMcpClient(input: {
  install: WorkspaceMcpInstallRecord;
  headers?: Record<string, string>;
  /**
   * OAuth provider for authType "oauth". When present the transport attaches the
   * user's bearer token and refreshes it on 401; static `headers` are used for
   * the other auth types.
   */
  authProvider?: OAuthClientProvider;
}) {
  const transport = langChainTransportFor(input.install.transport);
  if (!input.install.endpointUrl) {
    throw new McpError(400, "MCP_ENDPOINT_REQUIRED", "MCP endpoint is required");
  }
  const config: ClientConfig = {
    throwOnLoadError: true,
    prefixToolNameWithServerName: true,
    additionalToolNamePrefix: "mcp",
    useStandardContentBlocks: true,
    onConnectionError: "throw",
    mcpServers: {
      [input.install.marketIdentifier ?? input.install.id]: {
        transport,
        url: input.install.endpointUrl,
        headers: input.headers,
        ...(input.authProvider ? { authProvider: input.authProvider } : {}),
        automaticSSEFallback: automaticSSEFallbackFor(input.install.transport),
      },
    },
  };
  return new MultiServerMCPClient(config);
}
