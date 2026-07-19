import type {
  AgentToolPresentation,
  ArtifactGenerationPhase,
} from "@sourceweft/contracts/agent-tools";

/** Stages every deliverable reports, worded for deck publishing. */
const SHARED_STAGE_STEPS: Record<
  string,
  { item: string; phase: ArtifactGenerationPhase; description?: string }
> = {
  generating: {
    item: "Validating generated PPTX",
    phase: "generating",
    description: "The generated PPTX is being validated before publishing.",
  },
  retrying: { item: "Retrying presentation generation", phase: "generating" },
};

type Context = Parameters<AgentToolPresentation["title"]>[0];

function needsSlideContent(context: Context) {
  const type = context
    .readOutputField(context.toolOutput, "type")
    ?.toLowerCase()
    .trim();
  const status = context
    .readOutputField(context.toolOutput, "status")
    ?.toLowerCase()
    .trim();
  return (
    type === "presentation_artifact_input_required" || status === "needs_content"
  );
}

function hasArtifactUrl(context: Context) {
  return Boolean(
    context.readOutputField(context.toolOutput, "artifact_url") ??
      context.readOutputField(context.toolOutput, "pptx_url") ??
      context.readOutputField(context.toolOutput, "artifactUrl") ??
      context.readOutputField(context.toolOutput, "pptxUrl"),
  );
}

/**
 * Deck publishing copy. The tool can return without an artifact — it asks for
 * slide content, or it completes with no URL — and each case reads differently
 * to the user, so the end title is derived from the output rather than fixed.
 */

const DECK_STEP_ITEMS: Record<string, string> = {
  planning: "Preparing presentation artifact",
  generating: "Validating generated PPTX",
  saving: "Publishing presentation artifact",
  repairing: "Adding explicit slide content",
  completed: "Presentation artifact created",
  failed: "publish_artifact did not create an artifact",
};

const DECK_STEP_TITLES: Record<string, string> = {
  completed: "Published presentation",
  failed: "Presentation publishing incomplete",
};

const DECK_STEP_DESCRIPTIONS: Record<string, string> = {
  planning: "Preparing the generated presentation for artifact publishing.",
  generating: "The generated PPTX is being validated before publishing.",
  saving: "The presentation artifact is being saved.",
  repairing: "The deck tool needs a complete deck plan before artifact creation.",
  completed: "The presentation artifact was published.",
};

export const publishArtifactPresentation: AgentToolPresentation = {
  renderAs: "pptx",
  progressEventTypes: ["publish_artifact_progress"],
  title(context) {
    if (context.status === "running") {
      return "Publishing presentation";
    }
    if (context.status === "error") {
      return "Presentation publishing failed";
    }
    if (context.toolOutput === undefined) {
      return "Published deck";
    }
    if (needsSlideContent(context)) {
      return "Deck content needed";
    }
    if (!hasArtifactUrl(context)) {
      return "Deck publishing incomplete";
    }
    return "Published deck";
  },
  stageStep({ stageId }) {
    return SHARED_STAGE_STEPS[stageId] ?? null;
  },
  generationStep({ phase, error }) {
    return {
      stepId: "presentation-generation",
      artifactType: "slides",
      title: DECK_STEP_TITLES[phase] ?? "Publishing presentation",
      item: DECK_STEP_ITEMS[phase] ?? DECK_STEP_ITEMS.planning!,
      description:
        DECK_STEP_DESCRIPTIONS[phase] ??
        error ??
        "The presentation publisher did not return a usable artifact.",
    };
  },
  describe(context) {
    if (
      context.metadata.resultType === "presentation_artifact_input_required" ||
      context.metadata.status === "needs_content"
    ) {
      return "The deck tool needs explicit slide content before it can create an artifact.";
    }
    if (!context.metadata.artifactUrl) {
      return "The deck tool completed without returning an artifact URL.";
    }
    return "Created a presentation artifact.";
  },
};
