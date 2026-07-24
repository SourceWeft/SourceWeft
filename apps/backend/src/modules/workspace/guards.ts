import { workspaceService } from "./service";
import { ContentError } from "../content/errors";

/**
 * Resolves the workspace for a request, rejecting callers who are not members
 * of it (or who have lapsed out of the owning organization).
 *
 * `WORKSPACE_NOT_FOUND` rather than a 403 is deliberate: a non-member should
 * not learn that a workspace id exists.
 */
export async function requireContentWorkspace(input: {
  workspaceId: string;
  userId: string;
}) {
  const workspace = await workspaceService.resolveWorkspace({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });

  if (!workspace) {
    throw new ContentError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
  }

  return workspace;
}
