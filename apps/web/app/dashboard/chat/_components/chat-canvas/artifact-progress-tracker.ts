import { getArtifactProgressProtocol } from "@sourceweft/agent-tool-registry";
import type { PendingArtifactRef } from "@sourceweft/contracts/artifact-progress";
import { resolveMessageToolCalls } from "./artifact-work-state";
import type { ArtifactStatusSnapshot, ToolCallRecord } from "./types";

/**
 * Collect artifacts whose generation has not reached a terminal state yet,
 * using each tool's registered ArtifactProgressProtocol. Used to reconcile
 * artifact snapshots once per artifact set on thread load; live progress
 * arrives through the chat SSE.
 */
export function collectPendingArtifacts(
  messages: Array<{
    metadata?: Record<string, unknown>;
    toolCalls?: ToolCallRecord[];
  }>,
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>,
): PendingArtifactRef[] {
  const pending: PendingArtifactRef[] = [];

  for (const message of messages) {
    for (const toolCall of resolveMessageToolCalls(message)) {
      const protocol = getArtifactProgressProtocol(toolCall.tool);
      if (!protocol) {
        continue;
      }

      const artifactId = protocol.extractArtifactId(toolCall.output);
      if (!artifactId) {
        continue;
      }

      const snapshot = artifactStatuses?.get(artifactId);
      if (protocol.isTerminal(snapshot)) {
        continue;
      }

      if (protocol.isProgressTracking(toolCall.output, snapshot)) {
        pending.push({ artifactId, toolName: toolCall.tool });
      }
    }
  }

  return pending;
}
