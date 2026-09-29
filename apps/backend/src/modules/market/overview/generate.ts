import type {
  McpAnalysisClassification,
  CatalogOverviewJson,
} from "@sourceweft/db";
import type { McpReadmeStatus } from "@sourceweft/market-contracts";
import { generateOverview } from "../../catalog-overview/generate";
import type {
  OverviewGenerateResult,
  OverviewModelCall,
  OverviewSubject,
  OverviewSubjectAdapter,
} from "../../catalog-overview/types";
import { shouldSkipMcpOverview, type McpOverviewInput } from "./input";
import {
  MCP_OVERVIEW_OUTPUT_JSON_SCHEMA,
  MCP_OVERVIEW_OUTPUT_NAME,
  MCP_OVERVIEW_PROMPT_VERSION,
  MCP_OVERVIEW_TAXONOMY_VERSION,
  buildMcpOverviewPrompt,
  parseMcpOverviewOutput,
  type McpOverviewJson,
  type McpOverviewPrompt,
} from "./prompt";
import { findMcpOverviewSubjectRow, mcpOverviewStore } from "./repository";
import { mcpOverviewInputOf } from "./source";

/**
 * Writing one MCP server version's AI overview (design §4.3): the manifest
 * facts, the registry description and the usage-related parts of the README
 * in; three independently written locales and one evidence-backed
 * classification out, published atomically. Platform work: billed to no team
 * (see shared/model-gateway/system-client.ts).
 *
 * The pipeline is the catalog overview engine's (modules/catalog-overview);
 * this is the MCP kind's adapter to it.
 */

// Three locales of five short fields plus up to three cited categories: a
// quarter more than a skill's overview (skills/market/overview-generate.ts),
// and nothing hidden is spent first, since thinking is off.
export const MCP_OVERVIEW_MAX_OUTPUT_TOKENS = 6_000;

const MCP_OVERVIEW_OUTPUT_DESCRIPTION =
  "A catalog overview of the MCP server in English, Simplified Chinese and Taiwan Traditional Chinese, plus one classification citing numbered passages as evidence.";

/** Why a claimed version gets no overview, besides the engine's reasons. */
export type McpOverviewSkipReason =
  // Not public, not published, or not the server's latest version.
  | "not-eligible"
  // Its README has not been read yet; the scheduler waits for it.
  | "readme-pending"
  // The stored manifest no longer parses.
  | "invalid-manifest"
  // No usable README and a description too short to say what it does, or
  // no passage in the input to cite as evidence.
  | "no-content";

export type McpOverviewSubject = OverviewSubject & {
  serverId: string;
  identifier: string;
  version: string;
  readmeStatus: McpReadmeStatus;
  // Null when the stored manifest no longer parses.
  input: McpOverviewInput | null;
};

/** A version as the engine sees it; null when there is no such version. */
export async function loadMcpOverviewSubject(
  versionId: string,
): Promise<McpOverviewSubject | null> {
  const row = await findMcpOverviewSubjectRow(versionId);
  if (!row) return null;
  const input = mcpOverviewInputOf(row);
  return {
    versionId: row.versionId,
    serverId: row.serverId,
    identifier: row.identifier,
    version: row.version,
    eligible: row.eligible,
    readmeStatus: row.readmeStatus,
    input,
    fingerprint: input?.inputSha256 ?? "",
  };
}

/** Why this version has nothing to describe yet; null when it has. */
export function mcpOverviewSkipReason(
  subject: McpOverviewSubject,
): McpOverviewSkipReason | null {
  if (!subject.eligible) return "not-eligible";
  // A README may still arrive: an overview written from the description
  // alone would be replaced as soon as it does.
  if (subject.readmeStatus === "pending") return "readme-pending";
  if (!subject.input) return "invalid-manifest";
  if (shouldSkipMcpOverview(subject.input)) return "no-content";
  return null;
}

/** The shared overview shape: `cautions` is null when there are none. */
function catalogOverview(overview: McpOverviewJson): CatalogOverviewJson {
  return { ...overview, cautions: overview.cautions ?? null };
}

/** The MCP kind: manifest facts, description and README in, the MCP tables out. */
export const mcpOverviewAdapter: OverviewSubjectAdapter<
  McpOverviewSubject,
  McpOverviewPrompt,
  McpAnalysisClassification,
  McpOverviewSkipReason
> = {
  kind: "mcp",
  label: "MCP",
  purpose: "mcp_market.overview",
  subjectRef: (versionId) => `mcp-server-version:${versionId}`,
  output: {
    name: MCP_OVERVIEW_OUTPUT_NAME,
    description: MCP_OVERVIEW_OUTPUT_DESCRIPTION,
    schema: MCP_OVERVIEW_OUTPUT_JSON_SCHEMA,
    maxTokens: MCP_OVERVIEW_MAX_OUTPUT_TOKENS,
  },
  loadSubject: loadMcpOverviewSubject,
  skipReason: mcpOverviewSkipReason,
  buildPrompt(subject) {
    // skipReason ran first: the input is there.
    return buildMcpOverviewPrompt(subject.input!);
  },
  parseOutput(raw, subject, prompt) {
    // Evidence IDs resolve against the passages this prompt numbered.
    const parsed = parseMcpOverviewOutput(raw, subject.input!, prompt.passages);
    return {
      overviews: {
        en: catalogOverview(parsed.en),
        "zh-CN": catalogOverview(parsed["zh-CN"]),
        "zh-TW": catalogOverview(parsed["zh-TW"]),
      },
      // The parser only returns a classification whose every category is in
      // the taxonomy and cites a passage of the input, so it is ready to
      // apply.
      classification: {
        status: "ready",
        categories: parsed.classification.categories,
        rationale: parsed.classification.rationale,
      },
    };
  },
  logFields: (subject) => ({
    mcpServerId: subject.serverId,
    mcpServerVersionId: subject.versionId,
    identifier: subject.identifier,
    readme: subject.input?.readme ? "ok" : subject.readmeStatus,
    truncated: subject.input?.readme?.truncated ?? false,
    promptVersion: MCP_OVERVIEW_PROMPT_VERSION,
    taxonomyVersion: MCP_OVERVIEW_TAXONOMY_VERSION,
  }),
  store: mcpOverviewStore,
};

export type GenerateMcpOverviewResult =
  OverviewGenerateResult<McpOverviewSkipReason>;

/**
 * Writes one version's overviews unless there is nothing to do: the version
 * is gone or not the one the catalog shows, its README is still pending, it
 * has nothing to describe, the request is stale or done, or the system model
 * is not ready. Throws on a model or output failure, for the job to retry.
 */
export async function generateMcpOverview(input: {
  versionId: string;
  scopeId: string;
  // The system model under `mcp_market.overview` unless given (tests).
  callModel?: OverviewModelCall<McpOverviewPrompt>;
  modelReady?: () => Promise<boolean>;
  requestId?: string;
  force?: boolean;
  modelConfigurationKey?: string;
}): Promise<GenerateMcpOverviewResult> {
  return generateOverview(mcpOverviewAdapter, input);
}
