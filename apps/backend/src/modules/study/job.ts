import { ArtifactError } from "@sourceweft/contracts/artifact-errors";
import {
  parseStudyContentForArtifact,
  type MindmapNode,
  type StudyContent,
  type StudyKind,
} from "@sourceweft/contracts/study";
import { logger } from "../../shared/logger";
import { completeArtifact, failArtifact } from "../artifacts/publish";
import {
  findArtifactRecord,
  markArtifactRunning,
} from "../artifacts/repository";
import type { ContentBillingPort } from "../content/billing-port";
import type { StudyGenerateJobPayload } from "../content/queue";
import {
  isStudyGenerationError,
  type StudyProgress,
} from "@sourceweft/contracts/study-capability";
import {
  createArtifactCheckpointStore,
  findStudyVersionContent,
  linkStudyVersionParent,
  recordStudyInputSources,
  writeStudyPayloadKey,
  writeStudyProgress,
} from "./repository";
import { runStudyGeneration, type StudyGenerationDeps } from "./service";

/** Failures a retry cannot fix: recorded on the first attempt. */
const FINAL_CODES = new Set([
  "INSUFFICIENT_CREDITS",
  "INPUT_TOO_LARGE",
  "NO_INDEXED_SOURCES",
  "SOURCE_NOT_READABLE",
  "GENERATION_QUALITY_TOO_LOW",
  "MODEL_UNAVAILABLE",
]);

export type StudyJobResult =
  | { status: "ready"; versionNo: number }
  | { status: "failed"; errorCode: string }
  | { status: "skipped"; reason: string };

export type StudyJobDeps = {
  billing: ContentBillingPort;
  /** Overrides for tests; production uses the real generation. */
  generate?: typeof runStudyGeneration;
  generationDeps?: Partial<StudyGenerationDeps>;
};

/** Every item id of a version by its fingerprint, for id reuse. */
export function studyItemIdsByFingerprint(
  content: StudyContent,
): Map<string, string> {
  const ids = new Map<string, string>();
  const add = (fingerprint: string, id: string) => {
    if (!ids.has(fingerprint)) ids.set(fingerprint, id);
  };
  if (content.kind === "mindmap") {
    const walk = (node: MindmapNode) => {
      add(node.fingerprint, node.id);
      node.children.forEach(walk);
    };
    walk(content.root);
  } else {
    for (const item of content.items) add(item.fingerprint, item.id);
  }
  return ids;
}

/**
 * Runs one queued study generation.
 *
 * Version 1 completes the artifact opened by the request (pending → ready) or
 * fails it with the error code. A regeneration (version n+1) publishes over a
 * ready artifact with an optimistic lock on version n; if it fails, the ready
 * version stays and the failure is recorded beside it in
 * `payload_json.study.regeneration`. Codes a retry cannot fix are recorded on
 * the first attempt; anything else is retried and, on the last attempt,
 * recorded as `MODEL_UNAVAILABLE`.
 */
export async function processStudyJob(
  job: StudyGenerateJobPayload & { isFinalAttempt: boolean; scopeId: string },
  deps: StudyJobDeps,
): Promise<StudyJobResult> {
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

  let previousIds: Map<string, string> | undefined;
  if (!isFirst) {
    const previous = await findStudyVersionContent({
      ...scope,
      versionNo: expectedVersionNo,
    });
    if (previous) {
      try {
        previousIds = studyItemIdsByFingerprint(
          parseStudyContentForArtifact(artifact.artifactType, previous),
        );
      } catch {
        previousIds = undefined;
      }
    }
  }

  const generate = deps.generate ?? runStudyGeneration;
  try {
    const outcome = await generate(
      {
        teamId: artifact.teamId,
        workspaceId: artifact.workspaceId,
        threadId: artifact.threadId ?? job.threadId,
        artifactId: artifact.id,
        versionNo: job.versionNo,
        userId: job.userId,
        kind: job.artifactType as StudyKind,
        sourceIds: job.sourceIds,
        ...(job.options ? { options: job.options } : {}),
        uiLocale: job.uiLocale,
        ...(previousIds ? { previousIds } : {}),
        scopeId: job.scopeId,
      },
      {
        billing: deps.billing,
        checkpoint: createArtifactCheckpointStore(scope),
        onProgress: (progress: StudyProgress) =>
          writeStudyProgress(scope, progress).catch((error) =>
            logger.warn("Could not record study progress", {
              err: error,
              artifactId: artifact.id,
            }),
          ),
        ...deps.generationDeps,
      },
    );
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
        payload: outcome.content as unknown as Record<string, unknown>,
      },
      expectedStatuses: isFirst ? ["pending", "running"] : ["ready"],
      expectedVersionNo,
    });
    if (!isFirst) {
      await linkStudyVersionParent({ artifactId: artifact.id, versionNo: job.versionNo });
    }
    await recordStudyInputSources(artifact.id, outcome.sources);
    return { status: "ready", versionNo: job.versionNo };
  } catch (error) {
    const code = isStudyGenerationError(error) ? error.code : null;
    if (!code || !FINAL_CODES.has(code)) {
      if (!job.isFinalAttempt) throw error;
    }
    const errorCode = code && FINAL_CODES.has(code) ? code : "MODEL_UNAVAILABLE";
    const message =
      error instanceof Error ? error.message : "Study generation failed";
    logger.warn("Study artifact generation failed", {
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
      await writeStudyPayloadKey(scope, "regeneration", {
        versionNo: job.versionNo,
        status: "failed",
        errorCode,
      });
    }
    return { status: "failed", errorCode };
  }
}
