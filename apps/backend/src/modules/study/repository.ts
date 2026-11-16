import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  artifactSources,
  artifactVersions,
  artifacts,
  db,
} from "@sourceweft/db";
import type {
  StudyCheckpointData,
  StudyCheckpointStore,
  StudyProgress,
} from "@sourceweft/contracts/study-capability";
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

export type StudyPayloadKey = "checkpoint" | "progress" | "regeneration";

/** Merges `{ [key]: value }` into `payload_json.study`, leaving the rest. */
export async function writeStudyPayloadKey(
  scope: ArtifactScope,
  key: StudyPayloadKey,
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

export async function readStudyPayloadKey(
  scope: ArtifactScope,
  key: StudyPayloadKey,
): Promise<unknown> {
  const [row] = await db
    .select({ value: sql<unknown>`${artifacts.payloadJson} -> 'study' -> ${key}::text` })
    .from(artifacts)
    .where(scoped(scope))
    .limit(1);
  return row?.value ?? null;
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

/** The content of one version of an artifact in this workspace. */
export async function findStudyVersionContent(
  input: ArtifactScope & { versionNo: number },
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ content: artifactVersions.contentJson })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.artifactId, input.artifactId),
        eq(artifactVersions.teamId, input.teamId),
        eq(artifactVersions.workspaceId, input.workspaceId),
        eq(artifactVersions.versionNo, input.versionNo),
      ),
    )
    .limit(1);
  return row?.content ?? null;
}

/**
 * Points a regenerated version at the one it replaced. The writer does not
 * record lineage, so this runs right after the version commits; it is
 * idempotent and only ever names the immediately preceding version.
 */
export async function linkStudyVersionParent(input: {
  artifactId: string;
  versionNo: number;
}) {
  if (input.versionNo <= 1) return;
  await db.execute(sql`
    update artifact_versions child
    set parent_version_id = parent.id
    from artifact_versions parent
    where child.artifact_id = ${input.artifactId}
      and child.version_no = ${input.versionNo}
      and parent.artifact_id = child.artifact_id
      and parent.version_no = ${input.versionNo - 1}
  `);
}

export const STUDY_ARTIFACT_TYPE_LIST = ["flashcards", "quiz", "mindmap"] as const;

/** At most this many study generations per person run at once. */
export const STUDY_MAX_RUNNING_PER_USER = 3;

/**
 * Study generations a person has in flight in a workspace: artifacts they
 * opened that are still pending or running, plus regenerations of ready ones.
 */
export async function countRunningStudyJobs(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
}): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
        eq(artifacts.createdBy, input.userId),
        inArray(artifacts.artifactType, [...STUDY_ARTIFACT_TYPE_LIST]),
        sql`(${artifacts.status} in ('pending', 'running') or (${artifacts.status} = 'ready' and ${artifacts.payloadJson} -> 'study' -> 'regeneration' ->> 'status' = 'running'))`,
        // A job lost to a crash must not hold a slot forever: two attempts of
        // the longest budget have long passed after half an hour.
        sql`${artifacts.updatedAt} > now() - interval '30 minutes'`,
      ),
    );
  return row?.count ?? 0;
}
