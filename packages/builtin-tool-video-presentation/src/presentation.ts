import type {
  AgentToolPresentation,
  ArtifactGenerationPhase,
} from "@sourceweft/contracts/agent-tools";
import { getVideoPresentationStageLabel } from "./stage-labels";

function hasArtifactUrl(
  context: Parameters<AgentToolPresentation["title"]>[0],
) {
  return Boolean(
    context.readOutputField(context.toolOutput, "artifact_url") ??
      context.readOutputField(context.toolOutput, "artifactUrl"),
  );
}

/**
 * Video presentation's user-facing copy. The pipeline runs for minutes after
 * the tool call returns, so the end title reports where the *job* is, not that
 * the call finished.
 */

const VIDEO_STEP_ITEMS: Record<string, string> = {
  planning: "Planning video presentation artifact",
  generating: "Creating video project request",
  saving: "Queueing background video project build",
  repairing: "Repairing video project request",
  completed: "Video project ready",
  failed: "generate_video_presentation did not create a ready artifact",
};

const VIDEO_STEP_TITLES: Record<string, string> = {
  completed: "Video presentation ready",
  failed: "Video presentation failed",
};

/**
 * Which generation phase each stage the worker reports maps onto. Labels are
 * NOT listed here — they come from getVideoPresentationStageLabel, so the
 * streamed step, the persisted pipelineSteps and the web surfaces cannot
 * disagree. Every stage the payload can carry is listed, because the web
 * clients read their stage copy back out of stageStep().
 */
const STAGE_PHASES: Record<string, ArtifactGenerationPhase> = {
  planning: "planning",
  generating_project_code: "generating",
  installing_project: "generating",
  typechecking_project: "generating",
  rendering_smoke_preview: "generating",
  planning_storyboard: "generating",
  // Legacy id for planning_storyboard, still present in stored payloads.
  normalizing_blueprint: "generating",
  materializing_assets: "generating",
  generating_audio_tracks: "generating",
  assigning_slide_themes: "generating",
  generating_scene_modules: "generating",
  repairing_scene_modules: "repairing",
  verifying_visual_quality: "generating",
  publishing_video_project: "saving",
  ready: "completed",
  failed: "failed",
};

/** Stages every deliverable reports, worded for this capability. */
const SHARED_STAGE_STEPS: Record<
  string,
  { item: string; phase: ArtifactGenerationPhase; description?: string }
> = {
  generating: {
    item: "Building video project",
    phase: "generating",
    description: "The worker is building the video presentation project.",
  },
  retrying: { item: "Retrying video generation", phase: "generating" },
  // What a client shows before the job reports any stage of its own.
  preparing: { item: "Preparing video project", phase: "planning" },
};

export const videoPresentationPresentation: AgentToolPresentation = {
  renderAs: "video",
  progressEventTypes: ["generate_video_presentation_progress"],
  title(context) {
    // The tool call returns in ~200ms; the job runs for minutes. So the call's
    // own status only decides the wording while it is live or errored — after
    // that the background job's state is what the user cares about.
    if (context.status === "running") {
      return "Building video presentation";
    }
    if (context.status === "error") {
      return "Video presentation generation failed";
    }
    if (context.generationStatus === "running" || context.generationStatus === "pending") {
      return "Generating video presentation";
    }
    if (context.generationStatus === "failed") {
      return "Video presentation failed";
    }
    if (context.toolOutput === undefined) {
      return "Video presentation ready";
    }
    const outputStatus = context.readOutputField(context.toolOutput, "status");
    if (outputStatus === "failed") {
      return "Video presentation failed";
    }
    if (!hasArtifactUrl(context)) {
      return "Video presentation not ready";
    }
    if (outputStatus === "running") {
      return "Video presentation generating";
    }
    return "Video presentation ready";
  },
  // The call returns as soon as the project is queued, so a URL alone means
  // nothing here — only the worker's own status does. The call's own status is
  // deliberately not consulted: the job outlives it, and a queued project still
  // reaches "ready" after a call that ended badly.
  artifactCompletionPhase(context) {
    if (!hasArtifactUrl(context)) {
      return "failed";
    }
    const status = context.readOutputField(context.toolOutput, "status");
    if (status === "ready") {
      return "completed";
    }
    // Queued and still rendering — the artifact row exists, the video does not.
    return status === "running" ? "saving" : "failed";
  },
  stageStep({ stageId }) {
    const shared = SHARED_STAGE_STEPS[stageId];
    if (shared) {
      return shared;
    }
    const phase = STAGE_PHASES[stageId];
    const item = getVideoPresentationStageLabel(stageId);
    return phase && item ? { item, phase } : null;
  },
  generationStep({ phase, error }) {
    return {
      stepId: "video-presentation-generation",
      artifactType: "video_presentation",
      title: VIDEO_STEP_TITLES[phase] ?? "Building video presentation",
      item: VIDEO_STEP_ITEMS[phase] ?? VIDEO_STEP_ITEMS.planning!,
      description:
        phase === "completed"
          ? "The video presentation project is ready for browser preview and export."
          : phase === "failed"
            ? (error ??
              "The video presentation worker failed before producing a ready project.")
            : "The worker is building narration, visual themes, and scene modules.",
    };
  },
};
