import { describe, expect, it } from "vitest";
import type { MarketMcpManifest } from "@sourceweft/market-sdk";

import { remoteMcpClientConfig } from "./mcp-install";

function manifest(overrides: Partial<MarketMcpManifest>): MarketMcpManifest {
  return {
    auth: { allowedHeaderNames: [], required: false, type: "none" },
    categories: [],
    desktopOnly: false,
    identifier: "io.github.acme/Search Server",
    name: "Search",
    official: false,
    schemaVersion: 1,
    summary: "",
    tools: [],
    transport: "streamable_http",
    verified: false,
    version: "1.0.0",
    webExecutable: true,
    endpointUrl: "https://mcp.acme.dev/mcp",
    ...overrides,
  };
}

describe("remoteMcpClientConfig", () => {
  it("prints a streamable HTTP server without headers", () => {
    expect(JSON.parse(remoteMcpClientConfig(manifest({}))!)).toEqual({
      mcpServers: {
        "search-server": { type: "http", url: "https://mcp.acme.dev/mcp" },
      },
    });
  });

  it("uses placeholders for credential headers", () => {
    const config = JSON.parse(
      remoteMcpClientConfig(
        manifest({
          auth: {
            allowedHeaderNames: [],
            headerName: "X-Acme-Key",
            required: true,
            type: "api_key_header",
          },
          transport: "sse",
        }),
      )!,
    );
    expect(config.mcpServers["search-server"]).toEqual({
      headers: { "X-Acme-Key": "<YOUR_API_KEY>" },
      type: "sse",
      url: "https://mcp.acme.dev/mcp",
    });
  });

  it("returns null when there is no remote endpoint", () => {
    expect(remoteMcpClientConfig(manifest({ transport: "stdio" }))).toBeNull();
    expect(remoteMcpClientConfig(manifest({ endpointUrl: undefined }))).toBeNull();
  });
});
