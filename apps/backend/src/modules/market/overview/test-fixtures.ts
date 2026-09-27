import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  marketMcpManifestSchema,
  type MarketMcpManifest,
} from "@sourceweft/market-contracts";
import type { RegistryServerJson } from "../types";
import type { McpOverviewReadmeSource, McpOverviewSource } from "./input";

/**
 * Two real MCP Registry entries for the overview tests: their registry
 * `server.json` as registry.modelcontextprotocol.io served it on 2026-09-28,
 * the manifest registry federation stores for it (the fields
 * `mapRegistryServerToManifest` sets), and a trimmed copy of the README
 * (both MIT-licensed; notices kept in the fixture files).
 */

export function readmeFixture(file: string): McpOverviewReadmeSource {
  const markdown = readFileSync(
    new URL(`./fixtures/${file}`, import.meta.url),
    "utf8",
  );
  return {
    markdown,
    sha256: createHash("sha256").update(markdown).digest("hex"),
  };
}

// Remote streamable HTTP, no authentication.
export const carrerliftRegistryServer: RegistryServerJson = {
  $schema:
    "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: "io.github.prakhar1605/carrerlift",
  description:
    "Search fresh Indian jobs and internships, plus international intern and new-grad roles.",
  title: "Carrerlift",
  repository: {
    url: "https://github.com/prakhar1605/carrerlift-mcp",
    source: "github",
  },
  version: "1.0.0",
  websiteUrl: "https://www.carrerlift.in",
  remotes: [
    { type: "streamable-http", url: "https://www.carrerlift.in/api/mcp" },
  ],
};

// A local stdio npm package whose settings include a wallet's private key.
// Version 0.2.0, the release that shipped only the package (later versions
// add a hosted remote).
export const genesis402RegistryServer: RegistryServerJson = {
  $schema:
    "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: "io.github.FTHTrading/genesis402-mcp",
  description:
    "179 x402 pay-per-call APIs: OpenAI-style chat, embeddings, web extract, wallet/token briefs",
  title: "Genesis402 (x402 pay-per-call)",
  repository: {
    url: "https://github.com/FTHTrading/genesis402-agent-kit",
    source: "github",
    subfolder: "mcp",
  },
  version: "0.2.0",
  websiteUrl: "https://twin.unykorn.org/catalog",
  packages: [
    {
      registryType: "npm",
      identifier: "genesis402-mcp",
      version: "0.2.0",
      transport: { type: "stdio" },
      environmentVariables: [
        {
          description:
            "Set to 1 to allow paying. Unset = quote-only, nothing is signed.",
          name: "GENESIS402_LIVE",
        },
        {
          description:
            "Private key of a Base wallet holding USDC, used only when GENESIS402_LIVE=1.",
          isSecret: true,
          name: "GENESIS402_PAYER_KEY",
        },
        {
          description: "Refuse any quote above this many USD (default 0.25).",
          name: "GENESIS402_MAX_USD",
        },
      ],
    },
  ],
};

/** The manifest federation stores for a registry entry. */
export function federatedManifest(
  server: RegistryServerJson,
): MarketMcpManifest {
  const remote = server.remotes?.[0];
  const hasRemote = Boolean(remote?.url);
  const identifier = server.name!;
  return marketMcpManifestSchema.parse({
    schemaVersion: 1,
    identifier,
    version: server.version,
    name: server.title,
    summary: server.description,
    description: server.description,
    providerName: identifier.split("/")[0],
    homepageUrl: server.websiteUrl,
    transport: hasRemote
      ? remote?.type === "sse"
        ? "sse"
        : "streamable_http"
      : "stdio",
    endpointUrl: hasRemote ? remote?.url : undefined,
    desktopOnly: !hasRemote,
    webExecutable: hasRemote,
    official: false,
    verified: true,
    auth: { type: "none", required: false, allowedHeaderNames: [] },
    categories: [],
    tools: [],
    sourceUrl: server.repository?.url,
    repoUrl: server.repository?.url,
  });
}

export function carrerliftSource(): McpOverviewSource {
  return {
    manifest: federatedManifest(carrerliftRegistryServer),
    registryDescription: carrerliftRegistryServer.description,
    readme: readmeFixture("carrerlift-readme.md"),
    registryServer: carrerliftRegistryServer,
  };
}

export function genesis402Source(): McpOverviewSource {
  return {
    manifest: federatedManifest(genesis402RegistryServer),
    registryDescription: genesis402RegistryServer.description,
    readme: readmeFixture("genesis402-mcp-readme.md"),
    registryServer: genesis402RegistryServer,
  };
}
