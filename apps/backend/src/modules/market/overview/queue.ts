import {
  createOverviewJobs,
  enqueueOverviewBatch,
  type OverviewJobPayload,
} from "../../catalog-overview/jobs";
import {
  getSystemModelReadiness,
  type SystemModelReadiness,
} from "../../../shared/model-gateway/system-client";
import {
  findMcpOverviewAttempts,
  findNewMcpOverviewCandidates,
  mcpOverviewStore,
  type McpOverviewAttemptRow,
  type McpOverviewCandidateRow,
} from "./repository";
import { needsMcpOverviewRetry } from "./source";

/**
 * The MCP AI overview job (`mcp-overview-generate`) on the primary queue, one
 * per request; the worker's handler is
 * `worker/processors/mcp-overview-generate.ts`. Reservation, dedup, retries
 * and recovery are the catalog overview engine's (`jobs.ts`). The scheduler
 * calls `enqueueMcpOverviews` on its own interval
 * (`scheduler/schedules/mcp-overview.ts`).
 */

export const MCP_OVERVIEW_GENERATE_JOB = "mcp-overview-generate";

// A few tries, spaced out: a gateway hiccup or a malformed answer is usually
// gone a minute later. After the last one the request is failed, and the
// scheduler leaves it until the README is read again (`source.ts`).
export const MCP_OVERVIEW_JOB_ATTEMPTS = 3;
const MCP_OVERVIEW_BACKOFF_MS = 60_000;

// Jobs queued per tick unless the tick says otherwise (the scheduler passes
// `MCP_OVERVIEW_BATCH_SIZE`): a large catalog is worked through over time
// rather than in one burst on the system model.
export const MCP_OVERVIEW_BATCH_SIZE = 20;
// Never-analysed versions looked at per tick, most wanted first; at least a
// batch, so a larger batch is never short of candidates.
const MCP_OVERVIEW_SCAN_LIMIT = 200;
// Analysed versions checked per tick for a stale overview or a failure worth
// another try: a window that moves through the catalog by version id, so the
// whole catalog is checked every (catalog size / this) ticks.
export const MCP_OVERVIEW_ROTATION_WINDOW = 500;

// `mcpServerVersionId` is what the processor reads — the row is the source of
// truth. `mcpServerId` lets the job audit trail attribute the job.
export type McpOverviewGenerateJobPayload = OverviewJobPayload<
  "mcpServerVersionId",
  "mcpServerId"
>;

export const mcpOverviewJobs = createOverviewJobs(
  {
    name: MCP_OVERVIEW_GENERATE_JOB,
    versionKey: "mcpServerVersionId",
    parentKey: "mcpServerId",
    attempts: MCP_OVERVIEW_JOB_ATTEMPTS,
    backoffMs: MCP_OVERVIEW_BACKOFF_MS,
    scopePrefix: "mcp-overview",
    label: "MCP",
  },
  mcpOverviewStore,
);

export async function enqueueMcpOverviewJob(
  payload: McpOverviewGenerateJobPayload,
) {
  return mcpOverviewJobs.enqueue(payload);
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

type Candidate = McpOverviewCandidateRow & { attempted: boolean };

export type McpOverviewCandidateScan = {
  candidates: Candidate[];
  // Where the next window of the rotating check starts ("" = the start).
  next: string;
};

export type FindMcpOverviewCandidatesDeps = {
  findNew: (limit: number) => Promise<McpOverviewCandidateRow[]>;
  findAttempts: (input: {
    after: string;
    limit: number;
  }) => Promise<McpOverviewAttemptRow[]>;
};

const defaultFindDeps: FindMcpOverviewCandidatesDeps = {
  findNew: (limit) => findNewMcpOverviewCandidates({ limit }),
  findAttempts: (input) => findMcpOverviewAttempts(input),
};

/**
 * The versions that need an overview for their current input, in the order
 * they are queued: servers some workspace installed first, then ones that
 * run on the web, then the rest.
 *
 * - Never analysed: published, public, latest, with a settled README
 *   (`readme_status` not `pending` — a README fetch that settles makes the
 *   version a candidate on the next tick).
 * - Analysed, from one window of a rotating check: a published overview
 *   whose input fingerprint is no longer the version's, or a failure worth
 *   another try (`needsMcpOverviewRetry`). These are forced: the request that
 *   produced the current state has to be replaced.
 */
export async function findMcpOverviewCandidates(
  input: {
    limit: number;
    after: string;
    window?: number;
    batchSize?: number;
  },
  deps: FindMcpOverviewCandidatesDeps = defaultFindDeps,
): Promise<McpOverviewCandidateScan> {
  const window = input.window ?? MCP_OVERVIEW_ROTATION_WINDOW;
  const batchSize = input.batchSize ?? MCP_OVERVIEW_BATCH_SIZE;
  const [fresh, attempts] = await Promise.all([
    deps.findNew(input.limit),
    deps.findAttempts({ after: input.after, limit: window }),
  ]);
  const stale = attempts.filter(needsMcpOverviewRetry);
  const candidates: Candidate[] = [
    ...fresh.map((row) => ({ ...row, attempted: false })),
    ...stale.map((row) => ({
      versionId: row.versionId,
      serverId: row.serverId,
      installed: row.installed,
      webExecutable: row.webExecutable,
      attempted: true,
    })),
  ];
  // Stable: within a rank, never-analysed first, then the query's order.
  const rank = (candidate: Candidate) =>
    (candidate.installed ? 0 : 2) + (candidate.webExecutable ? 0 : 1);
  candidates.sort((a, b) => rank(a) - rank(b));
  // The window stays put while it holds stale versions this tick may not get
  // to (the queued ones have a request in flight and drop out of it); else it
  // moves on, and starts over after the last version.
  const next =
    stale.length > 0 && candidates.length > batchSize
      ? input.after
      : attempts.length < window
        ? ""
        : (attempts.at(-1)?.versionId ?? "");
  return { candidates, next };
}

export type EnqueueMcpOverviewsDeps = {
  readModelReadiness: () => Promise<
    Pick<SystemModelReadiness, "ready" | "reason">
  >;
  findCandidates: (input: {
    limit: number;
    after: string;
    batchSize: number;
  }) => Promise<McpOverviewCandidateScan>;
  jobExists: (jobId: string) => Promise<boolean>;
  recover?: () => Promise<number>;
  enqueue: (payload: McpOverviewGenerateJobPayload) => Promise<unknown>;
};

const defaultDeps: EnqueueMcpOverviewsDeps = {
  readModelReadiness: getSystemModelReadiness,
  findCandidates: (input) => findMcpOverviewCandidates(input),
  jobExists: (jobId) => mcpOverviewJobs.exists(jobId),
  recover: () => mcpOverviewJobs.recover(),
  enqueue: (payload) => enqueueMcpOverviewJob(payload),
};

// Where the rotating check stands. The scheduler is one long-lived process;
// after a restart the check simply starts over.
const rotation = { after: "" };

/**
 * One scheduler tick: nothing while the system model is not ready; else up
 * to a batch (`pace.batchSize`, `MCP_OVERVIEW_BATCH_SIZE` when not given) of
 * versions from `findMcpOverviewCandidates` are queued, through the engine's
 * `enqueueOverviewBatch`. The candidate scan reads at least a batch.
 */
export async function enqueueMcpOverviews(
  deps: EnqueueMcpOverviewsDeps = defaultDeps,
  state: { after: string } = rotation,
  pace: { batchSize?: number } = {},
): Promise<{ queued: number; skipped: number }> {
  const batchSize = pace.batchSize ?? MCP_OVERVIEW_BATCH_SIZE;
  return enqueueOverviewBatch(
    {
      readModelReadiness: deps.readModelReadiness,
      recover: deps.recover,
      findCandidates: async (limit) => {
        const scan = await deps.findCandidates({
          limit,
          after: state.after,
          batchSize,
        });
        state.after = scan.next;
        return scan.candidates.map((candidate) => ({
          versionId: candidate.versionId,
          payload: {
            mcpServerVersionId: candidate.versionId,
            mcpServerId: candidate.serverId,
            reason: candidate.attempted
              ? ("regenerate" as const)
              : ("scheduled" as const),
          },
        }));
      },
      jobExists: deps.jobExists,
      enqueue: deps.enqueue,
    },
    {
      jobId: (versionId) => mcpOverviewJobs.jobId(versionId),
      batchSize,
      scanLimit: Math.max(MCP_OVERVIEW_SCAN_LIMIT, batchSize),
      label: "MCP",
    },
  );
}
