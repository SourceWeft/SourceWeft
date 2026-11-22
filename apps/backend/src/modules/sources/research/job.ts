import type { AgentToolWebProvider } from "@sourceweft/contracts/agent-tools";
import type {
  ResearchCitation,
  ResearchErrorCode,
} from "@sourceweft/contracts/source-research";
import { logger } from "../../../shared/logger";
import { completeEmbeddingBatch } from "../../../shared/model-gateway/index";
import { CITATION_ANCHORING_FEATURE } from "../../citations/anchoring-diagnostics";
import type { ContentBillingPort } from "../../content/billing-port";
import type { ResearchJobPayload } from "../../content/queue";
import { createGroundedAnchorPort } from "../../grounded-generation/anchor-port";
import { createGroundedModelPort } from "../../grounded-generation/model-port";
import { defaultPayerPorts } from "../../content/payer-ports";
import { resolveGuidePayer, type GuidePayer } from "../guide-payer";
import { createDefaultWebProvider } from "../web-provider";
import { runResearch, type ResearchRepo } from "./loop";
import {
  findRun,
  finishCancelled,
  finishFailed,
  finishReady,
  isCancelRequested,
  markRunning,
  saveProgress,
  type ResearchRunRow,
} from "./repository";

const SUBJECT = "report";

/** The run-state the job drives, injected so the logic is testable without a DB. */
export type ResearchJobRepo = ResearchRepo & {
  markRunning(id: string): Promise<boolean>;
  findRun(input: {
    teamId: string;
    workspaceId: string;
    id: string;
  }): Promise<ResearchRunRow | null>;
  finishReady(
    id: string,
    result: { report: string; citations: ResearchCitation[] },
  ): Promise<boolean>;
  finishFailed(id: string, errorCode: ResearchErrorCode): Promise<boolean>;
  finishCancelled(id: string): Promise<boolean>;
};

const defaultRepo: ResearchJobRepo = {
  markRunning,
  findRun,
  saveProgress,
  isCancelRequested,
  finishReady,
  finishFailed,
  finishCancelled,
};

export type ResearchJobDeps = {
  billing: ContentBillingPort;
  /** Overridable for tests; production resolves the capability web provider. */
  web?: AgentToolWebProvider;
  /** Overridable for tests; production runs the real research loop. */
  runLoop?: typeof runResearch;
  /** Overridable for tests; production reads and writes real research_runs. */
  repo?: ResearchJobRepo;
  /** Resolves the requester-payer; null means they can no longer access the run. */
  resolvePayer?: (input: {
    workspaceId: string;
    teamId: string;
    userId: string;
  }) => Promise<GuidePayer | null>;
  now?: () => number;
};

async function defaultResolvePayer(input: {
  workspaceId: string;
  teamId: string;
  userId: string;
}): Promise<GuidePayer | null> {
  return resolveGuidePayer(
    {
      workspaceId: input.workspaceId,
      organizationId: input.teamId,
      initiatorUserId: input.userId,
    },
    defaultPayerPorts,
  );
}

/**
 * Executes one queued (or resuming) research run.
 *
 * It claims the run (`markRunning`); a run that is already terminal is left
 * alone, so a redelivered job never overwrites a finished result, and one found
 * still `running` is resumed from its saved ledger. It confirms the initiator
 * can still reach the workspace before spending anything — otherwise the run
 * fails `ACCESS_LOST` and the loop is never entered. The loop's outcome is
 * written as `ready`/`failed`/`cancelled`. A transient (non-terminal) model
 * failure is rethrown so the queue retries; on the final attempt it is recorded
 * as `MODEL_UNAVAILABLE` rather than left running.
 */
export async function processResearchJob(
  input: ResearchJobPayload & { isFinalAttempt: boolean; scopeId: string },
  deps: ResearchJobDeps,
): Promise<void> {
  const { runId, teamId, workspaceId, userId } = input;
  const repo = deps.repo ?? defaultRepo;

  const started = await repo.markRunning(runId);
  const run = await repo.findRun({ teamId, workspaceId, id: runId });
  if (!run) {
    // The run (or its workspace) is gone; nothing to execute.
    return;
  }
  if (!started && run.status !== "running") {
    // Already terminal (ready/failed/cancelled): a repeat execution is a no-op.
    return;
  }

  const payer = await (deps.resolvePayer ?? defaultResolvePayer)({
    workspaceId,
    teamId,
    userId,
  });
  if (!payer) {
    await repo.finishFailed(runId, "ACCESS_LOST");
    return;
  }

  const web = deps.web ?? (await createDefaultWebProvider());
  if (!web) {
    await repo.finishFailed(runId, "WEB_PROVIDER_UNAVAILABLE");
    return;
  }

  const model = createGroundedModelPort({
    billing: deps.billing,
    teamId: payer.billingOrganizationId,
    workspaceId,
    actorUserId: payer.userId,
    scopeId: input.scopeId,
    scopeKind: "worker-job",
    subject: SUBJECT,
  });
  const anchor = createGroundedAnchorPort({
    // The by-meaning pass for cross-language evidence: recorded, not charged,
    // like citation anchoring in chat.
    embedTexts: (texts) =>
      completeEmbeddingBatch({
        billing: deps.billing,
        teamId: payer.billingOrganizationId,
        workspaceId,
        actorUserId: payer.userId,
        scopeId: input.scopeId,
        feature: CITATION_ANCHORING_FEATURE,
        idempotencyKey: `research:${runId}:anchor`,
        texts,
      }),
    onSemanticError: (error) =>
      logger.warn("Research evidence by-meaning anchoring failed", {
        err: error,
        runId,
      }),
  });

  const deps_: Parameters<typeof runResearch>[1] = {
    web,
    model,
    anchor,
    repo: {
      saveProgress: repo.saveProgress,
      isCancelRequested: repo.isCancelRequested,
    },
    now: deps.now ?? (() => Date.now()),
  };

  let result;
  try {
    result = await (deps.runLoop ?? runResearch)(
      {
        runId,
        topic: run.topic,
        resume: {
          plan: run.planJson ?? null,
          ledger: run.ledgerJson,
          progress: run.progressJson,
        },
        // Measure the wall-clock budget from the first start, so a retry after
        // a crash does not hand the run a fresh ten minutes.
        ...(run.startedAt ? { startedAtMs: run.startedAt.getTime() } : {}),
      },
      deps_,
    );
  } catch (error) {
    // A transient model/infra failure. Retry while the queue has attempts left;
    // on the last one, settle the run so it does not stay running forever.
    if (!input.isFinalAttempt) {
      throw error;
    }
    logger.warn("Research run failed on its final attempt", { err: error, runId });
    await repo.finishFailed(runId, "MODEL_UNAVAILABLE");
    return;
  }

  switch (result.status) {
    case "ready":
      await repo.finishReady(runId, {
        report: result.report,
        citations: result.citations,
      });
      return;
    case "cancelled":
      await repo.finishCancelled(runId);
      return;
    case "failed":
      await repo.finishFailed(runId, result.errorCode);
      return;
  }
}
