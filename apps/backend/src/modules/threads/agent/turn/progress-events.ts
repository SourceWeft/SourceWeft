import {
  AGENT_TOOL_NAMES,
  hasAgentToolCapability,
} from "@sourceweft/agent-tool-registry";
import { GENERATED_IMAGE_PROGRESS_EVENT_TYPE } from "@sourceweft/builtin-tool-generate-image";
import {
  GENERATED_VIDEO_PRESENTATION_PROGRESS_EVENT_TYPE,
} from "@sourceweft/builtin-tool-video-presentation";
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

export const PUBLISH_ARTIFACT_PROGRESS_EVENT_TYPE =
  "publish_artifact_progress";

const PRESENTATION_GENERATION_STEP_ID = "presentation-generation";
const VIDEO_PRESENTATION_GENERATION_STEP_ID = "video-presentation-generation";
const GENERATE_VIDEO_PRESENTATION_TOOL_NAME = "generate_video_presentation";

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
              : "publish_artifact did not create an artifact");
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
      tool: input.tool ?? AGENT_TOOL_NAMES.publishArtifact,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(typeof input.latencyMs === "number"
        ? { latencyMs: input.latencyMs }
        : {}),
    },
  };
}

export function buildVideoPresentationGenerationStep(input: {
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
      ? "Video presentation ready"
      : input.phase === "failed"
        ? "Video presentation failed"
        : "Building video presentation";
  const item =
    input.item ??
    (input.phase === "planning"
      ? "Planning video presentation artifact"
      : input.phase === "generating"
        ? "Creating video project request"
        : input.phase === "saving"
          ? "Queueing background video project build"
          : input.phase === "repairing"
            ? "Repairing video project request"
            : input.phase === "completed"
              ? "Video project ready"
              : "generate_video_presentation did not create a ready artifact");
  const description =
    input.description ??
    (input.phase === "completed"
      ? "The video presentation project is ready for browser preview and export."
      : input.phase === "failed"
        ? (input.error ??
          "The video presentation worker failed before producing a ready project.")
        : "The worker is building narration, visual themes, and scene modules.");

  return {
    id: VIDEO_PRESENTATION_GENERATION_STEP_ID,
    kind: "state",
    title,
    status: isActive ? "in_progress" : "completed",
    items: [item],
    description,
    metadata: {
      artifactType: "video_presentation",
      phase: input.phase,
      tool: input.tool ?? GENERATE_VIDEO_PRESENTATION_TOOL_NAME,
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
  const isVideoTool =
    typeof input.data.tool === "string" &&
    hasAgentToolCapability(input.data.tool, "video_presentation_artifact");
  const tool =
    typeof input.data.tool === "string" &&
    (hasAgentToolCapability(input.data.tool, "presentation_artifact") ||
      isVideoTool)
      ? input.data.tool
      : AGENT_TOOL_NAMES.publishArtifact;
  const stage =
    typeof input.data.stage === "string" ? input.data.stage.trim() : "";
  const buildStep = isVideoTool
    ? buildVideoPresentationGenerationStep
    : buildPresentationGenerationStep;
  switch (stage) {
    case "planning":
      return buildStep({
        phase: "planning",
        tool,
        toolCallId: input.toolCallId,
      });
    case "generating":
      return buildStep({
        description: isVideoTool
          ? "The worker is building the video presentation project."
          : "The generated PPTX is being validated before publishing.",
        item: isVideoTool
          ? "Building video project"
          : "Validating generated PPTX",
        phase: "generating",
        tool,
        toolCallId: input.toolCallId,
      });
    case "generating_project_code":
      return buildStep({
        item: "Generating Remotion project code",
        phase: "generating",
        tool,
        toolCallId: input.toolCallId,
      });
    case "installing_project":
      return buildStep({
        item: "Installing project dependencies",
        phase: "generating",
        tool,
        toolCallId: input.toolCallId,
      });
    case "typechecking_project":
      return buildStep({
        item: "Typechecking generated project",
        phase: "generating",
        tool,
        toolCallId: input.toolCallId,
      });
    case "rendering_smoke_preview":
      return buildStep({
        item: "Rendering smoke preview",
        phase: "generating",
        tool,
        toolCallId: input.toolCallId,
      });
    case "planning_storyboard":
      return buildStep({
        item: "Planning storyboard",
        phase: "generating",
        tool,
        toolCallId: input.toolCallId,
      });
    case "materializing_assets":
      return buildStep({
        item: "Preparing visual assets",
        phase: "generating",
        tool,
        toolCallId: input.toolCallId,
      });
    case "generating_audio_tracks":
      return buildStep({
        item: "Generating narration audio",
        phase: "generating",
        tool,
        toolCallId: input.toolCallId,
      });
    case "assigning_slide_themes":
      return buildStep({
        item: "Assigning visual themes",
        phase: "generating",
        tool,
        toolCallId: input.toolCallId,
      });
    case "generating_scene_modules":
      return buildStep({
        item: "Generating Remotion scene code",
        phase: "generating",
        tool,
        toolCallId: input.toolCallId,
      });
    case "repairing_scene_modules":
      return buildStep({
        item: "Repairing scene code",
        phase: "repairing",
        tool,
        toolCallId: input.toolCallId,
      });
    case "publishing_video_project":
      return buildStep({
        item: "Publishing ready video project",
        phase: "saving",
        tool,
        toolCallId: input.toolCallId,
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
        tool,
        toolCallId: input.toolCallId,
      });
    case "saving":
      return buildStep({
        phase: "saving",
        tool,
        toolCallId: input.toolCallId,
      });
    case "ready":
      return buildStep({
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
  if (
    !hasAgentToolCapability(input.progressEvent.tool, "presentation_artifact") &&
    !hasAgentToolCapability(
      input.progressEvent.tool,
      "video_presentation_artifact",
    )
  ) {
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
  if (
    !record ||
    (record.type !== PUBLISH_ARTIFACT_PROGRESS_EVENT_TYPE &&
      record.type !== GENERATED_VIDEO_PRESENTATION_PROGRESS_EVENT_TYPE)
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

  const tool =
    record.type === GENERATED_VIDEO_PRESENTATION_PROGRESS_EVENT_TYPE
      ? GENERATE_VIDEO_PRESENTATION_TOOL_NAME
      : typeof record.tool === "string" &&
          hasAgentToolCapability(record.tool, "presentation_artifact")
        ? record.tool
        : AGENT_TOOL_NAMES.publishArtifact;

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
