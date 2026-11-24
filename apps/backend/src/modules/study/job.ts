import {
  parseStudyContentForArtifact,
  type MindmapNode,
  type StudyContent,
  type StudyKind,
} from "@sourceweft/contracts/study";
import { logger } from "../../shared/logger";
import type { ContentBillingPort } from "../content/billing-port";
import type { StudyGenerateJobPayload } from "../content/queue";
import type { StudyProgress } from "@sourceweft/contracts/study-capability";
import { runArtifactGenerationJob } from "../grounded-generation/job";
import { writeStudyProgress, createArtifactCheckpointStore } from "./repository";
import { runStudyGeneration, type StudyGenerationDeps } from "./service";

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
 * Runs one queued study generation: the shared artifact job
 * (`runArtifactGenerationJob`, namespace `study`) with the study engine as its
 * `generate`. A failed regeneration is recorded in
 * `payload_json.study.regeneration`.
 */
export async function processStudyJob(
  job: StudyGenerateJobPayload & { isFinalAttempt: boolean; scopeId: string },
  deps: StudyJobDeps,
): Promise<StudyJobResult> {
  const generate = deps.generate ?? runStudyGeneration;
  return runArtifactGenerationJob({
    job,
    namespace: "study",
    generate: async ({ artifact, previousContent }) => {
      const scope = {
        artifactId: artifact.id,
        teamId: artifact.teamId,
        workspaceId: artifact.workspaceId,
      };
      let previousIds: Map<string, string> | undefined;
      if (previousContent) {
        try {
          previousIds = studyItemIdsByFingerprint(
            parseStudyContentForArtifact(artifact.artifactType, previousContent),
          );
        } catch {
          previousIds = undefined;
        }
      }
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
      return {
        content: outcome.content as unknown as Record<string, unknown>,
        sources: outcome.sources,
      };
    },
  });
}
