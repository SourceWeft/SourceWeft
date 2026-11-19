import type {
  AgentToolPresentation,
  ArtifactGenerationPhase,
} from "@sourceweft/contracts/agent-tools";

/**
 * Stream event type `validate_video_presentation` reports its progress under.
 * Validation installs dependencies, renders frames and the final MP4 inside the
 * sandbox and takes minutes; without these events the chat shows nothing between
 * the call starting and its result.
 */
export const VALIDATE_VIDEO_PRESENTATION_PROGRESS_EVENT_TYPE =
  "validate_video_presentation_progress";

/**
 * The stages validation reports, in the order it runs them. Kept beside the
 * tool that emits them so the wire vocabulary and its display copy stay
 * together.
 */
export const VIDEO_VALIDATION_STAGES = [
  "install",
  "typecheck",
  "smoke",
  "samples",
  "review",
  "render",
  "saving",
] as const;

export type VideoValidationStage = (typeof VIDEO_VALIDATION_STAGES)[number];

const STAGE_COPY: Record<
  VideoValidationStage,
  { item: string; description: string }
> = {
  install: {
    item: "Installing project dependencies",
    description:
      "The video project's pinned dependencies are being installed in the sandbox.",
  },
  typecheck: {
    item: "Type-checking the scenes",
    description: "The scene code is being built and type-checked.",
  },
  smoke: {
    item: "Smoke-testing the render",
    description: "Every scene is being rendered once to catch runtime errors.",
  },
  samples: {
    item: "Rendering preview frames",
    description:
      "Beginning, middle and end frames of every scene are being rendered.",
  },
  review: {
    item: "Reviewing the frames",
    description: "A vision model is reviewing the middle frame of every scene.",
  },
  render: {
    item: "Rendering the final video",
    description: "The final MP4 and its cover are being rendered.",
  },
  saving: {
    item: "Saving the render",
    description:
      "The rendered video and cover are being stored for publishing.",
  },
};

const PHASE_TITLES: Partial<Record<ArtifactGenerationPhase, string>> = {
  completed: "Video presentation validated",
  failed: "Video presentation validation failed",
};

const PHASE_ITEMS: Partial<Record<ArtifactGenerationPhase, string>> = {
  completed: "Validated and rendered the video",
  failed: "Validation did not pass",
};

function isVideoValidationStage(value: string): value is VideoValidationStage {
  return (VIDEO_VALIDATION_STAGES as readonly string[]).includes(value);
}

export const validateVideoPresentationPresentation: AgentToolPresentation = {
  progressEventTypes: [VALIDATE_VIDEO_PRESENTATION_PROGRESS_EVENT_TYPE],
  title({ status, toolOutput, readOutputField }) {
    if (status === "running") {
      return "Validating video presentation";
    }
    if (status === "error") {
      return PHASE_TITLES.failed!;
    }
    return readOutputField(toolOutput, "status") === "passed"
      ? PHASE_TITLES.completed!
      : PHASE_TITLES.failed!;
  },
  // The call ends "completed" even when the validation verdict is "failed", so
  // the verdict, not the call status, decides how the step closes.
  artifactCompletionPhase({ status, toolOutput, readOutputField }) {
    if (status !== "completed") {
      return "failed";
    }
    return readOutputField(toolOutput, "status") === "passed"
      ? "completed"
      : "failed";
  },
  stageStep({ stageId }) {
    if (!isVideoValidationStage(stageId)) {
      return null;
    }
    const copy = STAGE_COPY[stageId];
    return {
      item: copy.item,
      phase: "generating",
      description: copy.description,
    };
  },
  generationStep({ phase, error }) {
    return {
      stepId: "video-validation",
      artifactType: "video_presentation",
      title: PHASE_TITLES[phase] ?? "Validating video presentation",
      item: PHASE_ITEMS[phase] ?? "Starting validation",
      description:
        phase === "failed"
          ? (error ?? "The video did not pass validation and was not rendered.")
          : phase === "completed"
            ? "The draft, its resources and the rendered MP4 passed validation."
            : "The draft is being checked and rendered in the sandbox.",
    };
  },
  describe() {
    return "Validated the video presentation draft.";
  },
};
