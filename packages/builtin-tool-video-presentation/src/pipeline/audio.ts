import type {
  VideoPresentationAudioTrack,
  VideoPresentationCreateRequest,
  VideoPresentationProjectPayload,
} from "@sourceweft/contracts/video-presentation";
import type { VideoPipelineDeps } from "./deps";
import {
  estimateNarrationDurationSeconds,
  requestNarrationEnabled,
} from "./storyboard";
import { safeStorageSegment } from "./util";

export function extensionForMimeType(mimeType: string) {
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("aac")) return "aac";
  if (mimeType.includes("opus")) return "opus";
  if (mimeType.includes("flac")) return "flac";
  return "mp3";
}

export function audioAssetUrl(input: {
  artifactId: string;
  fileName: string;
  workspaceId: string;
}) {
  return `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/artifacts/${encodeURIComponent(input.artifactId)}/assets/${encodeURIComponent(input.fileName)}`;
}

export async function generateAudioTracks(input: {
  artifactId: string;
  deps: VideoPipelineDeps;
  payload: VideoPresentationProjectPayload;
  request: VideoPresentationCreateRequest;
  workspaceId: string;
  /**
   * Edit runs: regenerate narration only for these slides; every other
   * slide reuses its existing track (same file, same measured duration).
   */
  onlySlideNumbers?: ReadonlySet<number>;
  onTrackReady?: (input: {
    completed: number;
    total: number;
    tracks: VideoPresentationAudioTrack[];
  }) => Promise<void>;
}) {
  if (!requestNarrationEnabled(input.request)) {
    return [] satisfies VideoPresentationAudioTrack[];
  }

  const baseName = safeStorageSegment(input.payload.project.title);
  const total = input.payload.slides.length;
  const tracks: VideoPresentationAudioTrack[] = new Array(total);
  const existingBySlide = new Map(
    input.payload.audioTracks.map((track) => [track.slideNumber, track]),
  );
  let completed = 0;
  let progressChain: Promise<void> = Promise.resolve();
  const publishTrackProgress = (args: {
    completed: number;
    total: number;
    tracks: VideoPresentationAudioTrack[];
  }) => {
    if (!input.onTrackReady) {
      return Promise.resolve();
    }
    const next = progressChain.then(() => input.onTrackReady?.(args));
    progressChain = next.catch(() => undefined);
    return next;
  };

  await Promise.all(
    input.payload.slides.map(async (slide, index) => {
      const existingTrack = existingBySlide.get(slide.slideNumber);
      if (
        input.onlySlideNumbers &&
        !input.onlySlideNumbers.has(slide.slideNumber) &&
        existingTrack
      ) {
        tracks[index] = existingTrack;
        completed += 1;
        await publishTrackProgress({
          completed,
          total,
          tracks: tracks.filter(
            (item): item is VideoPresentationAudioTrack => Boolean(item),
          ),
        });
        return;
      }
      const transcript = slide.speakerTranscript.join(" ");
      let speech: Awaited<
        ReturnType<VideoPipelineDeps["tts"]["speech"]>
      >;
      try {
        speech = await input.deps.tts.speech({
          text: transcript,
          metadata: {
            artifactId: input.artifactId,
            feature: "video_presentation",
            slideNumber: slide.slideNumber,
            workspaceId: input.workspaceId,
          },
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown TTS generation error";
        throw new Error(
          `TTS generation failed for slide ${slide.slideNumber}: ${message}`,
        );
      }
      const mimeType = speech.mimeType || "audio/mpeg";
      const extension = extensionForMimeType(mimeType);
      const fileName = `${baseName}-slide-${slide.slideNumber}.${extension}`;
      const storageKey = input.deps.storage.buildArtifactStorageKey({
        artifactId: input.artifactId,
        fileName,
        workspaceId: input.workspaceId,
      });
      await input.deps.storage.upload({
        body: speech.audio,
        contentType: mimeType,
        key: storageKey,
      });
      const measuredDurationSeconds = await input.deps.audio.probeDurationSeconds({
        buffer: speech.audio,
        mimeType,
      });
      if (measuredDurationSeconds == null) {
        input.deps.logger.warn("video_presentation_audio_duration_fallback_estimate", {
          artifactId: input.artifactId,
          slideNumber: slide.slideNumber,
          mimeType,
        });
      }
      const track = {
        slideNumber: slide.slideNumber,
        assetUrl: audioAssetUrl({
          artifactId: input.artifactId,
          fileName,
          workspaceId: input.workspaceId,
        }),
        storageBucket: input.deps.storage.getBucketName(),
        storageKey,
        durationSeconds:
          measuredDurationSeconds ??
          estimateNarrationDurationSeconds(transcript),
        durationSource: (measuredDurationSeconds != null
          ? "measured"
          : "estimated") as "measured" | "estimated",
        mimeType,
        fileName,
      } satisfies VideoPresentationAudioTrack;
      tracks[index] = track;
      completed += 1;
      await publishTrackProgress({
        completed,
        total,
        tracks: tracks.filter(
          (item): item is VideoPresentationAudioTrack => Boolean(item),
        ),
      });
    }),
  );

  await progressChain;
  return tracks;
}
