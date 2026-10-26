import { describe, expect, it } from "vitest";
import type { MarketMcpManifest } from "@sourceweft/market-sdk";

import { mcpClientConfigKey, remoteMcpClientConfig } from "./mcp-install";

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
        search: { type: "http", url: "https://mcp.acme.dev/mcp" },
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
    expect(config.mcpServers.search).toEqual({
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

describe("mcpClientConfigKey", () => {
  it("is the display name's slug, not the identifier's last segment", () => {
    expect(
      mcpClientConfigKey({ identifier: "com.notion/mcp", name: "Notion" }),
    ).toBe("notion");
    expect(
      mcpClientConfigKey({
        identifier: "com.notion/mcp",
        name: "Notion MCP Server (Hosted)",
      }),
    ).toBe("notion-hosted");
  });

  it("keeps a stable, distinct key when the name is only generic words", () => {
    const first = mcpClientConfigKey({
      identifier: "io.github.acme/mcp",
      name: "MCP Server",
    });
    const again = mcpClientConfigKey({
      identifier: "io.github.acme/mcp",
      name: "MCP Server",
    });
    const other = mcpClientConfigKey({
      identifier: "io.github.beta/mcp",
      name: "MCP Server",
    });
    expect(first).toBe(again);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^io-github-acme-[a-z0-9]{4}$/);
    expect(mcpClientConfigKey({ identifier: "mcp", name: "" })).toMatch(
      /^server-[a-z0-9]{4}$/,
    );
  });

  it("is a safe config key for any name", () => {
    expect(
      mcpClientConfigKey({ identifier: "a/b", name: "  Ünïcode / Tools!  " }),
    ).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(
      mcpClientConfigKey({ identifier: "a/b", name: "x".repeat(200) }).length,
    ).toBeLessThanOrEqual(40);
  });
});
