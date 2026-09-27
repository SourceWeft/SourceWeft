import { logger } from "../../shared/logger";
import {
  getMarketItemForSubmission,
  upsertMarketMcp,
} from "./ingest/repository";
import { mcpServerVersionId } from "./ingest/plan";
import { parseMcpRepository } from "./parse-repository";
import { writeMcpReadmeColumns } from "./readme/readme-repository";
import { submittedReadmeColumns } from "./readme/readme-state";
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

  const identifier = parsed.manifest.identifier;
  const existing = await getMarketItemForSubmission(identifier);

  // Ownership guard: a submission may not overwrite a federated (upstream)
  // entry, nor another submitter's already-published listing. This closes the
  // catalog-takeover / install-endpoint-hijack vector where an attacker submits
  // a repo whose server.json name collides with a trusted identifier.
  if (existing?.hasUpstream) {
    throw new MarketSubmissionError(
      "MARKET_SUBMISSION_CONFLICT",
      `${identifier} is already provided by an upstream registry and cannot be overwritten by a submission.`,
    );
  }
  if (existing?.submittedBy && existing.submittedBy !== input.userId) {
    // Any state — published, under review, or rejected — belonging to a
    // different submitter is off-limits; otherwise an attacker could overwrite a
    // victim's in-review submission (which the admin then approves) or hijack a
    // published listing.
    throw new MarketSubmissionError(
      "MARKET_SUBMISSION_CONFLICT",
      `${identifier} was already submitted by another user.`,
    );
  }

  const scan = scanMcpSubmission(parsed);
  // Sticky review: a flagged submission goes to review, and an identifier that
  // is currently under review or was rejected can never auto-publish via a
  // re-submit that merely drops the risky lines — only an admin moves it out.
  const stickyReview =
    existing?.status === "reviewing" || existing?.status === "archived";
  const status: "published" | "reviewing" =
    scan.reviewRequired || stickyReview ? "reviewing" : "published";

  const github = parsed.report.github;
  await upsertMarketMcp({
    manifest: parsed.manifest,
    status,
    visibility: "public",
    origin: "submitted",
    owner: github.owner,
    provenanceJson: {
      source: "submission",
      submittedBy: input.userId,
      submittedAt: new Date().toISOString(),
      github,
      // Where the server lives, in the registry's own shape, for the README
      // fetch: the directory the submission named, "" being the root.
      repository: {
        url: github.repoUrl,
        ...(github.subpath ? { subfolder: github.subpath } : {}),
      },
      scan,
    },
  });

  // The parse already read the README at the commit it pinned: store it now
  // rather than wait for the fetch job. Without one (or with bytes that are
  // not text), the version stays `pending` and the fetch job decides.
  const readme =
    parsed.readme && github.commitSha
      ? submittedReadmeColumns(
          {
            path: parsed.readme.path,
            bytes: parsed.readme.bytes,
            ref: github.commitSha,
          },
          new Date(),
        )
      : null;
  if (readme) {
    await writeMcpReadmeColumns(
      mcpServerVersionId(parsed.manifest.identifier, parsed.manifest.version),
      readme,
    );
  }

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
