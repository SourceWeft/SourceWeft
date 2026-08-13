import {
  VIDEO_PRESENTATION_NARRATION_TAIL_PADDING_SECONDS,
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
  const audioTrack = getAudioTrackForSlide(payload, slideNumber);
  // The audio floor MUST include the same tail padding scene-gen bakes into
  // sceneModules[].durationInFrames — otherwise this safety net (and the
  // no-scene-module fallback below) silently drops the 0.75s buffer that keeps
  // the narration from being clipped at the <Sequence> boundary, which is where
  // MP3 encoder priming latency lives. Keep this in lockstep with
  // generateSceneModules in scene-gen.ts.
  const audioFrames = audioTrack
    ? Math.max(
        1,
        Math.ceil(
          (audioTrack.durationSeconds +
            VIDEO_PRESENTATION_NARRATION_TAIL_PADDING_SECONDS) *
            payload.project.fps,
        ),
      )
    : Math.max(1, Math.ceil(5 * payload.project.fps));
  const sceneFrames = getSceneModuleForSlide(
    payload,
    slideNumber,
  )?.durationInFrames;
  if (sceneFrames === undefined) {
    return audioFrames;
  }
  // Safety net: a Sequence clips its <Audio>, so never let the scene run
  // shorter than its narration (plus the tail pad) even if the payload's frame
  // count disagrees.
  return audioTrack ? Math.max(sceneFrames, audioFrames) : sceneFrames;
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
