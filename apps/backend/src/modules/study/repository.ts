import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { artifactSources, artifacts, db } from "@sourceweft/db";
import type {
  StudyCheckpoint,
  StudyCheckpointStore,
  StudyProgress,
} from "./engine";
import type { StudySourceSnapshot } from "./corpus-loader";

type ArtifactScope = {
  artifactId: string;
  teamId: string;
  workspaceId: string;
};

function scoped(scope: ArtifactScope) {
  return and(
    eq(artifacts.id, scope.artifactId),
    eq(artifacts.teamId, scope.teamId),
    eq(artifacts.workspaceId, scope.workspaceId),
  );
}

/** Merges `{ [key]: value }` into `payload_json.study`, leaving the rest. */
async function writeStudyPayloadKey(
  scope: ArtifactScope,
  key: "checkpoint" | "progress",
  value: unknown,
) {
  await db
    .update(artifacts)
    .set({
      payloadJson: sql`coalesce(${artifacts.payloadJson}, '{}'::jsonb) || jsonb_build_object('study', coalesce(${artifacts.payloadJson} -> 'study', '{}'::jsonb) || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb))`,
      updatedAt: new Date(),
    })
    .where(scoped(scope));
}

async function readStudyPayloadKey(
  scope: ArtifactScope,
  key: "checkpoint" | "progress",
): Promise<unknown> {
  const [row] = await db
    .select({ value: sql<unknown>`${artifacts.payloadJson} -> 'study' -> ${key}::text` })
    .from(artifacts)
    .where(scoped(scope))
    .limit(1);
  return row?.value ?? null;
}

function isCheckpoint(value: unknown): value is StudyCheckpoint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StudyCheckpoint>;
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
  return {
    async load() {
      const value = await readStudyPayloadKey(scope, "checkpoint");
      return isCheckpoint(value) ? value : null;
    },
    async save(checkpoint) {
      await writeStudyPayloadKey(scope, "checkpoint", checkpoint);
    },
  };
}

/** Progress for pollers, in `payload_json.study.progress`. */
export async function writeStudyProgress(
  scope: ArtifactScope,
  progress: StudyProgress,
) {
  await writeStudyPayloadKey(scope, "progress", progress);
}

/**
 * Records the sources a study artifact was generated from (`role = input`),
 * once per source: `artifact_sources` is per artifact, not per version, so a
 * regeneration only adds sources that are new to it.
 */
export async function recordStudyInputSources(
  artifactId: string,
  snapshots: readonly StudySourceSnapshot[],
) {
  if (snapshots.length === 0) return;
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ sourceId: artifactSources.sourceId })
      .from(artifactSources)
      .where(
        and(
          eq(artifactSources.artifactId, artifactId),
          eq(artifactSources.role, "input"),
        ),
      );
    const known = new Set(existing.map((row) => row.sourceId));
    const fresh = snapshots.filter((snapshot) => !known.has(snapshot.sourceId));
    if (fresh.length === 0) return;
    await tx.insert(artifactSources).values(
      fresh.map((snapshot) => ({
        id: `asrc_${randomUUID()}`,
        artifactId,
        sourceId: snapshot.sourceId,
        documentId: snapshot.documentId,
        role: "input" as const,
      })),
    );
  });
}
