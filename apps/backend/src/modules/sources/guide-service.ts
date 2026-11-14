import {
  sourceGuideSchema,
  type SourceGuide,
} from "@sourceweft/contracts/sources";
import { logger } from "../../shared/logger";
import { BillingAdmissionError } from "../../shared/model-gateway/index";
import { workspaceService } from "../workspace";
import type { ContentBillingPort } from "../content/billing-port";
import {
  enqueueSourceGuideGenerateJob,
  type SourceGuideGenerateJobPayload,
} from "../content/queue";
import { generateGuideContent } from "./guide-generation";
import { resolveGuidePayer, type GuidePayerPorts } from "./guide-payer";
import {
  findGuideRecord,
  listResumableGuides,
  toSourceGuide,
  upsertGuideRecord,
} from "./guide-repository";
import { requireContentSource } from "./guards";
import { findSourceRecord } from "./repository";

/** Source kinds a person adds directly; synced connector items are excluded. */
const AUTO_GUIDE_INGEST_KINDS = new Set([
  "manual_upload",
  "web_url",
  "youtube",
]);

const defaultPayerPorts: GuidePayerPorts = {
  resolveAccess: (input) => workspaceService.resolveAccess(input),
  resolveResponsibleUserId: (input) =>
    workspaceService.resolveResponsibleUserId(input),
  resolveBillingOrganizationId: (input) =>
    workspaceService.resolveBillingOrganizationId(input),
};

type GuideSource = {
  id: string;
  ingestKind: string;
  connectorId: string | null;
  contentHash: string | null;
  status: string;
};

/**
 * Whether a source gets a guide without anyone asking. A person added it
 * (not a connector sync, which can add thousands at once) and it is indexed.
 */
export function shouldAutoGenerateGuide(source: GuideSource) {
  return (
    source.status === "indexed" &&
    source.connectorId === null &&
    AUTO_GUIDE_INGEST_KINDS.has(source.ingestKind)
  );
}

async function queueGuide(input: {
  teamId: string;
  workspaceId: string;
  source: GuideSource;
  initiatorUserId: string | null;
  trigger: "auto" | "manual";
}) {
  await upsertGuideRecord({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    sourceId: input.source.id,
    status: "pending",
    trigger: input.trigger,
  });
  const payload: SourceGuideGenerateJobPayload = {
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    sourceId: input.source.id,
    initiatorUserId: input.initiatorUserId,
    trigger: input.trigger,
  };
  await enqueueSourceGuideGenerateJob(
    payload,
    input.trigger === "manual"
      ? `manual_${Date.now()}`
      : `auto_${input.source.contentHash ?? "none"}`,
  );
}

/**
 * Called after a source finishes indexing. A guide is optional, so a failure
 * here is logged and never reaches the indexing result.
 */
export async function requestAutoGuide(input: {
  teamId: string;
  workspaceId: string;
  source: GuideSource;
  initiatorUserId: string | null;
}) {
  if (!shouldAutoGenerateGuide(input.source)) return;
  try {
    await queueGuide({ ...input, trigger: "auto" });
  } catch (error) {
    logger.warn("Could not queue the source guide", {
      err: error,
      sourceId: input.source.id,
    });
  }
}

/** A person asked for the guide (also how a connector source gets one). */
export async function requestManualGuide(input: {
  workspaceId: string;
  userId: string;
  sourceId: string;
}) {
  const { workspace, source } = await requireContentSource(input);
  await queueGuide({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    source,
    initiatorUserId: input.userId,
    trigger: "manual",
  });
  return getSourceGuide(input);
}

export async function getSourceGuide(input: {
  workspaceId: string;
  userId: string;
  sourceId: string;
}): Promise<SourceGuide | null> {
  const { workspace, source } = await requireContentSource(input);
  const row = await findGuideRecord({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    sourceId: source.id,
  });
  if (!row) return null;
  return sourceGuideSchema.parse(toSourceGuide(row, source.contentHash));
}

/**
 * Runs one queued guide. Quota and "nobody to charge" leave the guide
 * `pending` (the job succeeds); other failures retry and, on the last
 * attempt, leave it `failed`. The source's own status is never touched.
 */
export async function processSourceGuideJob(
  job: SourceGuideGenerateJobPayload & {
    isFinalAttempt: boolean;
    scopeId: string;
  },
  deps: {
    billing: ContentBillingPort;
    payerPorts?: GuidePayerPorts;
  },
) {
  const scope = {
    teamId: job.teamId,
    workspaceId: job.workspaceId,
    sourceId: job.sourceId,
  };
  const source = await findSourceRecord(scope);
  if (!source) return { status: "skipped" as const, reason: "missing-source" };

  const write = (
    status: "pending" | "generating" | "ready" | "failed",
    extra: Parameters<typeof upsertGuideRecord>[0] extends infer T
      ? Partial<T>
      : never = {},
  ) =>
    upsertGuideRecord({
      ...scope,
      trigger: job.trigger,
      status,
      ...extra,
    });

  if (source.status !== "indexed" || !source.contentText.trim()) {
    await write("failed", { errorCode: "EMPTY_SOURCE" });
    return { status: "failed" as const };
  }

  const payer = await resolveGuidePayer(
    {
      workspaceId: job.workspaceId,
      organizationId: job.teamId,
      initiatorUserId: job.initiatorUserId,
    },
    deps.payerPorts ?? defaultPayerPorts,
  );
  if (!payer) {
    await write("pending", { errorCode: "NO_PAYER" });
    return { status: "pending" as const, reason: "no-payer" };
  }

  await write("generating", { payerUserId: payer.userId });
  try {
    const content = await generateGuideContent({
      billing: deps.billing,
      teamId: payer.billingOrganizationId,
      workspaceId: job.workspaceId,
      sourceId: job.sourceId,
      actorUserId: payer.userId,
      title: source.title,
      content: source.contentText,
      scopeId: job.scopeId,
    });
    await write("ready", {
      content,
      contentHash: source.contentHash,
      payerUserId: payer.userId,
    });
    return { status: "ready" as const };
  } catch (error) {
    if (error instanceof BillingAdmissionError) {
      await write("pending", { errorCode: "QUOTA", payerUserId: payer.userId });
      return { status: "pending" as const, reason: "quota" };
    }
    if (!job.isFinalAttempt) {
      throw error;
    }
    logger.warn("Source guide generation failed", {
      err: error,
      sourceId: job.sourceId,
    });
    await write("failed", { errorCode: "MODEL", payerUserId: payer.userId });
    return { status: "failed" as const };
  }
}

/** A paused guide is tried again this long after its last attempt. */
export const GUIDE_RESUME_INTERVAL_MS = 15 * 60_000;
/** A guide still `generating` after this long lost its job. */
export const GUIDE_STUCK_AFTER_MS = 30 * 60_000;
const GUIDE_RESUME_BATCH = 20;

/**
 * The scheduler's sweep: queue the guides that were waiting for credits or a
 * payer, and the ones whose job was lost, again. The same person is charged as
 * before (the recorded payer; a system run falls back to the workspace's
 * responsible owner), so a blocked guide just waits for the next interval.
 */
export async function resumePausedGuides(now = new Date()) {
  const rows = await listResumableGuides({
    pausedBefore: new Date(now.getTime() - GUIDE_RESUME_INTERVAL_MS),
    generatingBefore: new Date(now.getTime() - GUIDE_STUCK_AFTER_MS),
    limit: GUIDE_RESUME_BATCH,
  });
  let queued = 0;
  for (const row of rows) {
    try {
      // Rewriting the row moves `updated_at`, which both throttles the next
      // sweep and makes this attempt's job id unique.
      await upsertGuideRecord({
        teamId: row.teamId,
        workspaceId: row.workspaceId,
        sourceId: row.sourceId,
        status: "pending",
        trigger: row.trigger,
        errorCode: row.status === "generating" ? null : row.errorCode,
      });
      await enqueueSourceGuideGenerateJob(
        {
          teamId: row.teamId,
          workspaceId: row.workspaceId,
          sourceId: row.sourceId,
          initiatorUserId: row.payerUserId,
          trigger: row.trigger,
        },
        `resume_${now.getTime()}`,
      );
      queued += 1;
    } catch (error) {
      logger.warn("Could not resume a source guide", {
        err: error,
        sourceId: row.sourceId,
      });
    }
  }
  if (queued > 0) logger.info("Resumed paused source guides", { queued });
  return { queued };
}
