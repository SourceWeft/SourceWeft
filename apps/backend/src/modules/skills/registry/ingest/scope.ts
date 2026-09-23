import type { SkillSubmissionRow } from "./repository";

export const SYSTEM_SUBMITTER_ID = "system";

export function requireWorkspaceScope<
  T extends Pick<
    SkillSubmissionRow,
    "scope" | "teamId" | "workspaceId" | "submittedBy"
  >,
>(row: T): T & { teamId: string; workspaceId: string } {
  if (
    row.scope === "system" ||
    row.submittedBy === SYSTEM_SUBMITTER_ID ||
    !row.teamId ||
    !row.workspaceId
  ) {
    throw new Error(
      "Workspace operation requires a workspace-scoped submission",
    );
  }
  return row as T & { teamId: string; workspaceId: string };
}
