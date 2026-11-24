import type { AgentToolGroundedArtifactServices } from "@sourceweft/contracts/agent-tools";
import { requestGroundedArtifactForTurn } from "../../../grounded-generation/turn-requests";
import { listSourceRecordsByIds } from "../../../sources/repository";
import type { PreparedThreadTurn } from "../..";
import type { RunCancellationGate } from "../../run-cancellation";

/**
 * The turn's binding of grounded generation: the actor, workspace and thread
 * are the turn's, so a capability cannot start a job anywhere else.
 */
export function createGroundedArtifactServices(input: {
  readonly prepared: Pick<
    PreparedThreadTurn,
    "userId" | "sourceIds" | "effectiveMentionedSourceIds"
  > & {
    readonly workspace: Pick<PreparedThreadTurn["workspace"], "id" | "organizationId">;
    readonly thread: Pick<PreparedThreadTurn["thread"], "id">;
  };
  readonly runCancellation?: RunCancellationGate;
}): AgentToolGroundedArtifactServices {
  const { prepared, runCancellation } = input;
  return {
    listTurnSourceIds: async () => {
      // Mentions narrow the turn to what the user named; both lists are
      // already folder-expanded and inside the workspace.
      const scoped =
        prepared.effectiveMentionedSourceIds.length > 0
          ? prepared.effectiveMentionedSourceIds
          : prepared.sourceIds;
      if (scoped.length === 0) return [];
      const records = await listSourceRecordsByIds({
        teamId: prepared.workspace.organizationId,
        workspaceId: prepared.workspace.id,
        sourceIds: [...scoped],
      });
      const documents = new Set(
        records
          .filter((record) => record.sourceType !== "directory")
          .map((record) => record.id),
      );
      return scoped.filter((sourceId) => documents.has(sourceId));
    },
    requestGeneration: async (request) => {
      // A late cancel must not still queue a job that outlives the turn.
      await runCancellation?.throwIfCancelled("requesting the artifact");
      return requestGroundedArtifactForTurn({
        artifactType: request.artifactType,
        request: request.request,
        uiLocale: request.uiLocale,
        workspaceId: prepared.workspace.id,
        userId: prepared.userId,
        threadId: prepared.thread.id,
      });
    },
  };
}
