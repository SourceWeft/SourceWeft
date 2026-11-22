import { ArtifactError } from "@sourceweft/contracts/artifact-errors";
import { isGroundedGenerationError } from "@sourceweft/contracts/grounded-generation";
import { logger } from "../../shared/logger";
import { notify } from "../notifications";
import { completeArtifact, failArtifact } from "../artifacts/publish";
import {
  findArtifactRecord,
  markArtifactRunning,
} from "../artifacts/repository";
import {
  findArtifactVersionContent,
  linkArtifactVersionParent,
  recordArtifactInputSources,
  writeArtifactPayloadKey,
  type ArtifactPayloadNamespace,
} from "./artifact-store";
import type { GroundedSourceSnapshot } from "./corpus-loader";

/** Failures a retry cannot fix: recorded on the first attempt. */
const FINAL_CODES = new Set([
  "INSUFFICIENT_CREDITS",
  "INPUT_TOO_LARGE",
  "NO_INDEXED_SOURCES",
  "SOURCE_NOT_READABLE",
  "GENERATION_QUALITY_TOO_LOW",
  "MODEL_UNAVAILABLE",
]);

/** What the job log calls each namespace's artifacts. */
const LABELS: Record<ArtifactPayloadNamespace, string> = {
  study: "Study",
  table: "Table",
};

export type ArtifactRecord = NonNullable<
  Awaited<ReturnType<typeof findArtifactRecord>>
>;

export type ArtifactGenerationResult =
  | { status: "ready"; versionNo: number }
  | { status: "failed"; errorCode: string }
  | { status: "skipped"; reason: string };

/**
 * Runs one queued generation of a grounded artifact; the artifact type
 * supplies only `generate`.
 *
 * Version 1 completes the artifact opened by the request (pending → ready) or
 * fails it with the error code. A regeneration (version n+1) publishes over a
 * ready artifact with an optimistic lock on version n; if it fails, the ready
 * version stays and the failure is recorded beside it in
 * `payload_json.<namespace>.regeneration`. Codes a retry cannot fix are
 * recorded on the first attempt; anything else is retried and, on the last
 * attempt, recorded as `MODEL_UNAVAILABLE`.
 */
export async function runArtifactGenerationJob(input: {
  job: {
    teamId: string;
    workspaceId: string;
    threadId: string;
    artifactId: string;
    versionNo: number;
    userId: string;
    artifactType: string;
    isFinalAttempt: boolean;
  };
  namespace: ArtifactPayloadNamespace;
  /**
   * Produces the content of this version and the sources it was built from.
   * `previousContent` is the stored content of version n-1 for a
   * regeneration, null for version 1 or when it cannot be found.
   */
  generate(ctx: {
    artifact: ArtifactRecord;
    previousContent: Record<string, unknown> | null;
  }): Promise<{
    content: Record<string, unknown>;
    sources: GroundedSourceSnapshot[];
  }>;
}): Promise<ArtifactGenerationResult> {
  const { job, namespace } = input;
  const label = LABELS[namespace];
  // Tenancy comes from the row: the artifact must exist in this team and
  // workspace, and its type must be the one generated.
  const artifact = await findArtifactRecord({
    teamId: job.teamId,
    workspaceId: job.workspaceId,
    artifactId: job.artifactId,
  });
  if (!artifact || artifact.artifactType !== job.artifactType) {
    return { status: "skipped", reason: "missing-artifact" };
  }
  const scope = {
    artifactId: artifact.id,
    teamId: artifact.teamId,
    workspaceId: artifact.workspaceId,
  };
  const isFirst = job.versionNo === 1;
  const expectedVersionNo = job.versionNo - 1;
  const waiting = isFirst
    ? (artifact.status === "pending" || artifact.status === "running") &&
      artifact.currentVersionNo === 0
    : artifact.status === "ready" &&
      artifact.currentVersionNo === expectedVersionNo;
  if (!waiting) {
    return { status: "skipped", reason: "superseded" };
  }
  if (isFirst) {
    await markArtifactRunning({
      ...scope,
      expectedStatuses: ["pending", "running"],
    });
  }

  const previousContent = isFirst
    ? null
    : await findArtifactVersionContent({
        ...scope,
        versionNo: expectedVersionNo,
      });

  try {
    const outcome = await input.generate({ artifact, previousContent });
    await completeArtifact({
      artifactId: artifact.id,
      context: {
        teamId: artifact.teamId,
        workspaceId: artifact.workspaceId,
        threadId: artifact.threadId ?? job.threadId,
        userId: job.userId,
      },
      spec: {
        artifactType: artifact.artifactType,
        title: artifact.title ?? job.artifactType,
        payload: outcome.content,
      },
      expectedStatuses: isFirst ? ["pending", "running"] : ["ready"],
      expectedVersionNo,
    });
    if (!isFirst) {
      await linkArtifactVersionParent({
        artifactId: artifact.id,
        versionNo: job.versionNo,
      });
    }
    await recordArtifactInputSources(artifact.id, outcome.sources);
    return { status: "ready", versionNo: job.versionNo };
  } catch (error) {
    const code = isGroundedGenerationError(error) ? error.code : null;
    if (!code || !FINAL_CODES.has(code)) {
      if (!job.isFinalAttempt) throw error;
    }
    const errorCode = code && FINAL_CODES.has(code) ? code : "MODEL_UNAVAILABLE";
    const message =
      error instanceof Error ? error.message : `${label} generation failed`;
    logger.warn(`${label} artifact generation failed`, {
      artifactId: artifact.id,
      versionNo: job.versionNo,
      kind: job.artifactType,
      errorCode,
      err: error,
    });
    if (isFirst) {
      await failArtifact({
        artifactId: artifact.id,
        context: { teamId: artifact.teamId, workspaceId: artifact.workspaceId },
        error: new ArtifactError({
          code: errorCode,
          message,
          // A smaller selection, more credits or indexed sources fix these;
          // the model or quality failures are the system's.
          category:
            errorCode === "MODEL_UNAVAILABLE" ||
            errorCode === "GENERATION_QUALITY_TOO_LOW"
              ? "infrastructure"
              : "validation",
        }),
        expectedStatuses: ["pending", "running"],
      });
    } else {
      await writeArtifactPayloadKey(scope, namespace, "regeneration", {
        versionNo: job.versionNo,
        status: "failed",
        errorCode,
      });
    }
    await notifyGenerationFailed({ artifact, job, errorCode, isFirst });
    return { status: "failed", errorCode };
  }
}

/** Titles longer than this are cut so the payload stays small. */
const NOTIFICATION_TITLE_MAX = 200;

/**
 * Tells the person who asked that the generation failed. The job runs after
 * the conversation has moved on, so nothing else reaches them: without this a
 * failure is only visible to someone who goes looking. A failed notice never
 * fails the job.
 */
async function notifyGenerationFailed(input: {
  artifact: ArtifactRecord;
  job: { teamId: string; threadId: string; userId: string; artifactType: string };
  errorCode: string;
  isFirst: boolean;
}) {
  const { artifact, job } = input;
  try {
    await notify({
      kind: "artifact_generation_failed",
      teamId: job.teamId,
      userId: job.userId,
      ref: { kind: "artifact", id: artifact.id },
      payload: {
        title: (artifact.title ?? job.artifactType).slice(0, NOTIFICATION_TITLE_MAX),
        artifactType: job.artifactType,
        threadId: artifact.threadId ?? job.threadId,
        errorCode: input.errorCode,
        regeneration: !input.isFirst,
      },
    });
  } catch (error) {
    logger.warn("Could not record the generation failure notice", {
      artifactId: artifact.id,
      err: error,
    });
  }
}
