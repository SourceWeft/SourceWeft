import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import {
  buildMcpClientConfig,
  mcpClientConfigKey,
} from "../src/mcp/client-config";
import type { McpManifestView } from "../src/registry/schema";

/**
 * The CLI keeps its own copy of the website's config builder (see
 * src/mcp/client-config.ts). This loads the website's module from the
 * repository checkout and fails when the two print different configs for the
 * same manifest, so the install dialog, the install guide and the CLI cannot
 * drift apart.
 */
const WEB_MODULE = pathToFileURL(
  fileURLToPath(
    new URL(
      "../../apps/web/app/[locale]/mcp/_components/mcp-install.ts",
      import.meta.url,
    ),
  ),
).href;

type Web = {
  mcpClientConfigKey: typeof mcpClientConfigKey;
  remoteMcpClientConfigObject: (
    manifest: unknown,
    options: { client?: string; keyEnv?: string },
  ) => unknown;
};

const AUTHS: McpManifestView["auth"][] = [
  { type: "none", required: false, allowedHeaderNames: [] },
  { type: "oauth", required: true, allowedHeaderNames: [] },
  { type: "bearer", required: true, allowedHeaderNames: [] },
  { type: "bearer", required: true, headerName: "X-Token", allowedHeaderNames: [] },
  { type: "api_key_header", required: true, allowedHeaderNames: [] },
  { type: "api_key_header", required: true, headerName: "X-Acme-Key", allowedHeaderNames: [] },
  { type: "api_key_header", required: true, headerName: "bad header\r\nx", allowedHeaderNames: [] },
  { type: "custom_headers", required: true, allowedHeaderNames: ["X-A"] },
  { type: "custom_headers", required: true, allowedHeaderNames: ["X-A", "X-B"] },
  { type: "custom_headers", required: true, headerName: "X-One", allowedHeaderNames: [] },
];

const NAMES = [
  ["com.notion/mcp", "Notion"],
  ["com.notion/mcp", "Notion MCP Server (Hosted)"],
  ["io.github.acme/mcp", "MCP Server"],
  ["io.github.beta/mcp", ""],
  ["a/b", "  Ünïcode / Tools!  "],
  ["a/b", "x".repeat(200)],
] as const;

describe("the CLI's config builder matches the website's", async () => {
  const web = (await import(WEB_MODULE)) as Web;

  it("derives the same key for the same server", () => {
    for (const [identifier, name] of NAMES) {
      assert.equal(
        mcpClientConfigKey({ identifier, name }),
        web.mcpClientConfigKey({ identifier, name }),
        `${identifier} / ${name}`,
      );
    }
  });

  it("prints the same config for every client, auth type and transport", () => {
    for (const [identifier, name] of NAMES) {
      for (const auth of AUTHS) {
        for (const transport of ["streamable_http", "sse", "http_sse_compat", "stdio"]) {
          for (const client of ["claude-code", "cursor", "generic"] as const) {
            for (const keyEnv of [undefined, "ACME_KEY"]) {
              const manifest = {
                schemaVersion: 1,
                identifier,
                name,
                version: "1",
                summary: "",
                transport,
                endpointUrl: "https://mcp.acme.dev/mcp",
                desktopOnly: false,
                webExecutable: true,
                official: false,
                verified: false,
                categories: [],
                tools: [],
                auth,
              };
              const options = { client, ...(keyEnv ? { keyEnv } : {}) };
              assert.deepEqual(
                buildMcpClientConfig(manifest, options),
                web.remoteMcpClientConfigObject(manifest, options),
                JSON.stringify({ identifier, name, auth, transport, client, keyEnv }),
              );
            }
          }
        }
      }
    }
  });
});
