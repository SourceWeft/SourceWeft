import { parseTableContent } from "@sourceweft/contracts/table";
import { logger } from "../../shared/logger";
import type { ContentBillingPort } from "../content/billing-port";
import type { TableGenerateJobPayload } from "../content/queue";
import { runArtifactGenerationJob } from "../grounded-generation/job";
import {
  createArtifactCheckpointStore,
  writeTableProgress,
  type TableProgress,
} from "./repository";
import { runTableGeneration } from "./service";

export type TableJobResult =
  | { status: "ready"; versionNo: number }
  | { status: "failed"; errorCode: string }
  | { status: "skipped"; reason: string };

export type TableJobDeps = {
  billing: ContentBillingPort;
  /** Overrides for tests; production uses the real generation. */
  generate?: typeof runTableGeneration;
  generationDeps?: Partial<Parameters<typeof runTableGeneration>[1]>;
};

/**
 * Runs one queued table generation: the shared artifact job
 * (`runArtifactGenerationJob`, namespace `table`) with the table engine as its
 * `generate`. A failed regeneration is recorded in
 * `payload_json.table.regeneration`, and the ready version stays.
 */
export async function processTableJob(
  job: TableGenerateJobPayload & { isFinalAttempt: boolean; scopeId: string },
  deps: TableJobDeps,
): Promise<TableJobResult> {
  const generate = deps.generate ?? runTableGeneration;
  return runArtifactGenerationJob({
    job: { ...job, artifactType: "table" },
    namespace: "table",
    generate: async ({ artifact, previousContent }) => {
      const scope = {
        artifactId: artifact.id,
        teamId: artifact.teamId,
        workspaceId: artifact.workspaceId,
      };
      let previous;
      if (previousContent) {
        try {
          previous = parseTableContent(previousContent);
        } catch {
          // A version that no longer parses is no previous version: every cell
          // is filled again, which is the safe answer.
          previous = undefined;
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
          sourceIds: job.sourceIds,
          columns: job.columns,
          ...(job.instruction ? { instruction: job.instruction } : {}),
          ...(job.language ? { language: job.language } : {}),
          uiLocale: job.uiLocale,
          ...(previous ? { previous } : {}),
          scopeId: job.scopeId,
        },
        {
          billing: deps.billing,
          checkpoint: createArtifactCheckpointStore(scope),
          onProgress: (progress: TableProgress) =>
            writeTableProgress(scope, progress).catch((error) =>
              logger.warn("Could not record table progress", {
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
