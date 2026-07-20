import { VIDEO_PRESENTATION_ARTIFACT_TYPE } from "./artifact-view";

/**
 * Write-side descriptors for this capability's artifact rows.
 *
 * The host owns the generic "create a pending artifact" / "find a reusable
 * artifact" primitives; which artifact type they address and what makes a row
 * reusable (a payload `requestKey` match, in a non-terminal or ready state)
 * are this capability's knowledge, declared here.
 */

/**
 * BullMQ job name of this capability's deliverable pipeline.
 *
 * One declaration, three consumers: the manifest (`runtime.pipeline.jobName`),
 * the pipeline definition the worker host registers, and the agent tool that
 * dispatches the job. The host reads it from the manifest on both sides and
 * never spells it out itself.
 */
export const VIDEO_PRESENTATION_PIPELINE_JOB_NAME =
  "video-presentation-generate";

/** Statuses whose artifact row a repeated request may reuse instead of creating a new one. */
export const VIDEO_PRESENTATION_REUSABLE_STATUSES = [
  "pending",
  "running",
  "ready",
] as const;

/**
 * The request key is matched as a column, not by scanning payloads.
 *
 * It used to be `matchesPayload: payload.requestKey === key` over the newest 20
 * rows of the type in the thread, which meant a thread with 20 newer video
 * artifacts stopped reusing anything — silently, and precisely on the threads
 * where a duplicate costs the most to produce.
 */
export function videoPresentationReusableArtifactQuery(input: {
  readonly requestKey: string;
}) {
  return {
    artifactType: VIDEO_PRESENTATION_ARTIFACT_TYPE,
    statuses: VIDEO_PRESENTATION_REUSABLE_STATUSES,
    requestKey: input.requestKey,
  } as const;
}
