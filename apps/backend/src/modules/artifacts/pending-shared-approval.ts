import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  artifactCapabilityApprovals,
  artifacts,
  artifactVersions,
  db,
} from "@sourceweft/db";
import { HTML_ARTIFACT_TYPE } from "@sourceweft/contracts/html-artifact";
import { workspaceService } from "../workspace";
import { workspaceRoleSatisfies } from "../workspace/types";

/**
 * Ids, among `artifactIds`, whose CURRENT ready version declares
 * `storage.shared` and has no active approval. One query for the whole page:
 * current versions are joined on `current_version_no`, the capability is read
 * from the version metadata, and approvals are left-joined so a missing or
 * revoked row both count as "waiting".
 *
 * Visibility is the caller's concern: pass ids the viewer may already see.
 */
export async function findArtifactIdsAwaitingSharedApproval(input: {
  teamId: string;
  workspaceId: string;
  artifactIds: readonly string[];
}): Promise<Set<string>> {
  if (input.artifactIds.length === 0) return new Set();
  const rows = await db
    .select({ artifactId: artifacts.id })
    .from(artifacts)
    .innerJoin(
      artifactVersions,
      and(
        eq(artifactVersions.artifactId, artifacts.id),
        eq(artifactVersions.teamId, artifacts.teamId),
        eq(artifactVersions.workspaceId, artifacts.workspaceId),
        eq(artifactVersions.versionNo, artifacts.currentVersionNo),
      ),
    )
    .leftJoin(
      artifactCapabilityApprovals,
      and(
        eq(artifactCapabilityApprovals.versionId, artifactVersions.id),
        eq(artifactCapabilityApprovals.capability, "storage.shared"),
        isNull(artifactCapabilityApprovals.revokedAt),
      ),
    )
    .where(
      and(
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
        inArray(artifacts.id, [...input.artifactIds]),
        eq(artifacts.status, "ready"),
        eq(artifacts.artifactType, HTML_ARTIFACT_TYPE),
        gt(artifacts.currentVersionNo, 0),
        sql`jsonb_typeof(${artifactVersions.contentJson} #> '{metadata,capabilities}') = 'array'`,
        sql`${artifactVersions.contentJson} #> '{metadata,capabilities}' @> '"storage.shared"'::jsonb`,
        isNull(artifactCapabilityApprovals.versionId),
      ),
    );
  return new Set(rows.map((row) => row.artifactId));
}

/**
 * The pending-approval set for a list page, only for callers who may approve
 * (editor or workspace admin). Everyone else gets an empty set; their preview
 * explains who can approve instead.
 */
export async function findPendingSharedApprovalArtifactIdsForViewer(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  artifactIds: readonly string[];
}): Promise<Set<string>> {
  if (input.artifactIds.length === 0) return new Set();
  const access = await workspaceService.resolveAccess({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });
  if (!access?.role || !workspaceRoleSatisfies(access.role, "editor"))
    return new Set();
  return findArtifactIdsAwaitingSharedApproval(input);
}
