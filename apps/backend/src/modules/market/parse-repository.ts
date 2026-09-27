import path from "node:path";
import {
  readGitHubRepository,
  type ReadGitHubRepository,
} from "./parser/repo-tree";
import { inferMcpCategories, mcpTaxonomyVersion } from "./parser/categories";
import { mapParsedRepositoryToManifest } from "./parser/manifest-mapper";
import { parseStaticRepository } from "./parser/static-parser";
import { registryServerProvenance } from "./registry-server";
import { introspectRuntime } from "./runtime/runtime-introspect";
import type {
  McpClassificationResult,
  McpIngestReadme,
  McpIngestResult,
  McpRepositoryParseOptions,
  StaticParseResult,
} from "./types";

/** The README the static parse chose, with its bytes and repository path. */
function readmeOf(
  source: ReadGitHubRepository,
  staticResult: StaticParseResult,
): McpIngestReadme | undefined {
  if (!staticResult.readme) {
    return undefined;
  }
  const file = path.posix.join(source.workDir, staticResult.readme.path);
  const bytes = source.tree.readBytes(file);
  return bytes
    ? { path: path.posix.relative(source.rootDir, file), bytes }
    : undefined;
}

/**
 * A submission is filed under the keyword rules. No model is asked here: the
 * AI categories arrive with the server's AI overview (`overview/`), written
 * on the system model once the version is published and its README read.
 */
function classifyByRules(
  staticResult: StaticParseResult,
  categories: string[],
): McpClassificationResult {
  return {
    categories: inferMcpCategories(staticResult, categories),
    method: "rules",
    taxonomyVersion: mcpTaxonomyVersion,
  };
}

export async function parseMcpRepository(
  sourceUrl: string,
  options: McpRepositoryParseOptions,
): Promise<McpIngestResult> {
  // Read-only ingest: the repository is held as an in-memory tree, never
  // extracted to the host filesystem, so there is no temp dir to clean up.
  const source = await readGitHubRepository(sourceUrl);
  const staticResult = await parseStaticRepository(source);
  if (!staticResult.mcpAssessment.isMcp) {
    throw new Error(
      `Repository is not an MCP server: ${staticResult.mcpAssessment.reasons.join("; ")}`,
    );
  }
  const runtime =
    options.mode === "mixed"
      ? await introspectRuntime(staticResult)
      : {
          evidence: [],
          skippedReason: "Static mode requested",
          tools: [],
          warnings: [],
        };
  const classification = classifyByRules(
    staticResult,
    options.categories ?? [],
  );
  const readme = readmeOf(source, staticResult);
  const registryServer = registryServerProvenance(
    staticResult.serverJson?.content,
  );
  return {
    ...mapParsedRepositoryToManifest({
      categories: options.categories,
      classification,
      discovery: options.discovery,
      mode: options.mode,
      runtime,
      staticResult,
    }),
    ...(readme ? { readme } : {}),
    ...(registryServer ? { registryServer } : {}),
  };
}

export type {
  DryRunIngestResult,
  McpIngestReadme,
  McpClassificationResult,
  McpIngestMode,
  McpIngestResult,
  McpParserReport,
  McpRepositoryIngestOptions,
  McpRepositoryParseOptions,
} from "./types";
