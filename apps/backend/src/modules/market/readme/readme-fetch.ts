import { logger } from "../../../shared/logger";
import { hasGitHubToken } from "../parser/github";
import {
  fetchGitHubReadmes,
  GITHUB_README_QUERY_SIZE,
  parseGitHubRepoRef,
  type GitHubReadmeBatch,
  type GitHubReadmeResult,
  type GitHubReadmeTarget,
} from "./github-readme";
import {
  claimMcpReadmes,
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
  mcpReadmeSubfolder,
  mcpReadmeTransition,
  mcpReadmeUnchanged,
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

/**
 * Groups of versions read at the same time, each one GraphQL query's worth
 * ({@link GITHUB_README_QUERY_SIZE}). Measured against the catalog, three
 * concurrent queries read a directory every ~60 ms with no secondary rate
 * limit, against ~220 ms one at a time.
 */
export const MCP_README_CONCURRENCY = 3;

/**
 * Once GitHub says fewer GraphQL points than this are left in the hour, the
 * rest of the batch waits for the reset instead of spending them, so anything
 * else asking GraphQL with the same token still has some.
 */
export const MCP_README_MIN_POINTS = 50;

export type FetchMcpReadmeBatchDeps = {
  claim: (input: {
    versionIds: string[];
    leaseUntil: Date;
    now: Date;
  }) => Promise<ClaimedMcpReadme[]>;
  write: (versionId: string, columns: McpReadmeColumns) => Promise<void>;
  defer: (input: {
    versionIds: string[];
    until: Date;
    now: Date;
  }) => Promise<number>;
  fetchReadmes: (targets: GitHubReadmeTarget[]) => Promise<GitHubReadmeBatch>;
  hasToken: () => boolean;
  record: (summary: McpReadmeBatchSummary) => Promise<void>;
  now: () => Date;
};

const defaultFetchDeps: FetchMcpReadmeBatchDeps = {
  claim: claimMcpReadmes,
  write: writeMcpReadmeColumns,
  defer: deferMcpReadmes,
  fetchReadmes: (targets) => fetchGitHubReadmes(targets),
  hasToken: hasGitHubToken,
  record: recordMcpReadmeBatch,
  now: () => new Date(),
};

const UNSUPPORTED_MESSAGES = {
  not_github: "The repository is not on github.com",
  invalid_path: "The repository URL names no GitHub repository directory",
} as const;

/** Most registry entries for hosted servers list no repository at all. */
const NO_REPOSITORY_MESSAGE = "The server lists no repository";

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/**
 * Read a batch of versions' READMEs from GitHub and store each outcome (see
 * `mcpReadmeTransition`): {@link GITHUB_README_QUERY_SIZE} versions are
 * claimed and read together, {@link MCP_README_CONCURRENCY} groups at a time.
 *
 * GitHub's GraphQL API is the only source, and it has no anonymous access:
 * without `GITHUB_TOKEN` nothing is read and nothing is written — the versions
 * stay due, and the batch says why. A token GitHub refuses stops the batch the
 * same way; the group that met it is picked up again once its lease lapses. A
 * spent rate limit (or points running low) stops the batch too: the versions
 * that met it, and every one after them, wait for the reset with no attempt
 * counted.
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
    tokenPresent: deps.hasToken(),
    rateLimitedUntil: null,
    stoppedBy: null,
    points: 0,
    pointsRemaining: null,
  };

  if (!summary.tokenPresent) {
    summary.stoppedBy = "no_token";
    logger.warn(
      "MCP README fetch read nothing: GITHUB_TOKEN is not set, and GitHub's GraphQL API has no anonymous access",
      { reason: payload.reason, requested: payload.versionIds.length },
    );
    summary.finishedAt = deps.now().toISOString();
    await deps.record(summary);
    return summary;
  }

  /** Why the batch stopped reading, and until when the rest waits. */
  const halt: {
    stop: { by: "unauthorized" | "rate_limited"; until: Date | null } | null;
  } = { stop: null };
  const notReached: string[] = [];

  const store = async (
    claimed: ClaimedMcpReadme,
    outcome: McpReadmeFetchOutcome,
  ) => {
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
  };

  const readGroup = async (versionIds: string[]) => {
    const now = deps.now();
    const rows = await deps.claim({
      versionIds,
      leaseUntil: new Date(now.getTime() + MCP_README_CLAIM_LEASE_MS),
      now,
    });
    const byId = new Map(rows.map((row) => [row.versionId, row]));
    const claimed = versionIds.flatMap((id) => byId.get(id) ?? []);
    summary.skipped += versionIds.length - claimed.length;

    const reading: Array<{
      row: ClaimedMcpReadme;
      target: GitHubReadmeTarget;
    }> = [];
    for (const row of claimed) {
      const repository = parseGitHubRepoRef(
        row.repoUrl,
        mcpReadmeSubfolder(row),
      );
      if ("unsupported" in repository) {
        await store(row, {
          status: "unsupported_host",
          message: row.repoUrl?.trim()
            ? UNSUPPORTED_MESSAGES[repository.reason]
            : NO_REPOSITORY_MESSAGE,
        });
      } else {
        reading.push({ row, target: repository });
      }
    }
    if (reading.length === 0) {
      return;
    }

    let batch: GitHubReadmeBatch;
    try {
      batch = await deps.fetchReadmes(reading.map((entry) => entry.target));
    } catch (error) {
      // The client reports every GitHub failure as a result; anything thrown
      // is unexpected, and is recorded against the versions like any failure.
      const message = error instanceof Error ? error.message : String(error);
      for (const { row } of reading) {
        await store(row, { status: "error", message });
      }
      return;
    }
    summary.points += batch.cost;
    if (batch.remaining !== null) {
      summary.pointsRemaining = batch.remaining;
    }

    for (const [index, { row }] of reading.entries()) {
      const result: GitHubReadmeResult = batch.results[index] ?? {
        status: "error",
        message: "GitHub left the README unanswered",
      };
      if (result.status === "unauthorized") {
        // Not the README's doing, and not worth an attempt: the version is
        // left as claimed, and read again once the lease lapses.
        halt.stop ??= { by: "unauthorized", until: null };
        if (!summary.outcomes.unauthorized) {
          logger.error("MCP README fetch stopped: GitHub refused the token", {
            error: result.message,
          });
        }
        summary.outcomes.unauthorized =
          (summary.outcomes.unauthorized ?? 0) + 1;
        continue;
      }
      if (result.status === "rate_limited") {
        halt.stop = { by: "rate_limited", until: result.resetAt };
      }
      await store(
        row,
        mcpReadmeUnchanged(row, result) ? { status: "not_modified" } : result,
      );
    }

    if (
      !halt.stop &&
      batch.remaining !== null &&
      batch.remaining < MCP_README_MIN_POINTS
    ) {
      halt.stop = {
        by: "rate_limited",
        until: batch.resetAt ?? new Date(deps.now().getTime() + 60 * 60 * 1000),
      };
    }
  };

  const groups = chunk(payload.versionIds, GITHUB_README_QUERY_SIZE);
  let next = 0;
  await Promise.all(
    Array.from({ length: MCP_README_CONCURRENCY }, async () => {
      while (next < groups.length) {
        const group = groups[next++]!;
        if (halt.stop) {
          notReached.push(...group);
          continue;
        }
        await readGroup(group);
      }
    }),
  );

  const { stop } = halt;
  if (stop) {
    summary.stoppedBy = stop.by;
    if (stop.until) {
      summary.rateLimitedUntil = stop.until.toISOString();
      summary.deferred = await deps.defer({
        versionIds: notReached,
        until: stop.until,
        now: deps.now(),
      });
    }
    logger.warn("MCP README fetch stopped early", {
      stoppedBy: stop.by,
      rateLimitedUntil: summary.rateLimitedUntil,
      deferred: summary.deferred,
      notReached: notReached.length,
      pointsRemaining: summary.pointsRemaining,
    });
  }

  summary.finishedAt = deps.now().toISOString();
  await deps.record(summary);
  logger.info("MCP README batch complete", { ...summary });
  return summary;
}
