import { MultiServerMCPClient, type ClientConfig } from "@langchain/mcp-adapters";
import type { WorkspaceMcpInstallRecord } from "./types";

export function createLangChainMcpClient(input: {
  install: WorkspaceMcpInstallRecord;
  headers?: Record<string, string>;
}) {
  const transport =
    input.install.transport === "sse" ? "sse" : "http";
  const config: ClientConfig = {
    throwOnLoadError: true,
    prefixToolNameWithServerName: true,
    additionalToolNamePrefix: "mcp",
    useStandardContentBlocks: true,
    onConnectionError: "throw",
    mcpServers: {
      [input.install.marketIdentifier ?? input.install.id]: {
        transport,
        url: input.install.endpointUrl ?? "",
        headers: input.headers,
        automaticSSEFallback: input.install.transport === "http_sse_compat",
      },
    },
  };
  return new MultiServerMCPClient(config);
}
