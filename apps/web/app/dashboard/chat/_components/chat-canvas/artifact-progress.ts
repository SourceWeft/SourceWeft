import { getArtifactProgressProtocol } from "@sourceweft/agent-tool-registry";
import type {
  ArtifactProgressInput,
  ArtifactProgressView,
} from "@sourceweft/contracts/artifact-progress";
import type { ArtifactPipelineGenerationStatus } from "@sourceweft/contracts/artifact-pipeline";
import type { ArtifactStatusSnapshot, ToolCallRecord } from "./types";

/**
 * Capability-agnostic progress rendering.
 *
 * Every deliverable pipeline writes the same `generation` block, and each
 * capability contributes an ArtifactProgressProtocol through its tool
 * definition. The UI therefore asks the registry for the protocol rather than
 * importing per-capability modules — adding a deliverable needs no web change.
 */

export type DeliverableProgressView = ArtifactProgressView;
export type DeliverableGenerationStatus = ArtifactPipelineGenerationStatus;

export type DeliverableProgressInput = {
  toolName: string;
  toolCallOutput?: unknown;
  toolCallStatus?: ToolCallRecord["status"];
  artifactSnapshot?: ArtifactStatusSnapshot;
};

function toProtocolInput(input: DeliverableProgressInput): ArtifactProgressInput {
  return {
    toolCallOutput: input.toolCallOutput,
    toolCallStatus: input.toolCallStatus,
    artifactSnapshot: input.artifactSnapshot ?? null,
  };
}

/** Whether this tool produces an artifact whose progress the UI should track. */
export function isDeliverableToolName(toolName: string) {
  return getArtifactProgressProtocol(toolName) !== null;
}

export function resolveDeliverableArtifactId(input: {
  toolName: string;
  toolCallOutput?: unknown;
}) {
  return (
    getArtifactProgressProtocol(input.toolName)?.extractArtifactId(
      input.toolCallOutput,
    ) ?? undefined
  );
}

export function resolveDeliverableStatus(
  input: DeliverableProgressInput,
): DeliverableGenerationStatus | null {
  const protocol = getArtifactProgressProtocol(input.toolName);
  return protocol
    ? protocol.resolveProgressView(toProtocolInput(input)).status
    : null;
}

export function isDeliverableGenerationActive(input: DeliverableProgressInput) {
  const status = resolveDeliverableStatus(input);
  return status === "pending" || status === "running";
}

export function resolveDeliverableProgress(
  input: DeliverableProgressInput,
): DeliverableProgressView | null {
  return (
    getArtifactProgressProtocol(input.toolName)?.resolveProgressView(
      toProtocolInput(input),
    ) ?? null
  );
}

export function resolveDeliverableElapsedMs(
  input: DeliverableProgressInput & { nowMs?: number },
) {
  return (
    getArtifactProgressProtocol(input.toolName)?.resolveElapsedMs({
      ...toProtocolInput(input),
      ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    }) ?? null
  );
}

/** Display name of what the capability produces, for progress headings. */
export function resolveDeliverableTitle(toolName: string) {
  return getArtifactProgressProtocol(toolName)?.title ?? "Artifact";
}

/**
 * The raw structured output is rendered as a progress card, so its text summary
 * would be duplicate noise.
 */
export function shouldSuppressDeliverableOutputSummary(input: {
  toolName: string;
  toolCallOutput?: unknown;
}) {
  return (
    getArtifactProgressProtocol(input.toolName)?.matchesOutputType(
      input.toolCallOutput,
    ) ?? false
  );
}
