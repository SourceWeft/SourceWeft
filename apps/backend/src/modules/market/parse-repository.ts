import { prepareGitHubRepository } from "./parser/github";
import { classifyMcpRepository } from "./parser/classifier";
import { mapParsedRepositoryToManifest } from "./parser/manifest-mapper";
import { parseStaticRepository } from "./parser/static-parser";
import { introspectRuntime } from "./runtime/runtime-introspect";
import type { McpIngestResult, McpRepositoryParseOptions } from "./types";

export async function parseMcpRepository(
  sourceUrl: string,
  options: McpRepositoryParseOptions,
): Promise<McpIngestResult> {
  const source = await prepareGitHubRepository(sourceUrl);
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
  const classification = await classifyMcpRepository(staticResult, {
    categories: options.categories,
    discovery: options.discovery,
    mode: options.classificationMode ?? "deepseek",
    refreshClassification: options.refreshClassification,
  });
  return mapParsedRepositoryToManifest({
    categories: options.categories,
    classification,
    discovery: options.discovery,
    mode: options.mode,
    runtime,
    staticResult,
  });
}

export type {
  DryRunIngestResult,
  McpClassificationMode,
  McpClassificationResult,
  McpIngestMode,
  McpIngestResult,
  McpParserReport,
  McpRepositoryIngestOptions,
  McpRepositoryParseOptions,
} from "./types";
