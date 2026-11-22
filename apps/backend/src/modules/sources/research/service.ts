import { sql } from "drizzle-orm";
import { db } from "@sourceweft/db";
import type { AgentToolWebProvider } from "@sourceweft/contracts/agent-tools";
import { billingAdmission } from "../../../shared/model-gateway/billing/admission";
import { ContentError } from "../../content/errors";
import type { ContentBillingPort } from "../../content/billing-port";
import { requireContentWorkspace } from "../../workspace/guards";
import { workspaceService } from "../../workspace";
import { createDefaultWebProvider } from "../web-provider";
import { admitResearch, countResearchRuns } from "./admission";
import {
  enqueueResearchJob,
  type ResearchJobPayload,
} from "../../content/queue";
import {
  createRun,
  finishFailed,
  findRun,
  listRuns,
  requestCancel,
  type ResearchRunRow,
} from "./repository";
import { toResearchRun } from "./mapper";
import type { ResearchRun } from "@sourceweft/contracts/source-research";

/** The newest runs returned by the list endpoint when no limit is given. */
const LIST_RESEARCH_LIMIT = 50;

export type CreateResearchInput = {
  workspaceId: string;
  userId: string;
  topic: string;
  /**
   * The originating request id. Accepted for interface parity with the rest of
   * the content API; it is not an idempotency key here — a double-submit is
   * bounded by the per-user concurrency limit, not by this id.
   */
  requestId: string;
};

export type CreateResearchDeps = {
  billing: ContentBillingPort;
  /** Overridable for tests; production enqueues the real worker job. */
  enqueue?: (payload: ResearchJobPayload) => Promise<{ created: boolean }>;
  /** The payer's credit gate; defaults to the deployment billing admission. */
  hasCredits?: () => Promise<boolean>;
  /** The deployment web provider; defaults to the capability-supplied one. */
  getProvider?: () => Promise<AgentToolWebProvider | null>;
  /** Overridable for tests; production counts real research_runs rows. */
  countRuns?: typeof countResearchRuns;
};

export type CreateResearchResult =
  | { kind: "ok"; run: ResearchRunRow }
  | {
      kind: "limited";
      code: "CONCURRENCY_LIMIT" | "DAILY_LIMIT";
      retryAfterSeconds?: number;
    };

/**
 * Starts a deep-research run: it checks the caller still belongs to the
 * workspace, that the deployment has a web provider, and that the requester can
 * pay and is within the concurrency and daily limits, then records a queued run
 * and enqueues it. The requester pays (`createdByUserId`).
 *
 * Admission and the row insert run under a transaction-scoped advisory lock
 * keyed on the owning organization, so two simultaneous requests cannot both
 * pass the concurrency limit and each insert a run. The lock, the count and the
 * insert all run on the transaction's own connection, so nothing is serialised
 * across a second pooled connection.
 */
export async function createResearch(
  input: CreateResearchInput,
  deps: CreateResearchDeps,
): Promise<CreateResearchResult> {
  const workspace = await requireContentWorkspace(input);

  const provider = await (
    deps.getProvider ?? (() => createDefaultWebProvider())
  )();
  if (!provider) {
    throw new ContentError(
      503,
      "WEB_PROVIDER_UNAVAILABLE",
      "Web search is not available on this deployment.",
    );
  }

  const billingOrganizationId =
    await workspaceService.resolveBillingOrganizationId({
      workspaceId: workspace.id,
      userId: input.userId,
      workspaceOrganizationId: workspace.organizationId,
    });

  const hasCredits =
    deps.hasCredits ??
    (async () => {
      const decision = await billingAdmission.admit({
        billing: deps.billing,
        teamId: billingOrganizationId,
        userId: input.userId,
      });
      return decision.allowed;
    });
  const countRuns = deps.countRuns ?? countResearchRuns;

  // Credits are checked before the transaction so the billing lookup never
  // takes a second pooled connection while the advisory lock is held. It is
  // still the first check, so the 402 keeps precedence over the limits.
  if (!(await hasCredits())) {
    throw new ContentError(
      402,
      "INSUFFICIENT_CREDITS",
      "There are not enough credits to run deep research.",
    );
  }

  const outcome = await db.transaction(
    async (tx): Promise<CreateResearchResult> => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`research:${workspace.organizationId}`}, 0))`,
      );
      const admission = await admitResearch(
        {
          // Runs are stored under the workspace's organization, so the
          // concurrency and daily counts are taken against the same id.
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          userId: input.userId,
        },
        // Count on the lock-holding connection so the limit sees everything
        // committed before this lock was granted.
        {
          countRuns: (filter) => countRuns(filter, tx),
          hasCredits: async () => true,
        },
      );
      if (!admission.ok) {
        if (admission.code === "INSUFFICIENT_CREDITS") {
          throw new ContentError(
            402,
            "INSUFFICIENT_CREDITS",
            "There are not enough credits to run deep research.",
          );
        }
        return {
          kind: "limited",
          code: admission.code,
          ...(admission.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: admission.retryAfterSeconds }
            : {}),
        };
      }
      const run = await createRun(
        {
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          userId: input.userId,
          topic: input.topic,
        },
        tx,
      );
      return { kind: "ok", run };
    },
  );

  // Enqueue after the lock is released: the run is committed, so the lock is
  // not held across the queue round-trip.
  if (outcome.kind === "ok") {
    try {
      await (deps.enqueue ?? enqueueResearchJob)({
        runId: outcome.run.id,
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        userId: input.userId,
      });
    } catch (error) {
      // The run is committed but has no worker job. Left queued it would hold
      // the requester's single concurrency slot forever, so settle it as failed
      // (a terminal state frees the slot) and surface the dispatch failure to
      // the caller. No enum code denotes a queue-dispatch failure; the run's
      // generic "transient backend failure, retry" marker is MODEL_UNAVAILABLE.
      await finishFailed(outcome.run.id, "MODEL_UNAVAILABLE");
      throw error;
    }
  }
  return outcome;
}

export type CancelResearchInput = {
  workspaceId: string;
  userId: string;
  id: string;
};

/**
 * Requests cancellation of a run the caller can reach: a queued run is
 * cancelled outright, a running one is flagged for the loop to finish. Returns
 * false when the run is not found in the workspace or is already terminal.
 */
export async function cancelResearch(
  input: CancelResearchInput,
): Promise<boolean> {
  const workspace = await requireContentWorkspace(input);
  return requestCancel({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    id: input.id,
  });
}

export type GetResearchInput = {
  workspaceId: string;
  userId: string;
  id: string;
};

/**
 * Reads one run the caller can reach. Workspace access is checked first, then
 * the run is looked up scoped to that workspace, so a run in another workspace
 * is indistinguishable from one that does not exist: both are 404.
 */
export async function getResearch(
  input: GetResearchInput,
): Promise<ResearchRun> {
  const workspace = await requireContentWorkspace(input);
  const row = await findRun({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    id: input.id,
  });
  if (!row) {
    throw new ContentError(404, "RESEARCH_NOT_FOUND", "Research run not found");
  }
  return toResearchRun(row);
}

export type ListResearchInput = {
  workspaceId: string;
  userId: string;
  limit?: number;
};

/** The current workspace's runs, newest first. */
export async function listResearch(
  input: ListResearchInput,
): Promise<ResearchRun[]> {
  const workspace = await requireContentWorkspace(input);
  const rows = await listRuns({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    limit: input.limit ?? LIST_RESEARCH_LIMIT,
  });
  return rows.map(toResearchRun);
}
