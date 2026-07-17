import {
  videoPresentationProjectPayloadSchema,
  type VideoPresentationProjectPayload,
} from "@sourceweft/contracts/video-presentation";

export function parseVideoPresentationProject(
  value: unknown,
): VideoPresentationProjectPayload | null {
  const result = videoPresentationProjectPayloadSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function getSceneModuleForSlide(
  payload: VideoPresentationProjectPayload,
  slideNumber: number,
) {
  return payload.sceneModules.find((scene) => scene.slideNumber === slideNumber);
}

export function getAudioTrackForSlide(
  payload: VideoPresentationProjectPayload,
  slideNumber: number,
) {
  return payload.audioTracks.find((track) => track.slideNumber === slideNumber);
}

export function getSlideDurationInFrames(
  payload: VideoPresentationProjectPayload,
  slideNumber: number,
) {
  return (
    getSceneModuleForSlide(payload, slideNumber)?.durationInFrames ??
    Math.max(
      1,
      Math.ceil(
        (getAudioTrackForSlide(payload, slideNumber)?.durationSeconds ?? 5) *
          payload.project.fps,
      ),
    )
  );
}

export function getVideoDurationInFrames(
  payload: VideoPresentationProjectPayload,
) {
  return payload.slides.reduce(
    (sum, slide) => sum + getSlideDurationInFrames(payload, slide.slideNumber),
    0,
  );
}

export function getVideoDurationSeconds(
  payload: VideoPresentationProjectPayload,
) {
  return Number(
    (getVideoDurationInFrames(payload) / payload.project.fps).toFixed(2),
  );
}
