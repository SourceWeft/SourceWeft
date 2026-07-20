/**
 * The stage words the user sees for a video presentation — one source.
 *
 * Every surface that names a stage (the streamed thinking trace, the artifact
 * preview panel, the persisted pipeline steps, the tool's own progress steps)
 * resolves it here, so the same stage cannot be worded two ways depending on
 * which path rendered it.
 *
 * The eleven pipeline stages keep their words in the pipeline stage table
 * (`getVideoPresentationPipelineStepLabel`) — that table is what the persisted
 * `pipelineSteps` render from, and re-typing those words here is exactly the
 * drift this module exists to prevent. This file adds only the stages the
 * payload reports that are *not* pipeline steps, plus legacy stage aliases.
 *
 * Labels carry no trailing punctuation: callers append their own progress
 * suffixes ("… 43%"), and a baked-in ellipsis reads wrong next to them.
 */
import {
  VIDEO_PRESENTATION_PIPELINE_STAGE_IDS,
  getVideoPresentationPipelineStepLabel,
  type VideoPresentationPipelineStageId,
} from "./pipeline-stages";

/**
 * Stages the worker reports that never become pipeline steps: they bracket the
 * pipeline (planning / project scaffolding) or terminate it.
 */
const NON_PIPELINE_STAGE_LABELS: Record<string, string> = {
  planning: "Planning video scenes",
  generating_project_code: "Generating Remotion project code",
  ready: "Ready for browser video export",
  failed: "Video project failed",
};

/**
 * Stage ids that only appear in payloads written by older workers. They are
 * folded onto the stage that replaced them rather than getting their own words.
 */
const STAGE_ID_ALIASES: Record<string, VideoPresentationPipelineStageId> = {
  normalizing_blueprint: "planning_storyboard",
};

function isPipelineStageId(
  value: string,
): value is VideoPresentationPipelineStageId {
  return (
    VIDEO_PRESENTATION_PIPELINE_STAGE_IDS as readonly string[]
  ).includes(value);
}

/**
 * The user-facing words for one generation stage, or null when the id is not a
 * stage this capability knows — callers decide their own fallback copy.
 */
export function getVideoPresentationStageLabel(
  stageId: string | null | undefined,
): string | null {
  if (!stageId) {
    return null;
  }
  const canonical = STAGE_ID_ALIASES[stageId] ?? stageId;
  const nonPipeline = NON_PIPELINE_STAGE_LABELS[canonical];
  if (nonPipeline) {
    return nonPipeline;
  }
  return isPipelineStageId(canonical)
    ? getVideoPresentationPipelineStepLabel(canonical)
    : null;
}

/** Every stage id that resolves to a label, aliases included. */
export const VIDEO_PRESENTATION_LABELLED_STAGE_IDS: readonly string[] = [
  ...Object.keys(NON_PIPELINE_STAGE_LABELS),
  ...VIDEO_PRESENTATION_PIPELINE_STAGE_IDS,
  ...Object.keys(STAGE_ID_ALIASES),
];
