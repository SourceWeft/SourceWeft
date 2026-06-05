import type {
  VideoPresentationAudioTrack,
  VideoPresentationSpec,
} from "@sourceweft/contracts/video-presentation";

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

export function compactVideoPresentationText(value: string, maxLength = 800) {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, maxLength - 3).trimEnd()}...`;
}

export function stripVideoPresentationMarkdown(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\s*\[\s*citation:[^\]]+]\s*/gi, " ")
    .replace(/\s*【\s*citation:[^】]+】\s*/gi, " ")
    .replace(/\s*\(\s*citation:[^)]+\)\s*/gi, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactVideoPresentationSourceText(
  value: string,
  maxLength = 800,
) {
  return compactVideoPresentationText(
    stripVideoPresentationMarkdown(value),
    maxLength,
  );
}

export function sanitizeVideoPresentationFileBase(value: string) {
  const sanitized = value
    .trim()
    .replace(/[/\\?%*:|"<>]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return sanitized || "video-presentation";
}

export function buildVideoPresentationProjectFileName(value: string) {
  return `${sanitizeVideoPresentationFileBase(value)}.video-presentation.json`;
}

export function buildArtifactAssetUrl(input: {
  artifactId: string;
  fileName: string;
  workspaceId: string;
}) {
  return `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/artifacts/${encodeURIComponent(input.artifactId)}/assets/${encodeURIComponent(input.fileName)}`;
}

export function estimateNarrationDurationSeconds(text: string) {
  const compacted = compactVideoPresentationText(text, 10_000);
  if (!compacted) {
    return 5;
  }
  const cjkChars = compacted.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
  const latinWords = compacted.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g)?.length ?? 0;
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
) {
  return spec.audioTracks.find((track) => track.slideNumber === slideNumber);
}

export function getSlideDurationSeconds(
  spec: RenderableVideoPresentationSpec,
  slideNumber: number,
) {
  const track = getAudioTrackForSlide(spec, slideNumber);
  if (track?.durationSeconds && track.durationSeconds > 0) {
    return Math.max(4.5, track.durationSeconds + 0.85);
  }
  const slide = spec.slides.find((candidate) => candidate.slideNumber === slideNumber);
  const text = slide
    ? stripVideoPresentationMarkdown(slide.speakerTranscript.join(" "))
    : "";
  return estimateNarrationDurationSeconds(text) + 0.85;
}

export function getSlideDurationInFrames(
  spec: RenderableVideoPresentationSpec,
  slideNumber: number,
) {
  return Math.max(1, Math.ceil(getSlideDurationSeconds(spec, slideNumber) * spec.fps));
}

export function getVideoDurationInFrames(spec: RenderableVideoPresentationSpec) {
  return spec.slides.reduce(
    (sum, slide) => sum + getSlideDurationInFrames(spec, slide.slideNumber),
    0,
  );
}

export function getVideoDurationSeconds(spec: RenderableVideoPresentationSpec) {
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
