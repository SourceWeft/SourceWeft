import { randomUUID } from "node:crypto";
import { database, db } from "@sourceweft/db";
import { sql } from "drizzle-orm";
import { updateArtifactsVisibilityForThread } from "../../artifacts/repository";
import { revokeShareLinksForThreadArtifacts } from "../../sharing/store";
import { toPostgresTextArray } from "../../sources/sql";
import type { ThreadRecord } from "../../content/types";
import {
  normalizePersistedThreadModelSettings,
  normalizeThreadModelSettings,
  type ThreadModelSettingsInput,
  type ThreadModelSettings,
} from "../model-settings";
import {
  mergeThreadChatPreferences,
  normalizeThreadChatPreferences,
  type ThreadChatPreferencesPatch,
} from "../chat-preferences";
import type { ThreadChatPreferences } from "@sourceweft/contracts";
import { MAX_PINNED_THREADS } from "@sourceweft/contracts";
import type { ThreadExecutionTarget } from "@sourceweft/contracts";

type RawThreadRow = {
  id: string;
  team_id: string;
  workspace_id: string;
  title: string;
  execution_target_json?: ThreadExecutionTarget;
  model_settings_json: ThreadModelSettingsInput | undefined;
  chat_preferences_json: unknown;
  visibility: ThreadRecord["visibility"];
  parent_thread_id: string | null;
  persona_id: string | null;
  origin: ThreadRecord["origin"];
  created_by: string | null;
  // pg queries decode timestamps to Date; Drizzle raw transaction queries
  // intentionally return timestamp strings instead.
  created_at: Date | string;
  updated_at: Date | string;
  last_message_at: Date | string | null;
};

const THREAD_RETURNING_SQL = `
  id,
  team_id,
  workspace_id,
  title,
  execution_target_json,
  model_settings_json,
  chat_preferences_json,
  visibility,
  parent_thread_id,
  persona_id,
  origin,
  created_by,
  created_at,
  updated_at,
  last_message_at
`;

/**
 * Conversation activity time used to order and timestamp the sidebar list. It
 * moves only when a message is appended (see `createMessageRecord`), so
 * metadata-only writes (title/model/preferences, which bump `updated_at`) no
 * longer reshuffle the list. `last_message_at` is NULL until the first message,
 * so brand-new threads fall back to `created_at`.
 */
const THREAD_ACTIVITY_SQL = "coalesce(last_message_at, created_at)";

/** The viewer's (`$3`) pin row on the `threads` row in scope. */
const VIEWER_PIN_SQL =
  "select 1 from thread_pins p where p.thread_id = threads.id and p.user_id = $3";

/**
 * Raw-SQL predicate hiding other members' private threads. `public_link` is an
 * external flag, not an internal hide, so only `private` restricts. Fail-closed
 * like `canViewThread`: a creator-less private row matches nobody (legacy rows
 * were backfilled to `workspace` in migration 0019). `$${index}` is the 1-based
 * position of the viewer id in the query params.
 */
function threadVisibilityClause(paramIndex: number) {
  return `(visibility <> 'private' or created_by = $${paramIndex})`;
}

function mapRawThread(row: RawThreadRow, sourceCount = 0): ThreadRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    workspaceId: row.workspace_id,
    title: row.title,
    executionTarget: row.execution_target_json ?? { kind: "cloud" },
    modelSettings: normalizePersistedThreadModelSettings(
      row.model_settings_json,
    ),
    chatPreferences: normalizeThreadChatPreferences(row.chat_preferences_json),
    sourceCount,
    visibility: row.visibility,
    parentThreadId: row.parent_thread_id,
    personaId: row.persona_id,
    origin: row.origin,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastMessageAt: row.last_message_at
      ? new Date(row.last_message_at).toISOString()
      : null,
  };
}

async function countUsedSourceIdsByThread(input: {
  teamId: string;
  workspaceId: string;
  threadIds: string[];
}) {
  if (input.threadIds.length === 0) {
    return new Map<string, number>();
  }

  const result = await database.query<{
    thread_id: string;
    source_count: number | string;
  }>(
    `
      select
        m.thread_id,
        count(distinct source_id.value)::int as source_count
      from messages m
      cross join lateral jsonb_array_elements_text(
        case
          when jsonb_typeof(m.metadata->'effectiveSourceIds') = 'array'
          then m.metadata->'effectiveSourceIds'
          when jsonb_typeof(m.metadata->'sourceIds') = 'array'
          then m.metadata->'sourceIds'
          else '[]'::jsonb
        end
      ) as source_id(value)
      where m.team_id = $1
        and m.workspace_id = $2
        and m.role = 'user'
        and m.thread_id = any($3::text[])
      group by m.thread_id
    `,
    [input.teamId, input.workspaceId, toPostgresTextArray(input.threadIds)],
  );

  return new Map(
    result.rows.map((row) => [row.thread_id, Number(row.source_count)]),
  );
}

export async function createThreadRecord(input: {
  id?: string;
  teamId: string;
  workspaceId: string;
  title: string;
  createdBy: string;
  modelSettings?: Partial<ThreadModelSettings>;
  chatPreferences?: Partial<ThreadChatPreferences>;
  visibility?: ThreadRecord["visibility"];
  parentThreadId?: string | null;
  personaId?: string | null;
  origin?: ThreadRecord["origin"];
  executionTarget?: ThreadExecutionTarget;
}) {
  const id = input.id ?? randomUUID();
  const modelSettings = normalizeThreadModelSettings(input.modelSettings);
  const chatPreferences = normalizeThreadChatPreferences(input.chatPreferences);
  const result = await database.query<RawThreadRow>(
    `
      insert into threads (
        id,
        team_id,
        workspace_id,
        title,
        model_settings_json,
        chat_preferences_json,
        created_by,
        visibility,
        parent_thread_id,
        persona_id,
        origin,
        execution_target_json
      )
      values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb)
      -- No conflict target: two concurrent inserts of one id can trip
      -- threads_id_workspace_team_uq before the primary key, and an
      -- "on conflict (id)" arbiter does not cover it. Every unique
      -- constraint on threads includes id, so this still only skips a row
      -- with the same id.
      on conflict do nothing
      returning ${THREAD_RETURNING_SQL}
    `,
    [
      id,
      input.teamId,
      input.workspaceId,
      input.title,
      JSON.stringify(modelSettings),
      JSON.stringify(chatPreferences),
      input.createdBy,
      input.visibility ?? "private",
      input.parentThreadId ?? null,
      input.personaId ?? null,
      input.origin ?? "user",
      JSON.stringify(input.executionTarget ?? { kind: "cloud" }),
    ],
  );
  const row =
    result.rows[0] ??
    (input.id
      ? (
          await database.query<RawThreadRow>(
            `select ${THREAD_RETURNING_SQL} from threads where id=$1 and workspace_id=$2 and team_id=$3 and created_by=$4 and execution_target_json=$5::jsonb`,
            [
              id,
              input.workspaceId,
              input.teamId,
              input.createdBy,
              JSON.stringify(input.executionTarget ?? { kind: "cloud" }),
            ],
          )
        ).rows[0]
      : undefined);

  if (!row) {
    throw new Error("Failed to create thread");
  }

  return mapRawThread(row);
}

export async function listThreadRecordsByWorkspace(input: {
  teamId: string;
  workspaceId: string;
  viewerUserId: string;
  limit: number;
  cursor?: {
    id: string;
    activityAt: string;
  };
  /** The archived chats instead of the main list. */
  archived?: boolean;
  /** The viewer's own pinned, non-archived chats, newest pin first. */
  pinned?: boolean;
}) {
  if (input.pinned) return listPinnedThreadRecords(input);

  const cursorDate = input.cursor ? new Date(input.cursor.activityAt) : null;
  const hasValidCursor =
    Boolean(input.cursor) &&
    Boolean(cursorDate) &&
    !Number.isNaN(cursorDate?.getTime());

  // Params are built in order; the viewer id always comes third so its
  // placeholder index is stable whether or not the cursor branch is present.
  const params: unknown[] = [
    input.teamId,
    input.workspaceId,
    input.viewerUserId,
  ];
  const visibility = threadVisibilityClause(3);

  let cursorSql = "";
  if (hasValidCursor) {
    params.push(cursorDate?.toISOString(), input.cursor?.id);
    cursorSql = `and (${THREAD_ACTIVITY_SQL} < $${params.length - 1}::timestamptz or (${THREAD_ACTIVITY_SQL} = $${params.length - 1}::timestamptz and id < $${params.length}))`;
  }

  params.push(input.limit);
  const limitParam = params.length;

  const result = await database.query<RawThreadRow>(
    `
      select ${THREAD_RETURNING_SQL}
      from threads
      where team_id = $1
        and workspace_id = $2
        and archived = ${input.archived ? "true" : "false"}
        and parent_thread_id is null
        -- A workspace assistant's Router conversation is its own working
        -- thread, not a chat anyone opened; it stays out of the chat list.
        and origin <> 'assistant_router'
        and ${visibility}
        ${input.archived ? "" : `and not exists (${VIEWER_PIN_SQL})`}
        ${cursorSql}
      order by ${THREAD_ACTIVITY_SQL} desc, id desc
      limit $${limitParam}
    `,
    params,
  );

  const sourceCounts = await countUsedSourceIdsByThread({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadIds: result.rows.map((row) => row.id),
  });

  return result.rows.map((row) =>
    mapRawThread(row, sourceCounts.get(row.id) ?? 0),
  );
}

export async function findRecentThreadRecordByUser(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
}) {
  const result = await database.query<RawThreadRow>(
    `
      select ${THREAD_RETURNING_SQL}
      from threads
      where team_id = $1
        and workspace_id = $2
        and created_by = $3
        and archived = false
      order by greatest(coalesce(last_message_at, updated_at), updated_at) desc,
        updated_at desc,
        id desc
      limit 1
    `,
    [input.teamId, input.workspaceId, input.userId],
  );

  const row = result.rows[0];
  return row ? mapRawThread(row) : null;
}

export async function findThreadRecord(input: {
  threadId: string;
  teamId: string;
  workspaceId: string;
}) {
  const result = await database.query<RawThreadRow>(
    `
      select ${THREAD_RETURNING_SQL}
      from threads
      where id = $1
        and team_id = $2
        and workspace_id = $3
      limit 1
    `,
    [input.threadId, input.teamId, input.workspaceId],
  );
  const row = result.rows[0];

  if (!row) return null;

  const sourceCounts = await countUsedSourceIdsByThread({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadIds: [row.id],
  });

  return mapRawThread(row, sourceCounts.get(row.id) ?? 0);
}

export async function deleteThreadRecord(input: {
  threadId: string;
  teamId: string;
  workspaceId: string;
  viewerUserId: string;
  isContentAdmin: boolean;
}) {
  // Deleting is a destructive mutation, so it is scoped tighter than reading: a
  // plain editor may only delete threads they created (or legacy creator-less
  // ones), NOT another member's shared thread. A content admin manages the
  // workspace and may delete any thread that is visible to them — which still
  // excludes other members' private threads via the visibility clause. An
  // invisible/otherwise-out-of-scope thread simply matches no row and the delete
  // reports not-found, so ids can't be probed.
  const deletableClause = input.isContentAdmin
    ? threadVisibilityClause(4)
    : `(created_by = $4 or created_by is null)`;
  //
  // The sub-agent threads the thread's own `task` calls opened go with it, in
  // the same statement and only when the thread itself is deleted. They are
  // transcripts of its turns, so the caller's right to delete the thread covers
  // them whoever ran the turn. A sub-agent thread a member created under it is
  // their own conversation: it stays, and the foreign key clears its parent.
  const result = await database.query<{ id: string }>(
    `
      with deleted_thread as (
        delete from threads
        where id = $1
          and team_id = $2
          and workspace_id = $3
          and ${deletableClause}
        returning id
      ),
      deleted_delegate_threads as (
        delete from threads
        where parent_thread_id = $1
          and team_id = $2
          and workspace_id = $3
          and origin = 'subagent'
          and exists (select 1 from deleted_thread)
        returning id
      )
      select id from deleted_thread
    `,
    [input.threadId, input.teamId, input.workspaceId, input.viewerUserId],
  );

  return result.rows.length > 0;
}

async function listPinnedThreadRecords(input: {
  teamId: string;
  workspaceId: string;
  viewerUserId: string;
  limit: number;
}) {
  const result = await database.query<RawThreadRow>(
    `
      select ${THREAD_RETURNING_SQL}
      from threads
      join lateral (
        select p.pinned_at from thread_pins p
        where p.thread_id = threads.id and p.user_id = $3
      ) pin on true
      where team_id = $1
        and workspace_id = $2
        and archived = false
        and parent_thread_id is null
        and ${threadVisibilityClause(3)}
      order by pin.pinned_at desc, id desc
      limit $4
    `,
    [
      input.teamId,
      input.workspaceId,
      input.viewerUserId,
      Math.min(input.limit, MAX_PINNED_THREADS),
    ],
  );

  const sourceCounts = await countUsedSourceIdsByThread({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadIds: result.rows.map((row) => row.id),
  });

  return result.rows.map((row) =>
    mapRawThread(row, sourceCounts.get(row.id) ?? 0),
  );
}

/**
 * Renames a top-level chat under the same rule as archive and delete. Returns
 * false when the chat is missing, a sub-agent chat, or not the viewer's to
 * rename.
 */
export async function renameThreadRecord(input: {
  threadId: string;
  teamId: string;
  workspaceId: string;
  viewerUserId: string;
  isContentAdmin: boolean;
  title: string;
}) {
  const renamableClause = input.isContentAdmin
    ? threadVisibilityClause(4)
    : `(created_by = $4 or created_by is null)`;
  const result = await database.query<{ id: string }>(
    `
      update threads
      set title = $5,
          updated_at = now()
      where id = $1
        and team_id = $2
        and workspace_id = $3
        and parent_thread_id is null
        and ${renamableClause}
      returning id
    `,
    [
      input.threadId,
      input.teamId,
      input.workspaceId,
      input.viewerUserId,
      input.title,
    ],
  );

  return result.rows.length > 0;
}

/**
 * Pins or unpins a top-level chat for the viewer only.
 *
 * - Pin: "not_found" when the viewer cannot see the chat, "limit" when they
 *   already have MAX_PINNED_THREADS other listable pins here (so no pin falls
 *   off the pinned list), otherwise "ok".
 * - Unpin: always removes the viewer's own pin row and returns "ok", even when
 *   the chat is no longer visible to them.
 */
export async function setThreadPinnedRecord(input: {
  threadId: string;
  teamId: string;
  workspaceId: string;
  viewerUserId: string;
  pinned: boolean;
}): Promise<"ok" | "not_found" | "limit"> {
  if (!input.pinned) {
    await database.query(
      `delete from thread_pins
       where thread_id = $1 and user_id = $2 and workspace_id = $3`,
      [input.threadId, input.viewerUserId, input.workspaceId],
    );
    return "ok";
  }

  const result = await database.query<{ visible: number; pinned: number }>(
    `
      with target as (
        select id, team_id, workspace_id
        from threads
        where id = $1
          and team_id = $2
          and workspace_id = $3
          and parent_thread_id is null
          and ${threadVisibilityClause(4)}
      ),
      -- Pins the viewer can see in the pinned list, other than this chat.
      listed_pins as (
        select count(*)::int as n
        from thread_pins p
        join threads t on t.id = p.thread_id
        where p.user_id = $4
          and p.workspace_id = $3
          and p.thread_id <> $1
          and t.archived = false
          and t.parent_thread_id is null
          and (t.visibility <> 'private' or t.created_by = $4)
      ),
      pin_write as (
        insert into thread_pins (thread_id, user_id, team_id, workspace_id)
        select id, $4, team_id, workspace_id from target
        where (select n from listed_pins) < $5
        on conflict (thread_id, user_id) do nothing
      )
      select
        (select count(*)::int from target) as visible,
        (select n from listed_pins) as pinned
    `,
    [
      input.threadId,
      input.teamId,
      input.workspaceId,
      input.viewerUserId,
      MAX_PINNED_THREADS,
    ],
  );

  const row = result.rows[0];
  if (!row || row.visible === 0) return "not_found";
  if (row.pinned >= MAX_PINNED_THREADS) return "limit";
  return "ok";
}

/** Escapes `\`, `%` and `_` so a search query matches them literally. */
function escapeLikePattern(query: string) {
  return query.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Top-level chats visible to the viewer whose title or user/assistant message
 * text contains `query` (case-insensitive), archived ones included, newest
 * activity first. `hitContent` is the newest matching message, if any.
 */
export async function searchThreadRecords(input: {
  teamId: string;
  workspaceId: string;
  viewerUserId: string;
  query: string;
  limit: number;
}) {
  const result = await database.query<
    RawThreadRow & {
      archived: boolean;
      title_match: boolean;
      hit_content: string | null;
    }
  >(
    `
      select ${THREAD_RETURNING_SQL},
        archived,
        (title ilike $4 escape '\\') as title_match,
        hit.content as hit_content
      from threads
      left join lateral (
        select m.content
        from messages m
        where m.thread_id = threads.id
          and m.role in ('user', 'assistant')
          and m.content ilike $4 escape '\\'
        order by m.created_at desc
        limit 1
      ) hit on true
      where team_id = $1
        and workspace_id = $2
        and parent_thread_id is null
        and ${threadVisibilityClause(3)}
        and (title ilike $4 escape '\\' or hit.content is not null)
      order by ${THREAD_ACTIVITY_SQL} desc, id desc
      limit $5
    `,
    [
      input.teamId,
      input.workspaceId,
      input.viewerUserId,
      `%${escapeLikePattern(input.query)}%`,
      input.limit,
    ],
  );

  const sourceCounts = await countUsedSourceIdsByThread({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadIds: result.rows.map((row) => row.id),
  });

  return result.rows.map((row) => ({
    thread: mapRawThread(row, sourceCounts.get(row.id) ?? 0),
    archived: row.archived,
    titleMatch: row.title_match,
    hitContent: row.hit_content,
  }));
}

/**
 * Archives or restores a top-level thread. The right to do so is the right to
 * delete it: a plain editor only their own (or legacy creator-less) threads, a
 * content admin any thread visible to them. A sub-agent thread, an invisible
 * thread or one out of scope matches no row and returns false. Its sub-agent
 * threads keep their own flag and stay nested under it.
 */
export async function setThreadArchivedRecord(input: {
  threadId: string;
  teamId: string;
  workspaceId: string;
  viewerUserId: string;
  isContentAdmin: boolean;
  archived: boolean;
}) {
  const archivableClause = input.isContentAdmin
    ? threadVisibilityClause(4)
    : `(created_by = $4 or created_by is null)`;
  const result = await database.query<{ id: string }>(
    `
      update threads
      set archived = $5,
          updated_at = now()
      where id = $1
        and team_id = $2
        and workspace_id = $3
        and parent_thread_id is null
        and ${archivableClause}
      returning id
    `,
    [
      input.threadId,
      input.teamId,
      input.workspaceId,
      input.viewerUserId,
      input.archived,
    ],
  );

  return result.rows.length > 0;
}

export async function updateThreadModelSettingsRecord(input: {
  threadId: string;
  teamId: string;
  workspaceId: string;
  modelSettings: ThreadModelSettings;
}) {
  const updatedAt = new Date();
  const result = await database.query<RawThreadRow>(
    `
      update threads
      set model_settings_json = $4::jsonb,
          updated_at = greatest(updated_at, $5::timestamptz)
      where id = $1
        and team_id = $2
        and workspace_id = $3
      returning ${THREAD_RETURNING_SQL}
    `,
    [
      input.threadId,
      input.teamId,
      input.workspaceId,
      JSON.stringify(normalizeThreadModelSettings(input.modelSettings)),
      updatedAt.toISOString(),
    ],
  );
  const row = result.rows[0];

  if (!row) return null;

  const sourceCounts = await countUsedSourceIdsByThread({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadIds: [row.id],
  });

  return mapRawThread(row, sourceCounts.get(row.id) ?? 0);
}

export async function updateThreadChatPreferencesRecord(input: {
  threadId: string;
  teamId: string;
  workspaceId: string;
  chatPreferences: ThreadChatPreferencesPatch;
}) {
  const updatedAt = new Date();
  // The patch is merged into the stored preferences, so the read and the
  // write must not interleave with another patch: a new chat saves several
  // preferences at once, and an unlocked read lets the later write restore
  // the fields the earlier one just changed. The row lock makes concurrent
  // patches apply one after another.
  const result = await db.transaction(async (tx) => {
    const current = await tx.execute<{ chat_preferences_json: unknown }>(sql`
      select chat_preferences_json
      from threads
      where id = ${input.threadId}
        and team_id = ${input.teamId}
        and workspace_id = ${input.workspaceId}
      for update
    `);
    const currentRow = current.rows[0];
    if (!currentRow) return null;

    const nextPreferences = mergeThreadChatPreferences(
      normalizeThreadChatPreferences(currentRow.chat_preferences_json),
      input.chatPreferences,
    );
    return tx.execute<RawThreadRow>(sql`
      update threads
      set chat_preferences_json = ${JSON.stringify(nextPreferences)}::jsonb,
          updated_at = greatest(updated_at, ${updatedAt.toISOString()}::timestamptz)
      where id = ${input.threadId}
        and team_id = ${input.teamId}
        and workspace_id = ${input.workspaceId}
      returning ${sql.raw(THREAD_RETURNING_SQL)}
    `);
  });
  if (!result) return null;

  const row = result.rows[0];
  if (!row) return null;

  const sourceCounts = await countUsedSourceIdsByThread({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadIds: [row.id],
  });

  return mapRawThread(row, sourceCounts.get(row.id) ?? 0);
}

/**
 * Changes a thread's visibility. Scoped to `created_by = viewer`: only the
 * author decides whether their conversation is private or shared with the
 * workspace. A thread the caller did not create matches no row and returns
 * null, which the service reports as not-found.
 */
export async function updateThreadVisibilityRecord(input: {
  threadId: string;
  teamId: string;
  workspaceId: string;
  viewerUserId: string;
  visibility: ThreadRecord["visibility"];
}) {
  const updated = await db.transaction(async (tx) => {
    // This update holds the thread row lock until all inherited visibility and
    // public grants are committed. Other flips and artifact publishers (which
    // acquire FOR SHARE on the thread) cannot interleave with these writes.
    const result = await tx.execute<RawThreadRow>(sql`
      update threads
      set visibility = ${input.visibility},
          updated_at = now()
      where id = ${input.threadId}
        and team_id = ${input.teamId}
        and workspace_id = ${input.workspaceId}
        and created_by = ${input.viewerUserId}
      returning ${sql.raw(THREAD_RETURNING_SQL)}
    `);
    const row = result.rows[0];
    if (!row) return null;

    const revokedArtifactIds =
      input.visibility === "private"
        ? await revokeShareLinksForThreadArtifacts(input, tx)
        : [];
    await updateArtifactsVisibilityForThread(
      {
        ...input,
        threadVisibility: input.visibility,
      },
      tx,
    );

    return { row, revokedArtifactIds };
  });
  if (!updated) return null;

  const sourceCounts = await countUsedSourceIdsByThread({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadIds: [updated.row.id],
  });

  return {
    thread: mapRawThread(updated.row, sourceCounts.get(updated.row.id) ?? 0),
    revokedArtifactIds: updated.revokedArtifactIds,
  };
}

export async function updateThreadTitleIfMatches(input: {
  threadId: string;
  teamId: string;
  workspaceId: string;
  expectedTitles: string[];
  title: string;
}) {
  const expectedTitles = [
    ...new Set(
      input.expectedTitles.map((title) => title.trim()).filter(Boolean),
    ),
  ];
  const nextTitle = input.title.trim();

  if (expectedTitles.length === 0 || nextTitle.length === 0) {
    return null;
  }

  const updatedAt = new Date();
  const result = await database.query<RawThreadRow>(
    `
      update threads
      set title = $4,
          updated_at = greatest(updated_at, $6::timestamptz)
      where id = $1
        and team_id = $2
        and workspace_id = $3
        and title = any($5::text[])
      returning ${THREAD_RETURNING_SQL}
    `,
    [
      input.threadId,
      input.teamId,
      input.workspaceId,
      nextTitle,
      toPostgresTextArray(expectedTitles),
      updatedAt.toISOString(),
    ],
  );
  const row = result.rows[0];

  if (!row) return null;

  const sourceCounts = await countUsedSourceIdsByThread({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadIds: [row.id],
  });

  return mapRawThread(row, sourceCounts.get(row.id) ?? 0);
}

/**
 * The sub-agent conversations nested directly under each of `parentThreadIds`,
 * newest activity first. One level only (the sidebar shows one), and the same
 * visibility rule as the top-level list: another member's private child stays
 * hidden even when its parent is shared.
 */
export async function listChildThreadRecords(input: {
  teamId: string;
  workspaceId: string;
  viewerUserId: string;
  parentThreadIds: readonly string[];
}) {
  if (input.parentThreadIds.length === 0) {
    return [] as ThreadRecord[];
  }
  const visibility = threadVisibilityClause(3);
  const result = await database.query<RawThreadRow>(
    `
      select ${THREAD_RETURNING_SQL}
      from threads
      where team_id = $1
        and workspace_id = $2
        and archived = false
        and parent_thread_id = any($4::text[])
        and ${visibility}
      order by ${THREAD_ACTIVITY_SQL} desc, id desc
    `,
    [
      input.teamId,
      input.workspaceId,
      input.viewerUserId,
      toPostgresTextArray([...input.parentThreadIds]),
    ],
  );
  const sourceCounts = await countUsedSourceIdsByThread({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadIds: result.rows.map((row) => row.id),
  });
  return result.rows.map((row) =>
    mapRawThread(row, sourceCounts.get(row.id) ?? 0),
  );
}

/**
 * The sub-agent thread a `task` call was projected into, found by the call id
 * stamped on its projected messages. A `task` whose delegate paused for
 * approval resumes in a later run under the same call id; this is how that run
 * continues the same child thread instead of opening another.
 */
export async function findSubagentThreadRecordByTaskCall(input: {
  teamId: string;
  workspaceId: string;
  parentThreadId: string;
  taskCallId: string;
}) {
  const result = await database.query<RawThreadRow>(
    `
      select ${THREAD_RETURNING_SQL}
      from threads
      where team_id = $1
        and workspace_id = $2
        and parent_thread_id = $3
        and origin = 'subagent'
        and exists (
          select 1
          from messages
          where messages.thread_id = threads.id
            and messages.metadata->'subagent'->>'taskCallId' = $4
        )
      order by created_at desc
      limit 1
    `,
    [input.teamId, input.workspaceId, input.parentThreadId, input.taskCallId],
  );
  const row = result.rows[0];
  return row ? mapRawThread(row) : null;
}
