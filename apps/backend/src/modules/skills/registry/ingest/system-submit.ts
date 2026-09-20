import { and, eq } from "drizzle-orm";
import { db, workspaces } from "@sourceweft/db";
import type { SkillSubmission } from "@sourceweft/contracts";
import { createSkillSubmission, getSkillSubmission } from "./service";

/**
 * Imports started by the platform itself — the skills-sync tool collecting
 * public skills — rather than by a person.
 *
 * They go through exactly what a person's import does (`createSkillSubmission`:
 * same validation, same in-flight dedupe, same queue, same scan and triage), so
 * there is one set of rules. What differs is only who they are attributed to.
 */

/**
 * The submitter, and so the owner, of platform imports. Every consumer of those
 * columns compares them with the signed-in user's id and none looks the user
 * up, so a value no real id can equal means "nobody's personal skill": it stays
 * out of everyone's catalog until a market admin makes it public, which is the
 * point of collecting first and listing after review. Builtins already have no
 * owner; this column is NOT NULL and keys the in-flight dedupe, so it needs a
 * value rather than null.
 */
export const SYSTEM_SUBMITTER_ID = "system";

export type SystemSubmitScope = { teamId: string; workspaceId: string };

export type SystemSubmitResult =
  | { source: string; ok: true; created: boolean; submission: SkillSubmission }
  | { source: string; ok: false; code: string; message: string };

/**
 * `workspace_id` is the only one of these columns the database checks, and only
 * that it exists. A mistyped team would attach imports to a workspace of some
 * other team without anything complaining, so it is checked here, up front.
 */
export async function assertSystemSubmitScope(scope: SystemSubmitScope) {
  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, scope.workspaceId),
        eq(workspaces.organizationId, scope.teamId),
      ),
    )
    .limit(1);
  if (!workspace) {
    throw new Error(
      `Workspace '${scope.workspaceId}' does not exist in team '${scope.teamId}'`,
    );
  }
}

function describeError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    code: typeof code === "string" ? code : "UNEXPECTED",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** One import per source. A source that is refused does not stop the rest. */
export async function submitSkillSourcesAsSystem(
  scope: SystemSubmitScope,
  sources: readonly string[],
): Promise<SystemSubmitResult[]> {
  const results: SystemSubmitResult[] = [];
  for (const source of sources) {
    try {
      const { submission, created } = await createSkillSubmission({
        ...scope,
        userId: SYSTEM_SUBMITTER_ID,
        source,
      });
      results.push({ source, ok: true, created, submission });
    } catch (error) {
      results.push({ source, ok: false, ...describeError(error) });
    }
  }
  return results;
}

export type SystemSubmissionStatus =
  | { id: string; ok: true; submission: SkillSubmission }
  | { id: string; ok: false; code: string; message: string };

export async function readSystemSubmissions(
  scope: SystemSubmitScope,
  ids: readonly string[],
): Promise<SystemSubmissionStatus[]> {
  const results: SystemSubmissionStatus[] = [];
  for (const id of ids) {
    try {
      const { submission } = await getSkillSubmission({
        ...scope,
        userId: SYSTEM_SUBMITTER_ID,
        submissionId: id,
      });
      results.push({ id, ok: true, submission });
    } catch (error) {
      results.push({ id, ok: false, ...describeError(error) });
    }
  }
  return results;
}
