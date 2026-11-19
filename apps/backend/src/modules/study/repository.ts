import type {
  StudyCheckpointData,
  StudyCheckpointStore,
  StudyProgress,
} from "@sourceweft/contracts/study-capability";
import {
  countRunningGenerationJobs,
  createArtifactCheckpointStore as createCheckpointStore,
  findArtifactVersionContent,
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

export const STUDY_ARTIFACT_TYPE_LIST = ["flashcards", "quiz", "mindmap"] as const;

/** At most this many study generations per person run at once. */
export const STUDY_MAX_RUNNING_PER_USER = 3;

/**
 * Study generations a person has in flight in a workspace: artifacts they
 * opened that are still pending or running, plus regenerations of ready ones.
 */
export function countRunningStudyJobs(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
}): Promise<number> {
  return countRunningGenerationJobs({
    ...input,
    artifactTypes: STUDY_ARTIFACT_TYPE_LIST,
    namespace: "study",
  });
}
