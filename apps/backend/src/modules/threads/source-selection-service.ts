import { database } from "@sourceweft/db";
import {
  threadSourceSelectionSchema,
  type ThreadSourceSelection,
} from "@sourceweft/contracts";
import { ContentError } from "../content/errors";
import { requireContentWorkspace } from "../workspace/guards";
import { canViewThread } from "../workspace/content-visibility";
import { findThreadRecord } from "./thread/repository";
import { resolveSourceTreeScope } from "../sources/service";

type SelectionScope = { teamId: string; workspaceId: string; threadId: string };

async function read(scope: SelectionScope) {
  const result = await database.query<{ source_selection_json: unknown }>(
    "select source_selection_json from threads where team_id=$1 and workspace_id=$2 and id=$3",
    [scope.teamId, scope.workspaceId, scope.threadId],
  );
  if (!result.rows[0])
    throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
  return threadSourceSelectionSchema.parse(
    result.rows[0].source_selection_json,
  );
}

export async function loadThreadSourceSelection(
  scope: SelectionScope,
): Promise<ThreadSourceSelection> {
  return read(scope);
}

async function authorize(input: {
  workspaceId: string;
  threadId: string;
  userId: string;
}) {
  const workspace = await requireContentWorkspace(input);
  const scope = {
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    threadId: input.threadId,
  };
  const thread = await findThreadRecord(scope);
  if (!thread || !canViewThread(input.userId, thread))
    throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
  return scope;
}

export async function getThreadSourceSelection(input: {
  workspaceId: string;
  threadId: string;
  userId: string;
}) {
  return { selection: await loadThreadSourceSelection(await authorize(input)) };
}

export async function updateThreadSourceSelection(input: {
  workspaceId: string;
  threadId: string;
  userId: string;
  expectedRevision: number;
  selectedSourceIds: string[];
}) {
  const scope = await authorize(input);
  const current = await loadThreadSourceSelection(scope);
  const resolved = await resolveSourceTreeScope({
    ...scope,
    selectedSourceIds: input.selectedSourceIds,
  });
  const allowed = new Set(resolved.effectiveSourceIds);
  if (input.selectedSourceIds.some((id) => !allowed.has(id))) {
    throw new ContentError(
      403,
      "SOURCE_ACCESS_DENIED",
      "One or more sources are unavailable in this workspace",
    );
  }
  const selection: ThreadSourceSelection = {
    revision: input.expectedRevision + 1,
    selectedSourceIds: [...new Set(input.selectedSourceIds)],
  };
  if (current.revision !== input.expectedRevision) throw conflict();
  const result = await database.query<{ source_selection_json: unknown }>(
    `update threads set source_selection_json=$4::jsonb
     where team_id=$1 and workspace_id=$2 and id=$3 and source_selection_json=$5::jsonb
     returning source_selection_json`,
    [
      scope.teamId,
      scope.workspaceId,
      scope.threadId,
      JSON.stringify(selection),
      JSON.stringify(current),
    ],
  );
  if (!result.rows[0]) throw conflict();
  return {
    selection: threadSourceSelectionSchema.parse(
      result.rows[0].source_selection_json,
    ),
  };
}

/**
 * Gives a conversation the host has just created its starting selection: the
 * requested sources that still exist in the workspace. Sources that are gone
 * are left out instead of failing, and a selection that is already there is
 * kept, so calling this again for the same conversation changes nothing.
 * Returns the selection the conversation ends up with.
 */
export async function seedThreadSourceSelection(
  scope: SelectionScope & { sourceIds: string[] },
): Promise<string[]> {
  const current = await loadThreadSourceSelection(scope);
  if (current.revision > 0 || scope.sourceIds.length === 0) {
    return current.selectedSourceIds;
  }
  const resolved = await resolveSourceTreeScope({
    teamId: scope.teamId,
    workspaceId: scope.workspaceId,
    selectedSourceIds: scope.sourceIds,
  });
  const available = new Set(resolved.effectiveSourceIds);
  const selection: ThreadSourceSelection = {
    revision: current.revision + 1,
    selectedSourceIds: [...new Set(scope.sourceIds)].filter((id) =>
      available.has(id),
    ),
  };
  const result = await database.query<{ source_selection_json: unknown }>(
    `update threads set source_selection_json=$4::jsonb
     where team_id=$1 and workspace_id=$2 and id=$3 and source_selection_json=$5::jsonb
     returning source_selection_json`,
    [
      scope.teamId,
      scope.workspaceId,
      scope.threadId,
      JSON.stringify(selection),
      JSON.stringify(current),
    ],
  );
  // Lost a race with another dispatcher seeding the same conversation.
  if (!result.rows[0]) {
    return (await loadThreadSourceSelection(scope)).selectedSourceIds;
  }
  return selection.selectedSourceIds;
}

function conflict() {
  return new ContentError(
    409,
    "SOURCE_SELECTION_CONFLICT",
    "Sources changed in another window. Reload the selection before updating it.",
  );
}

export async function assertThreadSourceSelection(input: {
  workspaceId: string;
  threadId: string;
  userId: string;
  revision: number;
}) {
  const { selection } = await getThreadSourceSelection(input);
  if (selection.revision !== input.revision) throw conflict();
}
