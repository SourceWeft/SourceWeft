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
import { requestNarrationEnabled } from "./storyboard";
import { extensionForMimeType as artifactExtensionForMimeType } from "@sourceweft/contracts/artifact-files";
import { artifactAssetUrl, safeStorageSegment } from "./util";

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
      const measuredDurationSeconds = await input.deps.audio.probeDurationSeconds(
        { buffer: speech.audio, mimeType },
      );
      if (measuredDurationSeconds == null) {
        // A failed probe used to fall back to a word-count guess. It must not:
        // this number becomes the scene's frame count (`scene-gen.ts`), so a
        // guess that runs short leaves the scene short by the same amount and
        // the slide's speech is cut off at the <Sequence> boundary — in the
        // browser preview and, now that an mp4 is published, baked into the
        // deliverable. Nothing downstream could catch it either, because every
        // check compared the guess against a length derived from that same
        // guess.
        //
        // The probe only returns null when the bytes are not decodable audio or
        // imply an impossible byte rate (`probeAudioDurationSeconds`), i.e. the
        // TTS response is broken — the same class of failure as the throw
        // above, and treated the same way. There is no in-place retry because
        // probing is deterministic on the bytes in hand; the retry that can
        // help is a fresh TTS call, which is exactly what re-running this stage
        // from its checkpoint does.
        input.deps.logger.warn("video_presentation_audio_duration_unmeasurable", {
          artifactId: input.artifactId,
          slideNumber: slide.slideNumber,
          mimeType,
          byteLength: speech.audio.byteLength,
        });
        throw new Error(
          `Narration duration could not be measured for slide ${slide.slideNumber} (${mimeType}, ${speech.audio.byteLength} bytes): the generated speech is not decodable audio.`,
        );
      }
      const track = {
        slideNumber: slide.slideNumber,
        assetUrl: artifactAssetUrl({
          artifactId: input.artifactId,
          fileName,
          workspaceId: input.workspaceId,
        }),
        storageBucket: input.deps.storage.getBucketName(),
        storageKey,
        durationSeconds: measuredDurationSeconds,
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
  /**
   * Length measured HERE, from the object that is about to be staged — not
   * copied off `track.durationSeconds`.
   *
   * This is what makes the generated project's smoke check a real check. The
   * scene's frame count came from the measurement taken at TTS time and
   * persisted on the payload; this one is taken independently, at render time,
   * from the bytes that will actually be mixed into the mp4. Comparing the two
   * catches the case the manifest could never catch while both sides were the
   * same number: the stored object no longer being the audio the timeline was
   * built against (an edit run reusing a pointer whose bytes changed, a
   * renumbered deck, a partially overwritten upload).
   */
  durationSeconds: number;
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
  | "download_failed"
  /**
   * The bytes came back but their duration could not be measured. The mp4 is
   * refused rather than rendered against an unverified timeline: an unmeasurable
   * object is either not the audio it claims to be or is corrupt, and both ship
   * as a video whose narration does not line up with its slides.
   */
  | "unmeasurable";

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
   * `deps.audio.probeDurationSeconds`. Passed in rather than reached for so
   * this stays a pure function of its ports — and so the re-measurement is
   * visibly a requirement of staging, not an optional extra: without it the
   * manifest would be back to comparing a number against itself.
   */
  probeDurationSeconds: (input: {
    buffer: Uint8Array;
    mimeType: string;
  }) => Promise<number | null>;
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
    // Second, independent measurement — see StagedNarrationTrack.durationSeconds
    // for why the manifest must not reuse `track.durationSeconds` here.
    const measuredDurationSeconds = await input.probeDurationSeconds({
      buffer: downloaded.body,
      mimeType: track.mimeType,
    });
    if (measuredDurationSeconds == null) {
      return {
        ok: false,
        reason: "unmeasurable",
        slideNumber,
        detail: `${track.mimeType}, ${downloaded.body.byteLength} bytes`,
      };
    }
    tracks.push({
      slideNumber,
      fileName: narrationStagingFileName(track),
      data: downloaded.body,
      durationSeconds: measuredDurationSeconds,
    });
  }
  return { ok: true, tracks };
}
