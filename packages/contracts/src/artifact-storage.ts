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
 * video-presentation) are downstream of it, and it is pure type surface with
 * no runtime and no imports.
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

/** The artifact object-storage port capability tools are handed. */
export interface ArtifactStorage {
  buildArtifactStorageKey(input: ArtifactStorageKeyInput): string;
  getBucketName(): string;
  upload(input: ArtifactStorageUploadInput): Promise<void>;
}
