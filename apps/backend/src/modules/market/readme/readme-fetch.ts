import { logger } from "../../../shared/logger";
import {
  fetchGitHubReadme,
  parseGitHubRepoRef,
  type FetchGitHubReadmeInput,
  type GitHubReadmeResult,
} from "./github-readme";
import {
  claimMcpReadme,
  deferMcpReadmes,
  findDueMcpReadmes,
  writeMcpReadmeColumns,
  type ClaimedMcpReadme,
  type DueMcpReadme,
} from "./readme-repository";
import {
  enqueueMcpReadmeFetch,
  MCP_README_BATCH_SIZE,
  MCP_README_SCHEDULED_JOB_ID,
  mcpReadmeJobExists,
  recordMcpReadmeBatch,
  type McpReadmeBatchSummary,
  type McpReadmeFetchJobPayload,
} from "./readme-queue";
import {
  mcpReadmeEtagApplies,
  mcpReadmeSubfolder,
  mcpReadmeTransition,
  type McpReadmeColumns,
  type McpReadmeFetchOutcome,
} from "./readme-state";

/**
 * How long a version being fetched is held back from other batches. Far
 * longer than one fetch takes; a worker that dies mid-fetch only delays that
 * version by this much.
 */
export const MCP_README_CLAIM_LEASE_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Scheduler side: queue the due versions
// ---------------------------------------------------------------------------

export type ScheduleMcpReadmeDeps = {
  jobExists: (jobId: string) => Promise<boolean>;
  findDue: (input: { limit: number }) => Promise<DueMcpReadme[]>;
  enqueue: (
    payload: McpReadmeFetchJobPayload,
    jobId: string,
  ) => Promise<unknown>;
};

const defaultScheduleDeps: ScheduleMcpReadmeDeps = {
  jobExists: mcpReadmeJobExists,
  findDue: findDueMcpReadmes,
  enqueue: enqueueMcpReadmeFetch,
};

/**
 * Queue one batch of the versions whose README is due, most wanted first
 * (see `findDueMcpReadmes`). Nothing is queued while the previous batch is
 * still queued or running.
 */
export async function scheduleDueMcpReadmes(
  deps: ScheduleMcpReadmeDeps = defaultScheduleDeps,
): Promise<{ queued: number; inFlight: boolean }> {
  if (await deps.jobExists(MCP_README_SCHEDULED_JOB_ID)) {
    return { queued: 0, inFlight: true };
  }
  const due = await deps.findDue({ limit: MCP_README_BATCH_SIZE });
  if (due.length === 0) {
    return { queued: 0, inFlight: false };
  }
  await deps.enqueue(
    { versionIds: due.map((entry) => entry.versionId), reason: "scheduled" },
    MCP_README_SCHEDULED_JOB_ID,
  );
  return { queued: due.length, inFlight: false };
}

// ---------------------------------------------------------------------------
// Worker side: fetch a batch
// ---------------------------------------------------------------------------

export type FetchMcpReadmeBatchDeps = {
  claim: (input: {
    versionId: string;
    leaseUntil: Date;
    now: Date;
  }) => Promise<ClaimedMcpReadme | null>;
  write: (versionId: string, columns: McpReadmeColumns) => Promise<void>;
  defer: (input: {
    versionIds: string[];
    until: Date;
    now: Date;
  }) => Promise<number>;
  fetchReadme: (input: FetchGitHubReadmeInput) => Promise<GitHubReadmeResult>;
  record: (summary: McpReadmeBatchSummary) => Promise<void>;
  now: () => Date;
};

const defaultFetchDeps: FetchMcpReadmeBatchDeps = {
  claim: claimMcpReadme,
  write: writeMcpReadmeColumns,
  defer: deferMcpReadmes,
  fetchReadme: fetchGitHubReadme,
  record: recordMcpReadmeBatch,
  now: () => new Date(),
};

const UNSUPPORTED_MESSAGES = {
  not_github: "The repository is not on github.com",
  invalid_path: "The repository URL names no GitHub repository directory",
} as const;

/** Most registry entries for hosted servers list no repository at all. */
const NO_REPOSITORY_MESSAGE = "The server lists no repository";

async function fetchOne(
  claimed: ClaimedMcpReadme,
  deps: FetchMcpReadmeBatchDeps,
): Promise<McpReadmeFetchOutcome> {
  const repository = parseGitHubRepoRef(
    claimed.repoUrl,
    mcpReadmeSubfolder(claimed),
  );
  if ("unsupported" in repository) {
    return {
      status: "unsupported_host",
      message: claimed.repoUrl?.trim()
        ? UNSUPPORTED_MESSAGES[repository.reason]
        : NO_REPOSITORY_MESSAGE,
    };
  }
  try {
    return await deps.fetchReadme({
      owner: repository.owner,
      repo: repository.repo,
      subfolder: repository.subfolder,
      etag: mcpReadmeEtagApplies(claimed.readmeStatus)
        ? claimed.readmeEtag
        : null,
    });
  } catch (error) {
    // The client reports every GitHub failure as an outcome; anything thrown
    // is unexpected, and is recorded against the version like any failure.
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Fetch a batch of versions' READMEs from GitHub, one after another, and
 * store each outcome (see `mcpReadmeTransition`).
 *
 * GitHub's README API is the only source: without `GITHUB_TOKEN` the reads
 * are anonymous and far more limited, which is logged once per batch and
 * shown in the admin status — never worked around. A spent rate limit stops
 * the batch: the version that met it and every one after it wait for the
 * reset, with no attempt counted.
 */
export async function fetchMcpReadmeBatch(
  payload: McpReadmeFetchJobPayload,
  deps: FetchMcpReadmeBatchDeps = defaultFetchDeps,
): Promise<McpReadmeBatchSummary> {
  const startedAt = deps.now();
  const summary: McpReadmeBatchSummary = {
    reason: payload.reason,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    requested: payload.versionIds.length,
    processed: 0,
    skipped: 0,
    deferred: 0,
    outcomes: {},
    tokenPresent: null,
    rateLimitedUntil: null,
  };

  for (const [index, versionId] of payload.versionIds.entries()) {
    const now = deps.now();
    const claimed = await deps.claim({
      versionId,
      leaseUntil: new Date(now.getTime() + MCP_README_CLAIM_LEASE_MS),
      now,
    });
    if (!claimed) {
      summary.skipped += 1;
      continue;
    }

    const outcome = await fetchOne(claimed, deps);
    if ("tokenPresent" in outcome) {
      if (!outcome.tokenPresent && summary.tokenPresent !== false) {
        logger.warn(
          "MCP README fetch is reading GitHub without GITHUB_TOKEN: anonymous requests share a far smaller rate limit",
          { reason: payload.reason, requested: payload.versionIds.length },
        );
      }
      summary.tokenPresent =
        (summary.tokenPresent ?? true) && outcome.tokenPresent;
    }
    await deps.write(
      claimed.versionId,
      mcpReadmeTransition(claimed, outcome, deps.now()),
    );
    summary.processed += 1;
    summary.outcomes[outcome.status] =
      (summary.outcomes[outcome.status] ?? 0) + 1;
    if (outcome.status === "error") {
      logger.info("MCP README fetch failed", {
        identifier: claimed.identifier,
        attempts: claimed.readmeAttempts + 1,
        error: outcome.message,
      });
    }

    if (outcome.status === "rate_limited") {
      summary.rateLimitedUntil = outcome.resetAt.toISOString();
      summary.deferred = await deps.defer({
        versionIds: payload.versionIds.slice(index + 1),
        until: outcome.resetAt,
        now: deps.now(),
      });
      logger.warn("MCP README fetch stopped by GitHub's rate limit", {
        resetAt: summary.rateLimitedUntil,
        deferred: summary.deferred,
        tokenPresent: summary.tokenPresent,
      });
      break;
    }
  }

  summary.finishedAt = deps.now().toISOString();
  await deps.record(summary);
  logger.info("MCP README batch complete", { ...summary });
  return summary;
}
