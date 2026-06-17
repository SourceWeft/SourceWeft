import { workspaceService } from "./service";
import { ContentError } from "../content/errors";

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
