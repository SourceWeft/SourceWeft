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
  requestCancel,
  type ResearchRunRow,
} from "./repository";

export type CreateResearchInput = {
  workspaceId: string;
  userId: string;
  topic: string;
  requestId: string;
};

export type CreateResearchDeps = {
  billing: ContentBillingPort;
  /** Overridable for tests; production enqueues the real worker job. */
  enqueue?: (
    payload: ResearchJobPayload,
  ) => Promise<{ created: boolean }>;
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
 * pass the concurrency limit and each insert a run. The lock only serialises;
 * the count and insert commit on the pool and are visible to the next holder.
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
        { countRuns, hasCredits },
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
      const run = await createRun({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        userId: input.userId,
        topic: input.topic,
      });
      return { kind: "ok", run };
    },
  );

  // Enqueue after the lock is released: the run is committed, so a failed
  // enqueue leaves a queued run to be retried rather than holding the lock.
  if (outcome.kind === "ok") {
    await (deps.enqueue ?? enqueueResearchJob)({
      runId: outcome.run.id,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
    });
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
