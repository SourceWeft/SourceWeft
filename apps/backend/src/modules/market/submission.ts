import { logger } from "../../shared/logger";
import { upsertMarketMcp } from "./ingest/repository";
import { parseMcpRepository } from "./parse-repository";
import { scanMcpSubmission } from "./scan";

export class MarketSubmissionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MarketSubmissionError";
    this.code = code;
  }
}

export type SubmissionResult = {
  identifier: string;
  version: string;
  status: "published" | "reviewing";
  flags: string[];
};

/**
 * Handle a user-submitted GitHub MCP repository: parse it, run the safety scan,
 * and auto-triage — clean submissions publish immediately, flagged ones enter
 * the review queue. This is the submission counterpart to registry federation;
 * both feed the same catalog (origin=submitted here).
 */
export async function submitMcpFromGitHub(input: {
  repoUrl: string;
  userId: string;
}): Promise<SubmissionResult> {
  let parsed;
  try {
    parsed = await parseMcpRepository(input.repoUrl, { mode: "static" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MarketSubmissionError(
      "MARKET_SUBMISSION_NOT_MCP",
      `Could not parse an MCP server from ${input.repoUrl}: ${message}`,
    );
  }

  const scan = scanMcpSubmission(parsed);
  const status: "published" | "reviewing" = scan.reviewRequired
    ? "reviewing"
    : "published";

  await upsertMarketMcp({
    manifest: parsed.manifest,
    status,
    visibility: "public",
    origin: "submitted",
    owner: parsed.report.github.owner,
    provenanceJson: {
      source: "submission",
      submittedBy: input.userId,
      submittedAt: new Date().toISOString(),
      github: parsed.report.github,
      scan,
    },
  });

  logger.info("MCP submission processed", {
    identifier: parsed.manifest.identifier,
    status,
    flags: scan.flags,
    submittedBy: input.userId,
  });

  return {
    identifier: parsed.manifest.identifier,
    version: parsed.manifest.version,
    status,
    flags: scan.flags,
  };
}
