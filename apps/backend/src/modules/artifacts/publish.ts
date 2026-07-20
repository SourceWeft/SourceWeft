import type {
  ArtifactPublishResult,
  ArtifactPublishSpec,
  ArtifactWriteContext,
} from "@sourceweft/contracts/artifact-write";
import { artifactWriter } from "./writer";

/**
 * Publish a finished artifact.
 *
 * This is the write path, as a function. Anything that produces an artifact
 * calls it the same way — the `publish_artifact` agent tool, a skill, a
 * deliverable pipeline, a script — because none of them differ in what
 * publishing *is*; they differ only in who decided to publish.
 *
 * What the caller brings is what the caller alone knows: the artifact type, its
 * payload, and any bytes to store. What this owns is what no producer should
 * re-implement, and what two of the three producers used to skip: storage key
 * layout, idempotent reuse, artifact-type validation, versioning and the row
 * itself.
 *
 * Type-specific validation deliberately stays with the producer, which has
 * already inspected its own bytes by the time it gets here — a deck knows to
 * unpack the PPTX, and no registry lookup could tell it that.
 *
 * Pass `idempotency.requestKey` when a retry of the same request should return
 * the same artifact instead of producing another one; `reused: true` in the
 * result says that is what happened, and no bytes were uploaded.
 */
export function publishArtifact(input: {
  readonly context: ArtifactWriteContext;
  readonly spec: ArtifactPublishSpec;
  /** Pre-allocate when the id must exist before the work (e.g. billing keys). */
  readonly artifactId?: string;
}): Promise<ArtifactPublishResult> {
  return artifactWriter.publishArtifact(input);
}

export type {
  ArtifactPublishResult,
  ArtifactPublishSpec,
  ArtifactWriteContext,
};
