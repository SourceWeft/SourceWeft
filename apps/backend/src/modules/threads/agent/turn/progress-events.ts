import {
  AGENT_TOOL_NAMES,
  hasAgentToolCapability,
} from "@sourceweft/agent-tool-registry";
import { GENERATED_IMAGE_PROGRESS_EVENT_TYPE } from "@sourceweft/builtin-tool-generate-image";
import type {
  CommandSuccessCriteria,
  ThinkingStepTrace,
  ToolCallTrace,
} from "../..";
import { toObjectRecord } from "./content";
import type { DeepAgentTurnEvent } from "./events";

export type GeneratedArtifactProgressEvent = {
  toolCallId: string;
  tool: string;
  data: Record<string, unknown>;
};

export const PUBLISH_SANDBOX_ARTIFACT_PROGRESS_EVENT_TYPE =
  "publish_sandbox_artifact_progress";

const PRESENTATION_GENERATION_STEP_ID = "presentation-generation";

type PresentationGenerationStepPhase =
  | "planning"
  | "generating"
  | "saving"
  | "repairing"
  | "completed"
  | "failed";

export function isPresentationGenerationCommand(
  criteria: CommandSuccessCriteria,
) {
  return (
    criteria.kind === "artifact" &&
    criteria.artifactType === "slides" &&
    hasAgentToolCapability(criteria.toolName, "presentation_artifact")
  );
}

export function buildPresentationGenerationStep(input: {
  description?: string;
  error?: string | null;
  item?: string;
  latencyMs?: number | null;
  phase: PresentationGenerationStepPhase;
  tool?: string;
  toolCallId?: string;
}): Omit<ThinkingStepTrace, "sequence"> {
  const isActive =
    input.phase === "planning" ||
    input.phase === "generating" ||
    input.phase === "saving" ||
    input.phase === "repairing";
  const title =
    input.phase === "completed"
      ? "Published presentation"
      : input.phase === "failed"
        ? "Presentation publishing incomplete"
        : "Publishing presentation";
  const item =
    input.item ??
    (input.phase === "planning"
      ? "Preparing presentation artifact"
      : input.phase === "generating"
        ? "Validating generated PPTX"
        : input.phase === "saving"
          ? "Publishing presentation artifact"
        : input.phase === "repairing"
            ? "Adding explicit slide content"
            : input.phase === "completed"
              ? "Presentation artifact created"
              : "publish_sandbox_artifact did not create an artifact");
  const description =
    input.description ??
    (input.phase === "planning"
      ? "Preparing the generated presentation for artifact publishing."
      : input.phase === "generating"
        ? "The generated PPTX is being validated before publishing."
        : input.phase === "saving"
          ? "The presentation artifact is being saved."
        : input.phase === "repairing"
            ? "The deck tool needs a complete deck plan before artifact creation."
            : input.phase === "completed"
              ? "The presentation artifact was published."
              : (input.error ??
                "The presentation publisher did not return a usable artifact."));

  return {
    id: PRESENTATION_GENERATION_STEP_ID,
    kind: "state",
    title,
    status: isActive ? "in_progress" : "completed",
    items: [item],
    description,
    metadata: {
      artifactType: "slides",
      phase: input.phase,
      tool: input.tool ?? AGENT_TOOL_NAMES.publishSandboxArtifact,
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
  const tool =
    typeof input.data.tool === "string" &&
    hasAgentToolCapability(input.data.tool, "presentation_artifact")
      ? input.data.tool
      : AGENT_TOOL_NAMES.publishSandboxArtifact;
  const stage =
    typeof input.data.stage === "string" ? input.data.stage.trim() : "";
  switch (stage) {
    case "planning":
      return buildPresentationGenerationStep({
        phase: "planning",
        tool,
        toolCallId: input.toolCallId,
      });
    case "generating":
      return buildPresentationGenerationStep({
        description: "The generated PPTX is being validated before publishing.",
        item: "Validating generated PPTX",
        phase: "generating",
        tool,
        toolCallId: input.toolCallId,
      });
    case "saving":
      return buildPresentationGenerationStep({
        phase: "saving",
        tool,
        toolCallId: input.toolCallId,
      });
    case "ready":
      return buildPresentationGenerationStep({
        phase: "completed",
        tool,
        toolCallId: input.toolCallId,
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
  if (!hasAgentToolCapability(input.progressEvent.tool, "presentation_artifact")) {
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
  if (!record || record.type !== GENERATED_IMAGE_PROGRESS_EVENT_TYPE) {
    return null;
  }

  const toolCallId =
    typeof record.toolCallId === "string" && record.toolCallId.length > 0
      ? record.toolCallId
      : null;
  if (!toolCallId) {
    return null;
  }

  const tool = AGENT_TOOL_NAMES.generateImage;

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
  if (!record || record.type !== PUBLISH_SANDBOX_ARTIFACT_PROGRESS_EVENT_TYPE) {
    return null;
  }

  const toolCallId =
    typeof record.toolCallId === "string" && record.toolCallId.length > 0
      ? record.toolCallId
      : null;
  if (!toolCallId) {
    return null;
  }

  const tool =
    typeof record.tool === "string" &&
    hasAgentToolCapability(record.tool, "presentation_artifact")
      ? record.tool
      : AGENT_TOOL_NAMES.publishSandboxArtifact;

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
