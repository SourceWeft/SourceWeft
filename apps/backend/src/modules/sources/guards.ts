import { requireContentWorkspace } from "../workspace/guards";
import { ContentError } from "../content/errors";
import { findSourceRecord } from "./repository";

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
