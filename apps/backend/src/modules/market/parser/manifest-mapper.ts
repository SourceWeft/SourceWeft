import {
  marketMcpManifestSchema,
  type MarketMcpAuthRequirement,
  type MarketMcpManifest,
} from "@sourceweft/market-contracts";
import type {
  McpClassificationResult,
  ConnectionCandidate,
  McpIngestMode,
  McpIngestResult,
  ParsedTool,
  RuntimeIntrospectionResult,
  StaticParseResult,
} from "../types";

function displayNameFromRepo(repo: string, subpath: string) {
  const source = subpath ? subpath.split("/").at(-1) || repo : repo;
  return source
    .replace(/^server-/, "")
    .replace(/^mcp-server-/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function fallbackIdentifier(parsed: StaticParseResult) {
  const suffix = parsed.source.subpath
    ? `/${parsed.source.subpath.split("/").filter(Boolean).join("-")}`
    : `/${parsed.source.repo}`;
  return `io.github.${parsed.source.owner}${suffix}`;
}

function usableVersion(
  value: string | undefined,
  commitSha: string | undefined,
) {
  if (value && !value.includes("${") && value !== "latest") {
    return value;
  }
  return commitSha ? `0.0.0-${commitSha.slice(0, 12)}` : "0.0.0";
}

function chooseConnection(connections: ConnectionCandidate[]) {
  return (
    connections.find(
      (connection) => connection.transport === "streamable_http",
    ) ??
    connections.find((connection) => connection.transport === "sse") ??
    connections.find((connection) => connection.transport === "stdio") ??
    connections[0]
  );
}

function authFromConnection(
  connection: ConnectionCandidate | undefined,
): MarketMcpAuthRequirement {
  const headers = connection?.headerNames ?? [];
  const requiredSecrets = connection?.requiredSecrets ?? [];
  if (
    !connection ||
    (!connection.authRequired &&
      headers.length === 0 &&
      requiredSecrets.length === 0)
  ) {
    return { type: "none", required: false, allowedHeaderNames: [] };
  }

  const authorizationHeader = headers.find((header) =>
    /^authorization$/i.test(header),
  );
  if (authorizationHeader) {
    return {
      type: "bearer",
      required: true,
      headerName: authorizationHeader,
      displayName: "Authorization token",
      allowedHeaderNames: headers,
    };
  }

  const firstHeader = headers[0];
  if (firstHeader) {
    return {
      type: headers.length === 1 ? "api_key_header" : "custom_headers",
      required: true,
      headerName: headers.length === 1 ? firstHeader : undefined,
      displayName: headers.length === 1 ? firstHeader : "Custom headers",
      allowedHeaderNames: headers,
    };
  }

  return {
    type: "custom_headers",
    required: true,
    displayName: "Runtime configuration",
    instructions: `Required secrets: ${requiredSecrets.join(", ")}`,
    allowedHeaderNames: [],
  };
}

function mergeTools(input: {
  readmeTools: ParsedTool[];
  runtimeTools: ParsedTool[];
  sourceTools: ParsedTool[];
}) {
  const byName = new Map<string, ParsedTool>();
  const schemaWeight = (tool: ParsedTool) => {
    const properties = tool.inputSchema?.properties;
    return properties && typeof properties === "object"
      ? Object.keys(properties).length
      : Object.keys(tool.inputSchema ?? {}).length;
  };
  for (const tool of [
    ...input.readmeTools,
    ...input.sourceTools,
    ...input.runtimeTools,
  ]) {
    const existing = byName.get(tool.name);
    if (
      !existing ||
      schemaWeight(existing) < schemaWeight(tool) ||
      (schemaWeight(existing) === schemaWeight(tool) &&
        existing.confidence <= tool.confidence)
    ) {
      byName.set(tool.name, tool);
    }
  }
  return [...byName.values()].map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    risk: tool.risk,
  }));
}

function summarizeRisk(input: {
  auth: MarketMcpAuthRequirement;
  runtime: RuntimeIntrospectionResult;
  tools: Array<{ risk?: string }>;
}) {
  const destructive = input.tools.filter(
    (tool) => tool.risk === "destructive",
  ).length;
  const write = input.tools.filter((tool) => tool.risk === "write").length;
  const parts = [`Parsed ${input.tools.length} tools`];
  if (write > 0) {
    parts.push(`${write} write-capable`);
  }
  if (destructive > 0) {
    parts.push(`${destructive} destructive`);
  }
  if (input.auth.required) {
    parts.push("requires user-provided credentials");
  }
  if (input.runtime.skippedReason) {
    parts.push(`runtime introspection skipped: ${input.runtime.skippedReason}`);
  }
  return `${parts.join("; ")}. Review provenance before publishing broadly.`;
}

function summarizeServerJson(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const serverJson = value as Record<string, unknown>;
  return {
    name: serverJson.name,
    title: serverJson.title,
    version: serverJson.version,
    hasPackages: Array.isArray(serverJson.packages),
    hasRemotes: Array.isArray(serverJson.remotes),
    repository: serverJson.repository,
  };
}

function iconUrlFromServerJson(icons: unknown[] | undefined) {
  for (const icon of icons ?? []) {
    if (!icon || typeof icon !== "object") continue;
    const src = (icon as { src?: unknown }).src;
    if (typeof src !== "string") continue;
    try {
      const url = new URL(src);
      if (url.protocol === "https:") {
        return url.toString();
      }
    } catch {
      // Ignore malformed server.json icon entries.
    }
  }
  return undefined;
}

export function mapParsedRepositoryToManifest(input: {
  categories?: string[];
  classification: McpClassificationResult;
  discovery?: {
    confidence?: number;
    marketPageUrl?: string;
    rule?: string;
    sourceMarket?: string;
  };
  mode: McpIngestMode;
  runtime: RuntimeIntrospectionResult;
  staticResult: StaticParseResult;
}): McpIngestResult {
  const parsed = input.staticResult;
  const serverJson = parsed.serverJson?.content;
  const connection = chooseConnection(parsed.connections);
  const auth = authFromConnection(connection);
  const tools = mergeTools({
    readmeTools: parsed.readme?.tools ?? [],
    runtimeTools: input.runtime.tools,
    sourceTools: parsed.sourceTools,
  });
  // Identity must be stable across runs so upserts update rather than
  // duplicate. Prefer the declared server.json name, else derive from the
  // GitHub source. The heuristic README-parsed name is dropped from the chain
  // because it varies between parses and produces duplicate rows.
  const identifier = serverJson?.name ?? fallbackIdentifier(parsed);
  const name =
    serverJson?.title ??
    displayNameFromRepo(parsed.source.repo, parsed.source.subpath);
  const summary =
    serverJson?.description ??
    parsed.readme?.summary ??
    `MCP server parsed from ${parsed.source.owner}/${parsed.source.repo}.`;

  const manifestCandidate: MarketMcpManifest = {
    schemaVersion: 1,
    identifier,
    version: usableVersion(serverJson?.version, parsed.source.commitSha),
    name,
    summary,
    description: parsed.readme?.summary ?? serverJson?.description,
    providerName: parsed.source.owner,
    homepageUrl: serverJson?.websiteUrl,
    iconUrl: iconUrlFromServerJson(serverJson?.icons),
    license:
      parsed.packageHints
        .map((hint) => hint.license)
        .find((value): value is string => typeof value === "string") ??
      undefined,
    language:
      parsed.packageHints
        .map((hint) => hint.language)
        .find((value): value is string => typeof value === "string") ??
      undefined,
    transport: connection?.transport ?? "stdio",
    endpointUrl:
      connection?.transport === "streamable_http" ||
      connection?.transport === "sse"
        ? connection.endpointUrl
        : undefined,
    desktopOnly: !connection || connection.transport === "stdio",
    webExecutable: Boolean(connection && connection.transport !== "stdio"),
    official: ["github", "modelcontextprotocol"].includes(
      parsed.source.owner.toLowerCase(),
    ),
    verified: false,
    auth,
    categories: input.classification.categories,
    tools,
    riskSummary: summarizeRisk({ auth, runtime: input.runtime, tools }),
    sourceUrl: parsed.source.sourceUrl,
    repoUrl: parsed.source.repoUrl,
    lastIndexedAt: new Date().toISOString(),
  };

  const manifest = marketMcpManifestSchema.parse(manifestCandidate);
  return {
    manifest,
    report: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode: input.mode,
      github: {
        owner: parsed.source.owner,
        repo: parsed.source.repo,
        ref: parsed.source.resolvedRef,
        subpath: parsed.source.subpath,
        repoUrl: parsed.source.repoUrl,
        sourceUrl: parsed.source.sourceUrl,
        commitSha: parsed.source.commitSha,
      },
      market: input.discovery,
      serverJson: summarizeServerJson(serverJson),
      static: {
        mcpAssessment: parsed.mcpAssessment,
        readmePath: parsed.readme?.path,
        sourceToolCount: parsed.sourceTools.length,
        warnings: parsed.warnings,
      },
      runtime: {
        toolsCount: input.runtime.tools.length,
        promptsCount: input.runtime.prompts?.length,
        resourcesCount: input.runtime.resources?.length,
        skippedReason: input.runtime.skippedReason,
        warnings: input.runtime.warnings,
      },
      connections: parsed.connections,
      installCommands: parsed.readme?.installCommands ?? [],
      classification: input.classification,
      packageHints: parsed.packageHints,
      evidence: [...parsed.evidence, ...input.runtime.evidence],
    },
  };
}
