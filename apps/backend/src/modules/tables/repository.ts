import type { TableCheckpoint } from "@sourceweft/contracts/table-capability";
import type { GroundedCheckpointStore } from "@sourceweft/contracts/grounded-generation";
import {
  createArtifactCheckpointStore as createCheckpointStore,
  findArtifactVersionContent,
  readArtifactPayloadKey,
  recordArtifactInputSources,
  writeArtifactPayloadKey,
  writeGenerationProgress,
  type ArtifactPayloadKey,
  type ArtifactScope,
} from "../grounded-generation/artifact-store";
import type { GroundedSourceSnapshot } from "../grounded-generation/corpus-loader";

/** The table's view of the shared artifact store: `payload_json.table.*`. */

/** Where a pending table's poller reads how far the fill is. */
export type TableProgress = {
  stage: "fill" | "finalize";
  done: number;
  total: number;
};

/** Merges `{ [key]: value }` into `payload_json.table`, leaving the rest. */
export function writeTablePayloadKey(
  scope: ArtifactScope,
  key: ArtifactPayloadKey,
  value: unknown,
) {
  return writeArtifactPayloadKey(scope, "table", key, value);
}

export function readTablePayloadKey(
  scope: ArtifactScope,
  key: ArtifactPayloadKey,
): Promise<unknown> {
  return readArtifactPayloadKey(scope, "table", key);
}

function isCheckpoint(value: unknown): value is TableCheckpoint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TableCheckpoint>;
  return (
    typeof candidate.versionNo === "number" &&
    typeof candidate.rows === "object" &&
    candidate.rows !== null
  );
}

/**
 * The engine's checkpoint, kept in `payload_json.table.checkpoint` of the
 * artifact being generated. Publishing the finished version replaces the
 * payload, which is what clears it.
 */
export function createArtifactCheckpointStore(
  scope: ArtifactScope,
): GroundedCheckpointStore<TableCheckpoint> {
  return createCheckpointStore(scope, "table", isCheckpoint);
}

/** Progress for pollers, in `payload_json.table.progress`. */
export function writeTableProgress(scope: ArtifactScope, progress: TableProgress) {
  return writeGenerationProgress(scope, "table", progress);
}

export const recordTableInputSources: (
  artifactId: string,
  snapshots: readonly GroundedSourceSnapshot[],
) => Promise<void> = recordArtifactInputSources;

export const findTableVersionContent = findArtifactVersionContent;
