import {
  findAgentToolForProgressEventType,
  getAgentToolPresentation,
  hasAgentToolCapability,
} from "@sourceweft/agent-tool-registry";
import type { ArtifactGenerationPhase } from "@sourceweft/contracts/agent-tools";
import type { ThinkingStepTrace, ToolCallTrace } from "../..";
import { toObjectRecord } from "../../../../shared/records";
import type { DeepAgentTurnEvent } from "./events";

export type GeneratedArtifactProgressEvent = {
  toolCallId: string;
  tool: string;
  data: Record<string, unknown>;
};

const ACTIVE_ARTIFACT_GENERATION_PHASES = new Set<ArtifactGenerationPhase>([
  "planning",
  "generating",
  "saving",
  "repairing",
]);

/**
 * One step builder for every long-running artifact capability. The wording is
 * the capability's, fetched from its `AgentToolPresentation`; this function
 * only owns the shape of the trace step. Returns null when the tool declares no
 * presentation or no generation-step copy.
 */
export function buildArtifactGenerationStep(input: {
  description?: string;
  error?: string | null;
  item?: string;
  latencyMs?: number | null;
  phase: ArtifactGenerationPhase;
  toolCallId?: string;
  toolName: string;
}): Omit<ThinkingStepTrace, "sequence"> | null {
  const copy = getAgentToolPresentation(input.toolName)?.generationStep?.({
    phase: input.phase,
    error: input.error,
  });
  if (!copy) {
    return null;
  }

  return {
    id: copy.stepId,
    kind: "state",
    title: copy.title,
    status: ACTIVE_ARTIFACT_GENERATION_PHASES.has(input.phase)
      ? "in_progress"
      : "completed",
    items: [input.item ?? copy.item],
    description: input.description ?? copy.description,
    metadata: {
      artifactType: copy.artifactType,
      phase: input.phase,
      tool: input.toolName,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(typeof input.latencyMs === "number"
        ? { latencyMs: input.latencyMs }
        : {}),
    },
  };
}

export function buildPresentationProgressThinkingStep(input: {
  data: Record<string, unknown>;
  toolCallId: string;
}): Omit<ThinkingStepTrace, "sequence"> | null {
  // A capability is recognised by having a presentation, not by matching one of
  // a hardcoded pair of capability tags — the old form silently rendered any
  // third deliverable with the deck's copy.
  const tool = typeof input.data.tool === "string" ? input.data.tool : null;
  if (!tool || !getAgentToolPresentation(tool)) {
    return null;
  }
  const stage =
    typeof input.data.stage === "string" ? input.data.stage.trim() : "";
  const retryError =
    typeof input.data.error_message === "string"
      ? input.data.error_message
      : typeof input.data.errorMessage === "string"
        ? input.data.errorMessage
        : null;
  const buildStep = (
    stepInput: Omit<
      Parameters<typeof buildArtifactGenerationStep>[0],
      "toolCallId" | "toolName"
    >,
  ) =>
    buildArtifactGenerationStep({
      ...stepInput,
      toolCallId: input.toolCallId,
      toolName: tool,
    });
  // Stage wording belongs to the capability: it owns both the pipeline's stage
  // vocabulary and the words for the stages every deliverable reports.
  const stageStep = getAgentToolPresentation(tool)?.stageStep;
  if (input.data.retrying === true) {
    const retry = stageStep?.({ stageId: "retrying" });
    return buildStep({
      description: retryError ?? undefined,
      ...(retry ? { item: retry.item } : {}),
      phase: "generating",
    });
  }
  const capabilityStage = stageStep?.({ stageId: stage });
  if (capabilityStage) {
    return buildStep({
      ...(capabilityStage.description
        ? { description: capabilityStage.description }
        : {}),
      item: capabilityStage.item,
      phase: capabilityStage.phase,
    });
  }
  switch (stage) {
    case "planning":
      return buildStep({
        phase: "planning",
      });
    case "failed":
      return buildStep({
        error:
          typeof input.data.error === "string"
            ? input.data.error
            : typeof input.data.error_message === "string"
              ? input.data.error_message
              : null,
        phase: "failed",
      });
    case "saving":
      return buildStep({
        phase: "saving",
      });
    case "ready":
      return buildStep({
        phase: "completed",
      });
    default:
      return null;
  }
}

export function buildPresentationProgressThinkingEvent(input: {
  progressEvent: {
    data: Record<string, unknown>;
    tool: string;
    toolCallId: string;
  };
  setThinkingStep: (
    step: Omit<ThinkingStepTrace, "sequence">,
  ) => ThinkingStepTrace;
}): Extract<DeepAgentTurnEvent, { type: "thinking-step" }> | null {
  // Admit any capability that reports in-turn generation steps, rather than the
  // two that happened to exist when this was written.
  if (!getAgentToolPresentation(input.progressEvent.tool)?.generationStep) {
    return null;
  }

  const progressStep = buildPresentationProgressThinkingStep({
    data: input.progressEvent.data,
    toolCallId: input.progressEvent.toolCallId,
  });
  return progressStep
    ? {
        type: "thinking-step",
        step: input.setThinkingStep(progressStep),
      }
    : null;
}

export function normalizeGeneratedImageProgressEvent(
  payload: unknown,
): GeneratedArtifactProgressEvent | null {
  const record = toObjectRecord(payload);
  // Event types are claimed per capability, so the owner must be this one —
  // routing on "some capability claims it" would let a deck or video progress
  // event through and relabel it as an image.
  const eventOwner = findAgentToolForProgressEventType(
    typeof record?.type === "string" ? record.type : null,
  );
  if (
    !record ||
    !eventOwner ||
    !hasAgentToolCapability(eventOwner.name, "generated_image_artifact")
  ) {
    return null;
  }

  const toolCallId =
    typeof record.toolCallId === "string" && record.toolCallId.length > 0
      ? record.toolCallId
      : null;
  if (!toolCallId) {
    return null;
  }

  const tool = eventOwner.name;

  return {
    toolCallId,
    tool,
    data: {
      ...record,
      tool,
      toolCallId,
    },
  };
}

export function normalizeGeneratedPresentationProgressEvent(
  payload: unknown,
): GeneratedArtifactProgressEvent | null {
  const record = toObjectRecord(payload);
  // Only capabilities that render an in-turn generation step belong here;
  // image progress renders as a tool-call event instead.
  const eventOwner = findAgentToolForProgressEventType(
    typeof record?.type === "string" ? record.type : null,
  );
  if (!record || !eventOwner?.presentation.generationStep) {
    return null;
  }

  const toolCallId =
    typeof record.toolCallId === "string" && record.toolCallId.length > 0
      ? record.toolCallId
      : null;
  if (!toolCallId) {
    return null;
  }

  // Prefer the tool the event names, but only if it is a real capability;
  // otherwise attribute the event to whichever capability claims its type.
  const tool =
    typeof record.tool === "string" && getAgentToolPresentation(record.tool)
      ? record.tool
      : eventOwner.name;

  return {
    toolCallId,
    tool,
    data: {
      ...record,
      tool,
      toolCallId,
    },
  };
}

export function buildGeneratedArtifactProgressToolCallEvent(input: {
  progressEvent: GeneratedArtifactProgressEvent;
  toolCallsById: Map<string, ToolCallTrace>;
}): Extract<DeepAgentTurnEvent, { type: "tool-call-event" }> | null {
  const currentToolCall = input.toolCallsById.get(
    input.progressEvent.toolCallId,
  );
  if (!currentToolCall) {
    return null;
  }

  const nextToolCall: ToolCallTrace = {
    ...currentToolCall,
    tool: input.progressEvent.tool,
    output: input.progressEvent.data,
    status: "running",
    error: null,
  };
  input.toolCallsById.set(input.progressEvent.toolCallId, nextToolCall);

  return {
    type: "tool-call-event",
    id: input.progressEvent.toolCallId,
    tool: input.progressEvent.tool,
    data: input.progressEvent.data,
    toolCall: nextToolCall,
  };
}
