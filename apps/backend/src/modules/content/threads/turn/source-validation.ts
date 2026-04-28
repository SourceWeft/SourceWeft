import { ContentError } from "../../errors";
import { findSourceRecord } from "../../sources/repository";

export async function assertSourcesExist(input: {
  teamId: string;
  workspaceId: string;
  sourceIds: string[];
}) {
  for (const sourceId of input.sourceIds) {
    const source = await findSourceRecord({
      sourceId,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
    });
    if (!source) {
      throw new ContentError(
        404,
        "SOURCE_NOT_FOUND",
        `Source '${sourceId}' not found in workspace`,
      );
    }
  }
}
