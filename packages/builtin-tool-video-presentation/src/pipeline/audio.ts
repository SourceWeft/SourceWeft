import type {
  VideoPresentationAudioTrack,
  VideoPresentationCreateRequest,
  VideoPresentationProjectPayload,
} from "@sourceweft/contracts/video-presentation";
import { ARTIFACT_WRITE_ERROR_CODES } from "@sourceweft/contracts/artifact-errors";
import {
  ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES,
  type ArtifactStorage,
} from "@sourceweft/contracts/artifact-storage";
import type { VideoPipelineDeps } from "./deps";
import {
  estimateNarrationDurationSeconds,
  requestNarrationEnabled,
} from "./storyboard";
import { extensionForMimeType as artifactExtensionForMimeType } from "@sourceweft/contracts/artifact-files";
import { safeStorageSegment } from "./util";

/**
 * Extension (with leading dot) for a narration track.
 *
 * Substring matching used to classify `application/x-wav-container` as WAV;
 * matching is exact now, with `.mp3` as the fallback because that is what every
 * supported speech provider returns.
 */
export function extensionForMimeType(mimeType: string | undefined | null) {
  return artifactExtensionForMimeType(mimeType, ".mp3");
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
      const fileName = `${baseName}-slide-${slide.slideNumber}${extension}`;
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

/* -------------------------------------------------------------------------- */
/* Staging narration for the sandbox mp4 render                               */
/* -------------------------------------------------------------------------- */

/** One narration file as the sandbox render wants it, bytes included. */
export type StagedNarrationTrack = {
  slideNumber: number;
  /** Base name inside the project's `public/audio/`. */
  fileName: string;
  data: Uint8Array;
};

/**
 * Why narration could not be assembled in full. Every one of these means the
 * mp4 would be silent or partly silent, which is why they are named apart
 * rather than collapsed into one "no audio" case: an operator has to be able to
 * tell "the TTS object was deleted" from "the object is too big to buffer".
 */
export type NarrationStagingFailureReason =
  /** A slide the composition renders has no narration track on the payload. */
  | "track_missing"
  /** `storage.download` resolved null: the uploaded object is gone. */
  | "object_missing"
  /** Zero bytes came back. An empty audio file is silence, not narration. */
  | "object_empty"
  /** `ARTIFACT_ATTACHMENT_TOO_LARGE` — over the port's download ceiling. */
  | "oversized"
  /** Transport failure reading the object back. */
  | "download_failed";

export type NarrationStagingResult =
  | { ok: true; tracks: StagedNarrationTrack[] }
  | {
      ok: false;
      reason: NarrationStagingFailureReason;
      slideNumber?: number;
      detail?: string;
    };

/**
 * Deterministic, ASCII, one-per-slide name for a staged narration file.
 *
 * Deliberately not `track.fileName` (the artifact-asset name, which is derived
 * from the deck title): the sandbox name only has to be stable and collision
 * free, and keeping it independent means a title change cannot alter what the
 * composition's `staticFile("audio/…")` resolves to.
 */
export function narrationStagingFileName(track: VideoPresentationAudioTrack) {
  return `slide-${track.slideNumber}${extensionForMimeType(track.mimeType)}`;
}

function isAttachmentTooLarge(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code ===
      ARTIFACT_WRITE_ERROR_CODES.attachmentTooLarge
  );
}

/**
 * Re-fetch the narration this run already uploaded and hand it back as bytes
 * the sandbox can stage under `public/audio/`.
 *
 * Why the round trip: `generateAudioTracks` uploads each track and keeps only
 * the pointer, the render happens in a later stage (and possibly a later
 * process, since per-run scratch does not survive a resume), and the sandbox
 * has no network path to the artifact asset route. Reading the object back is
 * the only durable hand-off — see `ArtifactStorage.download`, which exists for
 * exactly this.
 *
 * It is all-or-nothing on purpose. Every failure mode below could instead be
 * "skip this track and render anyway", and the result would be a video that
 * plays, looks finished, and is missing a slide's narration with nothing on the
 * payload able to say so. That is the same trade the per-scene render already
 * settled when it refused to ship a deck with a missing chunk
 * (`sandbox-project.ts`): refusing costs a retry and falls back to the browser
 * preview, which still has all the audio; shipping silence misrepresents the
 * deliverable. The caller degrades to "no mp4", never to "quiet mp4".
 *
 * Buffering is bounded by the port's own ceiling across the *whole* deck, not
 * per track: `maxBytes` is tightened to what is left of the budget, so a 40
 * slide deck can never pull 40 × the ceiling into the worker's heap.
 */
export async function stageNarrationForRender(input: {
  payload: VideoPresentationProjectPayload;
  /**
   * The slides the composition will actually mount, in playback order — pass
   * `renderVideoSlideNumbers(payload)`. Narration is matched against these
   * rather than against `payload.slides`, because a track staged for a slide
   * that has no scene module is never mounted by any `<Sequence>` and would be
   * silently dropped from the mix.
   */
  slideNumbers: readonly number[];
  storage: ArtifactStorage;
  /**
   * False when the request opted out of narration. A deck that was never meant
   * to speak renders silent legitimately; without this flag "no tracks" and
   * "the tracks vanished" would be indistinguishable.
   */
  narrationExpected: boolean;
}): Promise<NarrationStagingResult> {
  if (!input.narrationExpected) {
    return { ok: true, tracks: [] };
  }
  const bySlide = new Map(
    input.payload.audioTracks.map((track) => [track.slideNumber, track]),
  );
  const tracks: StagedNarrationTrack[] = [];
  let remainingBytes = ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES;
  for (const slideNumber of input.slideNumbers) {
    const track = bySlide.get(slideNumber);
    if (!track) {
      // Not reachable through the create path — `speakerTranscript` is
      // `min(1)` and `generateAudioTracks` throws rather than returning a
      // partial set — but an edit run reuses tracks by slide number, so a
      // renumbered deck could land here. It stays a refusal, not an assertion.
      return { ok: false, reason: "track_missing", slideNumber };
    }
    let downloaded;
    try {
      downloaded = await input.storage.download({
        key: track.storageKey,
        ...(track.storageBucket ? { bucket: track.storageBucket } : {}),
        maxBytes: remainingBytes,
      });
    } catch (error) {
      return {
        ok: false,
        reason: isAttachmentTooLarge(error) ? "oversized" : "download_failed",
        slideNumber,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (!downloaded) {
      return { ok: false, reason: "object_missing", slideNumber };
    }
    if (downloaded.body.byteLength === 0) {
      // `download` distinguishes an empty object from a missing one; for
      // narration both are the same outcome (a silent slide) and neither may
      // pass.
      return { ok: false, reason: "object_empty", slideNumber };
    }
    remainingBytes -= downloaded.body.byteLength;
    tracks.push({
      slideNumber,
      fileName: narrationStagingFileName(track),
      data: downloaded.body,
    });
  }
  return { ok: true, tracks };
}
