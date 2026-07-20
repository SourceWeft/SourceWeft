/**
 * Shared kernel for the artifact object-storage port.
 *
 * Exactly one physical implementation exists (the backend's S3 wrapper in
 * `apps/backend/src/modules/sources/storage.ts`), but it used to be reached
 * through three different member vocabularies:
 *
 * | this module                | also known as                  |
 * | -------------------------- | ------------------------------ |
 * | `buildArtifactStorageKey`  | `buildStorageKey`              |
 * | `getBucketName`            | `getContentStorageBucketName`  |
 * | `upload`                   | `uploadArtifactObject`         |
 *
 * Every boundary that crossed two vocabularies had to spell out a renaming
 * adapter object, and each adapter re-declared the parameter shapes inline —
 * so the shapes had quietly drifted too (`Buffer` vs `Uint8Array` bodies,
 * `Promise<void>` vs `Promise<unknown>`). This is the single declaration all
 * of them now share.
 *
 * It lives in `contracts` rather than in any capability package because both
 * the producers (backend) and the consumers (publish-artifact, generate-image,
 * video-presentation) are downstream of it, and it is almost entirely type
 * surface: the one runtime export is the download byte ceiling, which belongs
 * with the method it bounds, and there are still no imports.
 */

/** Namespaces an object under `workspaces/<ws>/artifacts/<artifact>/…`. */
export type ArtifactStorageKeyInput = {
  readonly workspaceId: string;
  readonly artifactId: string;
  /** Display file name; the implementation sanitizes it for the key. */
  readonly fileName: string;
};

export type ArtifactStorageUploadInput = {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
};

/**
 * Hard ceiling on a single `download`, in bytes.
 *
 * The number is the sandbox's default per-file collect budget
 * (`SOURCEWEFT_SANDBOX_MAX_COLLECT_FILE_BYTES`, `apps/backend/src/shared/config.ts`),
 * which the video pipeline had already restated for its mp4 pull rather than
 * stream unbounded bytes into the worker heap. The same reasoning applies here
 * and more sharply: `download` runs inside a worker, against an object whose
 * size is chosen by whatever produced it, so an unbounded read is a
 * memory-exhaustion vector. Buffering is bounded, once, in the port instead of
 * being re-derived by every caller.
 *
 * A caller may pass a *smaller* `maxBytes`; it may not pass a larger one. The
 * ceiling exists precisely so that raising it is a deliberate edit to this
 * constant, reviewed here, and not an argument a capability package can widen
 * on its own.
 */
export const ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export type ArtifactStorageDownloadInput = {
  readonly key: string;
  /**
   * Where the object lives, when the caller read a stored pointer that carries
   * its own bucket (artifact rows do). Omitted/null means `getBucketName()` —
   * the same resolution `upload` uses.
   */
  readonly bucket?: string | null;
  /** Tightens `ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES`; never widens it. */
  readonly maxBytes?: number;
};

export type ArtifactStorageDownloadResult = {
  readonly body: Uint8Array;
  /**
   * The stored content type, so a caller that re-uploads or re-serves the bytes
   * does not have to guess one back from the key. Falls back to
   * `application/octet-stream` when the store recorded none — never absent, so
   * callers do not each invent their own default.
   */
  readonly contentType: string;
};

/** The artifact object-storage port capability tools are handed. */
export interface ArtifactStorage {
  buildArtifactStorageKey(input: ArtifactStorageKeyInput): string;
  getBucketName(): string;
  upload(input: ArtifactStorageUploadInput): Promise<void>;
  /**
   * Read back an object this port wrote.
   *
   * Exists because a multi-stage producer cannot keep its own bytes: the
   * pipeline's per-run scratch is dropped when a job resumes, so a stage that
   * consumes what an earlier stage uploaded (narration audio muxed into a
   * rendered video) would otherwise silently produce output with the earlier
   * stage's contribution missing. Uploading and then reading back is the only
   * durable hand-off, and workers have no network path to the asset route.
   *
   * Resolves `null` when the key does not exist. A missing object is an
   * ordinary, branchable outcome everywhere else in this codebase — the sandbox
   * hands back `content: null`, the host's asset resolver returns null for an
   * artifact that is gone or not ready — and modelling it as an exception would
   * also mint a permanent new error code for a non-event.
   *
   * Throws, rather than resolving null, in the two cases that are *not*
   * "nothing is there": the object exceeds the byte ceiling (an
   * `ARTIFACT_ATTACHMENT_TOO_LARGE` artifact error — the caller asked for more
   * than it is allowed to buffer, and answering null would recreate exactly the
   * silent "video with no audio" failure this method exists to prevent), and
   * transport failure, which propagates as the store raised it, the same way
   * `upload` propagates its own.
   */
  download(
    input: ArtifactStorageDownloadInput,
  ): Promise<ArtifactStorageDownloadResult | null>;
}
