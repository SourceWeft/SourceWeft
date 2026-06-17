import type {
  VideoPresentationAudioTrack,
  VideoPresentationSpec,
} from "@sourceweft/contracts/video-presentation";
import { compactArtifactText } from "./artifact-text";
import { stripVideoPresentationMarkdown } from "./video-presentation-files";

export type RenderableVideoPresentationAudioTrack =
  VideoPresentationAudioTrack & {
    narration?: string;
    provider?: string;
    providerModel?: string;
    renderSrc?: string;
    sizeBytes?: number;
  };

export type RenderableVideoPresentationSpec = Omit<
  VideoPresentationSpec,
  "audioTracks"
> & {
  audioTracks: RenderableVideoPresentationAudioTrack[];
};

export function compactVideoPresentationText(
  value: string,
  maxLength = 800,
): string {
  return compactArtifactText(value, maxLength);
}

export function estimateNarrationDurationSeconds(text: string): number {
  const compacted = compactVideoPresentationText(text, 10_000);
  if (!compacted) {
    return 5;
  }
  const cjkChars = compacted.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
  const latinWords =
    compacted.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g)?.length ?? 0;
  const punctuationPauses =
    compacted.match(/[.!?。！？;；:：]/gu)?.length ?? 0;
  const byCjk = cjkChars / 4.8;
  const byWords = latinWords / 2.55;
  const estimated = Math.max(byCjk, byWords) + punctuationPauses * 0.25 + 1.2;
  return Math.min(48, Math.max(4.5, Number(estimated.toFixed(2))));
}

export function getAudioTrackForSlide(
  spec: RenderableVideoPresentationSpec,
  slideNumber: number,
): RenderableVideoPresentationAudioTrack | undefined {
  return spec.audioTracks.find((track) => track.slideNumber === slideNumber);
}

export function getSlideDurationSeconds(
  spec: RenderableVideoPresentationSpec,
  slideNumber: number,
): number {
  const track = getAudioTrackForSlide(spec, slideNumber);
  if (track?.durationSeconds && track.durationSeconds > 0) {
    return Math.max(4.5, track.durationSeconds + 0.85);
  }
  const slide = spec.slides.find(
    (candidate) => candidate.slideNumber === slideNumber,
  );
  const text = slide
    ? stripVideoPresentationMarkdown(slide.speakerTranscript.join(" "))
    : "";
  return estimateNarrationDurationSeconds(text) + 0.85;
}

export function getSlideDurationInFrames(
  spec: RenderableVideoPresentationSpec,
  slideNumber: number,
): number {
  return Math.max(
    1,
    Math.ceil(getSlideDurationSeconds(spec, slideNumber) * spec.fps),
  );
}

export function getVideoDurationInFrames(
  spec: RenderableVideoPresentationSpec,
): number {
  return spec.slides.reduce(
    (sum, slide) => sum + getSlideDurationInFrames(spec, slide.slideNumber),
    0,
  );
}

export function getVideoDurationSeconds(
  spec: RenderableVideoPresentationSpec,
): number {
  return Number((getVideoDurationInFrames(spec) / spec.fps).toFixed(2));
}

export function stripRenderOnlyAudioFields(
  tracks: RenderableVideoPresentationAudioTrack[],
): VideoPresentationAudioTrack[] {
  return tracks.map((track) => ({
    assetUrl: track.assetUrl,
    durationSeconds: track.durationSeconds,
    fileName: track.fileName,
    mimeType: track.mimeType,
    slideNumber: track.slideNumber,
    ...(track.storageBucket ? { storageBucket: track.storageBucket } : {}),
    storageKey: track.storageKey,
  }));
}
