import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  artifactSources,
  artifactVersions,
  artifacts,
  db,
} from "@sourceweft/db";
import type { GroundedCheckpointStore } from "@sourceweft/contracts/grounded-generation";
import type { GroundedSourceSnapshot } from "./corpus-loader";

export type ArtifactScope = {
  artifactId: string;
  teamId: string;
  workspaceId: string;
};

/**
 * The key under `payload_json` that holds an artifact type's generation state:
 * `payload_json.study.*` for study artifacts, `payload_json.table.*` for data
 * tables. Existing study rows depend on the `study` spelling.
 */
export type ArtifactPayloadNamespace = "study" | "table";

function scoped(scope: ArtifactScope) {
  return and(
    eq(artifacts.id, scope.artifactId),
    eq(artifacts.teamId, scope.teamId),
    eq(artifacts.workspaceId, scope.workspaceId),
  );
}

export type ArtifactPayloadKey = "checkpoint" | "progress" | "regeneration";

/** Merges `{ [key]: value }` into `payload_json.<namespace>`, leaving the rest. */
export async function writeArtifactPayloadKey(
  scope: ArtifactScope,
  namespace: ArtifactPayloadNamespace,
  key: ArtifactPayloadKey,
  value: unknown,
) {
  await db
    .update(artifacts)
    .set({
      payloadJson: sql`coalesce(${artifacts.payloadJson}, '{}'::jsonb) || jsonb_build_object(${namespace}::text, coalesce(${artifacts.payloadJson} -> ${namespace}::text, '{}'::jsonb) || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb))`,
      updatedAt: new Date(),
    })
    .where(scoped(scope));
}

export async function readArtifactPayloadKey(
  scope: ArtifactScope,
  namespace: ArtifactPayloadNamespace,
  key: ArtifactPayloadKey,
): Promise<unknown> {
  const [row] = await db
    .select({
      value: sql<unknown>`${artifacts.payloadJson} -> ${namespace}::text -> ${key}::text`,
    })
    .from(artifacts)
    .where(scoped(scope))
    .limit(1);
  return row?.value ?? null;
}

/**
 * The engine's checkpoint, kept in `payload_json.<namespace>.checkpoint` of
 * the artifact being generated. `isCheckpoint` guards what is read back: a
 * stored value of any other shape counts as no checkpoint. Publishing the
 * finished version replaces the payload, which is what clears it.
 */
export function createArtifactCheckpointStore<T>(
  scope: ArtifactScope,
  namespace: ArtifactPayloadNamespace,
  isCheckpoint: (value: unknown) => value is T,
): GroundedCheckpointStore<T> {
  return {
    async load() {
      const value = await readArtifactPayloadKey(scope, namespace, "checkpoint");
      return isCheckpoint(value) ? value : null;
    },
    async save(checkpoint) {
      await writeArtifactPayloadKey(scope, namespace, "checkpoint", checkpoint);
    },
  };
}

/** Progress for pollers, in `payload_json.<namespace>.progress`. */
export async function writeGenerationProgress(
  scope: ArtifactScope,
  namespace: ArtifactPayloadNamespace,
  progress: unknown,
) {
  await writeArtifactPayloadKey(scope, namespace, "progress", progress);
}

/**
 * Records the sources an artifact was generated from (`role = input`),
 * once per source: `artifact_sources` is per artifact, not per version, so a
 * regeneration only adds sources that are new to it.
 */
export async function recordArtifactInputSources(
  artifactId: string,
  snapshots: readonly GroundedSourceSnapshot[],
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
export async function findArtifactVersionContent(
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
export async function linkArtifactVersionParent(input: {
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

/**
 * Generations a person has in flight in a workspace: artifacts of the given
 * types they opened that are still pending or running, plus regenerations of
 * ready ones (`payload_json.<namespace>.regeneration.status = 'running'`).
 */
export async function countRunningGenerationJobs(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  artifactTypes: readonly (typeof artifacts.$inferSelect)["artifactType"][];
  namespace: ArtifactPayloadNamespace;
}): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
        eq(artifacts.createdBy, input.userId),
        inArray(artifacts.artifactType, [...input.artifactTypes]),
        sql`(${artifacts.status} in ('pending', 'running') or (${artifacts.status} = 'ready' and ${artifacts.payloadJson} -> ${input.namespace}::text -> 'regeneration' ->> 'status' = 'running'))`,
        // A job lost to a crash must not hold a slot forever: two attempts of
        // the longest budget have long passed after half an hour.
        sql`${artifacts.updatedAt} > now() - interval '30 minutes'`,
      ),
    );
  return row?.count ?? 0;
}
