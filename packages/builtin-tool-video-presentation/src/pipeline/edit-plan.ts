import type {
  VideoPresentationCreateRequest,
  VideoPresentationProjectPayload,
} from "@sourceweft/contracts/video-presentation";

/**
 * An edit run regenerates an already-published artifact in place. Targeted
 * edits (`slideNumbers`) preserve every untouched slide's storyboard entry,
 * narration audio (with its measured duration) and scene code byte-for-byte;
 * a full edit (no slide numbers) regenerates all slides but still publishes
 * as a new version of the same artifact and never destroys the previous
 * version on failure.
 */
export type VideoEditPlan = {
  /** null = regenerate every slide (full edit). */
  readonly slideNumbers: ReadonlySet<number> | null;
  readonly instruction: string;
};

export function resolveVideoEditPlan(input: {
  state: VideoPresentationProjectPayload;
  request: VideoPresentationCreateRequest;
  jobArtifactId: string;
}): VideoEditPlan | null {
  const regeneration = input.request.regeneration;
  if (
    !regeneration?.artifactId ||
    regeneration.artifactId !== input.jobArtifactId
  ) {
    return null;
  }
  // A targeted edit needs a complete base to preserve untouched slides.
  if (
    input.state.slides.length === 0 ||
    input.state.sceneModules.length === 0
  ) {
    return null;
  }
  const validSlideNumbers = new Set(
    input.state.slides.map((slide) => slide.slideNumber),
  );
  const targets = (regeneration.slideNumbers ?? []).filter((slideNumber) =>
    validSlideNumbers.has(slideNumber),
  );
  return {
    slideNumbers: targets.length > 0 ? new Set(targets) : null,
    instruction:
      regeneration.instruction?.trim() ||
      "Regenerate these slides with improvements while keeping the same topic.",
  };
}

export function isSlideTargeted(plan: VideoEditPlan, slideNumber: number) {
  return plan.slideNumbers === null || plan.slideNumbers.has(slideNumber);
}

export function editTargetSlideNumbers(
  plan: VideoEditPlan,
  state: VideoPresentationProjectPayload,
): number[] {
  return state.slides
    .map((slide) => slide.slideNumber)
    .filter((slideNumber) => isSlideTargeted(plan, slideNumber));
}
