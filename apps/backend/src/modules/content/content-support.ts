import { workspaceService } from "../workspace";
import { ContentError } from "./errors";
import { findSourceRecord } from "./sources/repository";

export function normalizeContentTitle(
  value: string | undefined,
  fallback: string,
) {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, 200);
}

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

export async function requireContentSource(input: {
  workspaceId: string;
  userId: string;
  sourceId: string;
}) {
  const workspace = await requireContentWorkspace(input);
  const source = await findSourceRecord({
    sourceId: input.sourceId,
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
  });

  if (!source) {
    throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
  }

  return { workspace, source };
}
