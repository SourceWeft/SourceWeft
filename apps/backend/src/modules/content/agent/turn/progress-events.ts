import { AGENT_TOOL_NAMES } from "../tool-registry";
import { GENERATED_IMAGE_PROGRESS_EVENT_TYPE } from "../tools/generate-image-tool";
import { GENERATED_VIDEO_PRESENTATION_PROGRESS_EVENT_TYPE } from "../tools/generate-video-presentation-tool";
import type {
  CommandSuccessCriteria,
  ThinkingStepTrace,
  ToolCallTrace,
} from "../../threads";
import { toObjectRecord } from "./content";
import type { DeepAgentTurnEvent } from "./events";

export type GeneratedArtifactProgressEvent = {
  toolCallId: string;
  tool: string;
  data: Record<string, unknown>;
};

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
    criteria.toolName === AGENT_TOOL_NAMES.generatePptx
  );
}

export function buildPresentationGenerationStep(input: {
  description?: string;
  error?: string | null;
  item?: string;
  latencyMs?: number | null;
  phase: PresentationGenerationStepPhase;
  toolCallId?: string;
}): Omit<ThinkingStepTrace, "sequence"> {
  const isActive =
    input.phase === "planning" ||
    input.phase === "generating" ||
    input.phase === "saving" ||
    input.phase === "repairing";
  const title =
    input.phase === "completed"
      ? "Generated presentation"
      : input.phase === "failed"
        ? "Presentation generation incomplete"
        : "Generating presentation";
  const item =
    input.item ??
    (input.phase === "planning"
      ? "Planning deck content and visual structure"
      : input.phase === "generating"
        ? "Calling generate_pptx"
        : input.phase === "saving"
          ? "Saving presentation artifact"
          : input.phase === "repairing"
            ? "Adding explicit slide content"
            : input.phase === "completed"
              ? "Presentation artifact created"
              : "generate_pptx did not create an artifact");
  const description =
    input.description ??
    (input.phase === "planning"
      ? "Planning the deck before calling the presentation generator."
      : input.phase === "generating"
        ? "The presentation generator is creating the PPTX artifact."
        : input.phase === "saving"
          ? "The presentation artifact is being saved."
          : input.phase === "repairing"
            ? "The deck tool needs a complete deck plan before artifact creation."
            : input.phase === "completed"
              ? "The presentation artifact was created."
              : (input.error ??
                "The presentation generator did not return a usable artifact."));

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
      tool: AGENT_TOOL_NAMES.generatePptx,
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
  const stage =
    typeof input.data.stage === "string" ? input.data.stage.trim() : "";
  switch (stage) {
    case "planning":
      return buildPresentationGenerationStep({
        phase: "planning",
        toolCallId: input.toolCallId,
      });
    case "generating":
      return buildPresentationGenerationStep({
        description: "The presentation generator is rendering the slides.",
        item: "Rendering slides",
        phase: "generating",
        toolCallId: input.toolCallId,
      });
    case "saving":
      return buildPresentationGenerationStep({
        phase: "saving",
        toolCallId: input.toolCallId,
      });
    case "ready":
      return buildPresentationGenerationStep({
        phase: "completed",
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
  if (input.progressEvent.tool !== AGENT_TOOL_NAMES.generatePptx) {
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
  if (!record || record.type !== "generate_pptx_progress") {
    return null;
  }

  const toolCallId =
    typeof record.toolCallId === "string" && record.toolCallId.length > 0
      ? record.toolCallId
      : null;
  if (!toolCallId) {
    return null;
  }

  const tool = AGENT_TOOL_NAMES.generatePptx;

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

export function normalizeGeneratedVideoPresentationProgressEvent(
  payload: unknown,
): GeneratedArtifactProgressEvent | null {
  const record = toObjectRecord(payload);
  if (
    !record ||
    record.type !== GENERATED_VIDEO_PRESENTATION_PROGRESS_EVENT_TYPE
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

  const tool = AGENT_TOOL_NAMES.generateVideoPresentation;

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
