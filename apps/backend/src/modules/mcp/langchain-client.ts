import { loadMcpTools } from "@langchain/mcp-adapters";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpError } from "./errors";
import type { WorkspaceMcpInstallRecord } from "./types";
import { createHash } from "node:crypto";
import { createMcpRequestScope } from "./network";

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
  const requests = createMcpRequestScope();
  const endpoint = input.install.endpointUrl;
  let client: Client | undefined;
  let closed = false;
  let pending: ReturnType<typeof loadMcpTools> | undefined;

  async function connect(kind: "http" | "sse", url: string) {
    if (closed) throw new Error("MCP client is closed");
    requests.throwIfDenied();
    const next = new Client({ name: "sourceweft", version: "1" });
    client = next;
    const options = {
      fetch: requests.fetch,
      requestInit: { headers: input.headers },
      ...(input.authProvider ? { authProvider: input.authProvider } : {}),
    };
    try {
      await next.connect(
        kind === "http"
          ? new StreamableHTTPClientTransport(new URL(url), options)
          : new SSEClientTransport(new URL(url), options),
      );
      const tools = await loadMcpTools(
        langChainMcpServerKey(input.install),
        next,
        {
          throwOnLoadError: true,
          prefixToolNameWithServerName: true,
          additionalToolNamePrefix: "mcp",
          useStandardContentBlocks: true,
        },
      );
      if (closed) throw new Error("MCP client closed during discovery");
      requests.throwIfDenied();
      return tools;
    } catch (error) {
      await next.close();
      requests.throwIfDenied();
      throw error;
    }
  }

  async function initialize() {
    try {
      return await connect(transport, endpoint);
    } catch (error) {
      requests.throwIfDenied();
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (
        transport !== "http" ||
        !automaticSSEFallbackFor(input.install.transport) ||
        typeof code !== "number" ||
        code < 400 ||
        code >= 500
      )
        throw error;
      // Preserve only the manifest's explicit legacy HTTP/SSE compatibility.
      try {
        return await connect("sse", endpoint);
      } catch (sseError) {
        requests.throwIfDenied();
        const alternate = new URL(endpoint);
        if (!alternate.pathname.endsWith("/mcp")) throw sseError;
        alternate.pathname = `${alternate.pathname.slice(0, -4)}/sse`;
        return connect("sse", alternate.toString());
      }
    }
  }

  return {
    getTools() {
      if (closed) return Promise.reject(new Error("MCP client is closed"));
      return (pending ??= initialize().catch(async (error) => {
        closed = true;
        await requests.close();
        throw error;
      }));
    },
    async close() {
      closed = true;
      try {
        await client?.close();
      } finally {
        await requests.close();
      }
    },
  };
}
