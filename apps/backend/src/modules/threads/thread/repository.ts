import { randomUUID } from "node:crypto";
import { database } from "@sourceweft/db";
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

type RawThreadRow = {
  id: string;
  team_id: string;
  workspace_id: string;
  title: string;
  model_settings_json: ThreadModelSettingsInput | undefined;
  chat_preferences_json: unknown;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

const THREAD_RETURNING_SQL = `
  id,
  team_id,
  workspace_id,
  title,
  model_settings_json,
  chat_preferences_json,
  created_by,
  created_at,
  updated_at
`;

function mapRawThread(row: RawThreadRow, sourceCount = 0): ThreadRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    workspaceId: row.workspace_id,
    title: row.title,
    modelSettings: normalizePersistedThreadModelSettings(
      row.model_settings_json,
    ),
    chatPreferences: normalizeThreadChatPreferences(row.chat_preferences_json),
    sourceCount,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
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
  teamId: string;
  workspaceId: string;
  title: string;
  createdBy: string;
  modelSettings?: Partial<ThreadModelSettings>;
  chatPreferences?: Partial<ThreadChatPreferences>;
}) {
  const id = randomUUID();
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
        created_by
      )
      values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
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
    ],
  );
  const row = result.rows[0];

  if (!row) {
    throw new Error("Failed to create thread");
  }

  return mapRawThread(row);
}

export async function listThreadRecordsByWorkspace(input: {
  teamId: string;
  workspaceId: string;
  limit: number;
  cursor?: {
    id: string;
    updatedAt: string;
  };
}) {
  const cursorDate = input.cursor ? new Date(input.cursor.updatedAt) : null;
  const hasValidCursor =
    Boolean(input.cursor) &&
    Boolean(cursorDate) &&
    !Number.isNaN(cursorDate?.getTime());
  const result = await database.query<RawThreadRow>(
    `
      select ${THREAD_RETURNING_SQL}
      from threads
      where team_id = $1
        and workspace_id = $2
        and archived = false
        ${
          hasValidCursor
            ? "and (updated_at < $3::timestamptz or (updated_at = $3::timestamptz and id < $4))"
            : ""
        }
      order by updated_at desc, id desc
      limit ${hasValidCursor ? "$5" : "$3"}
    `,
    hasValidCursor
      ? [
          input.teamId,
          input.workspaceId,
          cursorDate?.toISOString(),
          input.cursor?.id,
          input.limit,
        ]
      : [input.teamId, input.workspaceId, input.limit],
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
      select
        id,
        team_id,
        workspace_id,
        title,
        model_settings_json,
        chat_preferences_json,
        created_by,
        created_at,
        updated_at
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
}) {
  const result = await database.query<{ id: string }>(
    `
      delete from threads
      where id = $1
        and team_id = $2
        and workspace_id = $3
      returning id
    `,
    [input.threadId, input.teamId, input.workspaceId],
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
  const current = await findThreadRecord({
    threadId: input.threadId,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
  });
  if (!current) return null;

  const updatedAt = new Date();
  const nextPreferences = mergeThreadChatPreferences(
    current.chatPreferences,
    input.chatPreferences,
  );
  const result = await database.query<RawThreadRow>(
    `
      update threads
      set chat_preferences_json = $4::jsonb,
          updated_at = greatest(updated_at, $5::timestamptz)
      where id = $1
        and team_id = $2
        and workspace_id = $3
      returning
        id,
        team_id,
        workspace_id,
        title,
        model_settings_json,
        chat_preferences_json,
        created_by,
        created_at,
        updated_at
    `,
    [
      input.threadId,
      input.teamId,
      input.workspaceId,
      JSON.stringify(nextPreferences),
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
