import { getArtifactProgressProtocol } from "@sourceweft/agent-tool-registry";
import type {
  ArtifactProgressProtocol,
  ArtifactProgressInput,
  ArtifactProgressView,
} from "@sourceweft/contracts/artifact-progress";
import { readArtifactOutputField } from "@sourceweft/contracts/artifact-progress";
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

function isPersistedTerminalFailure(
  input: DeliverableProgressInput,
  protocol: ArtifactProgressProtocol,
) {
  if (
    input.toolCallStatus !== "completed" &&
    input.toolCallStatus !== "error"
  ) {
    return false;
  }
  const outputType = readArtifactOutputField(input.toolCallOutput, "type");
  const outputStatus = readArtifactOutputField(input.toolCallOutput, "status");
  return (
    outputType !== null &&
    protocol.outputTypeRoles[outputType] === "terminal" &&
    (outputStatus === "failed" ||
      outputStatus === "cancelled" ||
      outputStatus === "stalled")
  );
}

function toProtocolInput(
  input: DeliverableProgressInput,
  protocol: ArtifactProgressProtocol,
): ArtifactProgressInput {
  if (isPersistedTerminalFailure(input, protocol)) {
    return {
      toolCallOutput: input.toolCallOutput,
      toolCallStatus: input.toolCallStatus,
      // A completed tool result is immutable history. Use a synthetic failed
      // snapshot so a later mutable artifact row cannot rewrite that call to
      // ready/running, while the protocol can still read any persisted
      // generation steps from the tool output itself.
      artifactSnapshot: {
        status: "failed",
        payloadJson: input.toolCallOutput,
        errorCode:
          readArtifactOutputField(input.toolCallOutput, "error_code") ??
          readArtifactOutputField(input.toolCallOutput, "errorCode"),
        errorMessage:
          readArtifactOutputField(input.toolCallOutput, "error") ??
          readArtifactOutputField(input.toolCallOutput, "error_message") ??
          readArtifactOutputField(input.toolCallOutput, "errorMessage"),
      },
    };
  }
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

export function resolveDeliverableStatus(
  input: DeliverableProgressInput,
): DeliverableGenerationStatus | null {
  const protocol = getArtifactProgressProtocol(input.toolName);
  return protocol
    ? protocol.resolveProgressView(toProtocolInput(input, protocol)).status
    : null;
}

export function isDeliverableGenerationActive(input: DeliverableProgressInput) {
  const status = resolveDeliverableStatus(input);
  return status === "pending" || status === "running";
}

export function resolveDeliverableProgress(
  input: DeliverableProgressInput,
): DeliverableProgressView | null {
  const protocol = getArtifactProgressProtocol(input.toolName);
  return (
    protocol?.resolveProgressView(toProtocolInput(input, protocol)) ?? null
  );
}

export function resolveDeliverableElapsedMs(
  input: DeliverableProgressInput & { nowMs?: number },
) {
  const protocol = getArtifactProgressProtocol(input.toolName);
  return protocol
    ? protocol.resolveElapsedMs({
        ...toProtocolInput(input, protocol),
        ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
      })
    : null;
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
