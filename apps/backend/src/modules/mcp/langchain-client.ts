import {
  MultiServerMCPClient,
  type ClientConfig,
} from "@langchain/mcp-adapters";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpError } from "./errors";
import type { WorkspaceMcpInstallRecord } from "./types";
import { createHash } from "node:crypto";

const MAX_MCP_TOOL_NAME_LENGTH = 64;

function langChainTransportFor(
  transport: WorkspaceMcpInstallRecord["transport"],
) {
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

/**
 * The server key baked into every LangChain tool name
 * (`mcp__<serverKey>__<tool>`). Market identifiers are reverse-DNS
 * (`io.github.owner/repo`) whose `.` and `/` violate the LLM providers'
 * tool-name charset (`[a-zA-Z0-9_-]`) and would 400 the model call the moment a
 * federated install's tools are bound — so the key is sanitized here, and every
 * strip/join site derives it from this one helper so discovery, approval, and
 * binding always agree.
 */
export function langChainMcpServerKey(install: {
  marketIdentifier: string | null;
  id: string;
}) {
  const base = (install.marketIdentifier ?? install.id)
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 32);
  // Disambiguate installs whose identifiers sanitize to the same key
  // (`io.github.a/b` and `io.github.a.b` both collapse to `io_github_a_b`):
  // append a short hash of the globally-unique install id. Without this two
  // installs share a server key, their tool names collide, and their
  // interruptOn entries overwrite each other — the approval gate then applies to
  // the wrong server.
  const suffix = createHash("sha256")
    .update(install.id)
    .digest("hex")
    .slice(0, 8);
  return `${base || "server"}_${suffix}`;
}

/**
 * Produce the provider-safe leaf used in the model-visible MCP tool name.
 * The hash suffix is added whenever normalization is lossy or the raw name is
 * too long, preventing two distinct server names from collapsing to one tool.
 */
export function langChainMcpToolName(input: {
  install: Pick<WorkspaceMcpInstallRecord, "id" | "marketIdentifier">;
  serverToolName: string;
}) {
  const prefix = `mcp__${langChainMcpServerKey(input.install)}__`;
  const available = Math.max(9, MAX_MCP_TOOL_NAME_LENGTH - prefix.length);
  const normalized = input.serverToolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const lossless =
    normalized === input.serverToolName &&
    normalized.length > 0 &&
    normalized.length <= available;
  const leaf = lossless
    ? normalized
    : `${(normalized || "tool").slice(0, Math.max(1, available - 9))}_${createHash(
        "sha256",
      )
        .update(input.serverToolName)
        .digest("hex")
        .slice(0, 8)}`;
  return `${prefix}${leaf}`;
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
    throw new McpError(
      400,
      "MCP_ENDPOINT_REQUIRED",
      "MCP endpoint is required",
    );
  }
  const config: ClientConfig = {
    throwOnLoadError: true,
    prefixToolNameWithServerName: true,
    additionalToolNamePrefix: "mcp",
    useStandardContentBlocks: true,
    onConnectionError: "throw",
    mcpServers: {
      [langChainMcpServerKey(input.install)]: {
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
