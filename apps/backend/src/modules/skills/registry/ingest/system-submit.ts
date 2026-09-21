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

/**
 * A source to import: its URL, and optionally whether its skills are featured
 * (the sync marks sources from a short list of major publishers). Absent
 * `featured` leaves whatever the skill already has.
 */
export type SystemSubmitSource =
  string | { source: string; featured?: boolean };

/** The sync's stdin items, checked; anything else is refused whole. */
export function parseSystemSubmitSources(value: unknown): SystemSubmitSource[] {
  if (!Array.isArray(value)) {
    throw new Error("stdin.sources must be an array");
  }
  return value.map((item, index) => {
    if (typeof item === "string" && item.trim()) return item;
    if (
      item &&
      typeof item === "object" &&
      typeof (item as { source?: unknown }).source === "string" &&
      (item as { source: string }).source.trim() &&
      ["undefined", "boolean"].includes(
        typeof (item as { featured?: unknown }).featured,
      ) &&
      Object.keys(item).every((key) => key === "source" || key === "featured")
    ) {
      return item as { source: string; featured?: boolean };
    }
    throw new Error(
      `stdin.sources[${index}] must be a non-empty string or {"source": string, "featured"?: boolean}`,
    );
  });
}

/** One import per source. A source that is refused does not stop the rest. */
export async function submitSkillSourcesAsSystem(
  scope: SystemSubmitScope,
  sources: readonly SystemSubmitSource[],
): Promise<SystemSubmitResult[]> {
  const results: SystemSubmitResult[] = [];
  for (const item of sources) {
    const source = typeof item === "string" ? item : item.source;
    const featured = typeof item === "string" ? undefined : item.featured;
    try {
      const { submission, created } = await createSkillSubmission({
        ...scope,
        userId: SYSTEM_SUBMITTER_ID,
        source,
        ...(featured !== undefined ? { options: { featured } } : {}),
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
