/**
 * Artifact URL construction lives in `@sourceweft/contracts/artifact-urls` —
 * this file used to hold one of five byte-identical copies of
 * `buildArtifactPreviewUrl`. Kept as a re-export so the package's public entry
 * point keeps its names.
 */
export {
  buildArtifactDownloadUrl,
  buildArtifactPreviewImageUrl,
  buildArtifactPreviewUrl,
} from "@sourceweft/contracts/artifact-urls";
