import type {
  StudyCheckpointData,
  StudyCheckpointStore,
  StudyProgress,
} from "@sourceweft/contracts/study-capability";
import {
  countRunningGroundedJobs,
  createArtifactCheckpointStore as createCheckpointStore,
  findArtifactVersionContent,
  GROUNDED_MAX_RUNNING_PER_USER,
  linkArtifactVersionParent,
  readArtifactPayloadKey,
  recordArtifactInputSources,
  writeArtifactPayloadKey,
  writeGenerationProgress,
  type ArtifactPayloadKey,
  type ArtifactScope,
} from "../grounded-generation/artifact-store";
import type { GroundedSourceSnapshot } from "../grounded-generation/corpus-loader";

/** Study's view of the shared artifact store: `payload_json.study.*`. */

export type StudyPayloadKey = ArtifactPayloadKey;

/** Merges `{ [key]: value }` into `payload_json.study`, leaving the rest. */
export function writeStudyPayloadKey(
  scope: ArtifactScope,
  key: StudyPayloadKey,
  value: unknown,
) {
  return writeArtifactPayloadKey(scope, "study", key, value);
}

export function readStudyPayloadKey(
  scope: ArtifactScope,
  key: StudyPayloadKey,
): Promise<unknown> {
  return readArtifactPayloadKey(scope, "study", key);
}

function isCheckpoint(value: unknown): value is StudyCheckpointData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StudyCheckpointData>;
  return (
    typeof candidate.versionNo === "number" &&
    typeof candidate.groups === "object" &&
    candidate.groups !== null &&
    typeof candidate.verified === "object" &&
    candidate.verified !== null
  );
}

/**
 * The engine's checkpoint, kept in `payload_json.study.checkpoint` of the
 * artifact being generated. Publishing the finished version replaces the
 * payload, which is what clears it.
 */
export function createArtifactCheckpointStore(
  scope: ArtifactScope,
): StudyCheckpointStore {
  return createCheckpointStore(scope, "study", isCheckpoint);
}

/** Progress for pollers, in `payload_json.study.progress`. */
export function writeStudyProgress(
  scope: ArtifactScope,
  progress: StudyProgress,
) {
  return writeGenerationProgress(scope, "study", progress);
}

export const recordStudyInputSources: (
  artifactId: string,
  snapshots: readonly GroundedSourceSnapshot[],
) => Promise<void> = recordArtifactInputSources;

export const findStudyVersionContent = findArtifactVersionContent;
export const linkStudyVersionParent = linkArtifactVersionParent;

/** At most this many generations per person run at once, study and table together. */
export const STUDY_MAX_RUNNING_PER_USER = GROUNDED_MAX_RUNNING_PER_USER;

/**
 * Generations a person has in flight in a workspace: artifacts they opened
 * that are still pending or running, plus regenerations of ready ones. Data
 * tables count too, because they share the limit.
 */
export const countRunningStudyJobs: (input: {
  teamId: string;
  workspaceId: string;
  userId: string;
}) => Promise<number> = countRunningGroundedJobs;
