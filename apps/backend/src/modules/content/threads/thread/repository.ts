import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "../../../../shared/database";
import { messages, threads } from "../../../../shared/db/schema";
import { toPostgresTextArray } from "../../sql";
import type { ThreadRecord } from "../../types";
import {
  normalizePersistedThreadModelSettings,
  normalizeThreadModelSettings,
  type ThreadModelSettings,
} from "../model-settings";

type ThreadRow = typeof threads.$inferSelect;

function mapThread(row: ThreadRow, sourceCount = 0): ThreadRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    title: row.title,
    modelSettings: normalizePersistedThreadModelSettings(row.modelSettingsJson),
    sourceCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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

  const rows = await db.execute<{
    thread_id: string;
    source_count: number | string;
  }>(sql`
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
    where m.team_id = ${input.teamId}
      and m.workspace_id = ${input.workspaceId}
      and m.role = 'user'
      and m.thread_id = any(${toPostgresTextArray(input.threadIds)}::text[])
    group by m.thread_id
  `);

  return new Map(
    rows.rows.map((row) => [row.thread_id, Number(row.source_count)]),
  );
}

export async function createThreadRecord(input: {
  teamId: string;
  workspaceId: string;
  title: string;
  createdBy: string;
  modelSettings?: Partial<ThreadModelSettings>;
}) {
  const id = randomUUID();
  const modelSettings = normalizeThreadModelSettings(input.modelSettings);
  const [row] = await db
    .insert(threads)
    .values({
      id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      title: input.title,
      modelSettingsJson: modelSettings,
      createdBy: input.createdBy,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create thread");
  }

  return mapThread(row);
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
  const whereConditions = [
    eq(threads.teamId, input.teamId),
    eq(threads.workspaceId, input.workspaceId),
    eq(threads.archived, false),
  ];

  if (input.cursor && cursorDate) {
    const cursorConditions = or(
      lt(threads.updatedAt, cursorDate),
      and(eq(threads.updatedAt, cursorDate), lt(threads.id, input.cursor.id)),
    );
    if (cursorConditions) {
      whereConditions.push(cursorConditions);
    }
  }

  const rows = await db
    .select()
    .from(threads)
    .where(and(...whereConditions))
    .orderBy(desc(threads.updatedAt), desc(threads.id))
    .limit(input.limit);

  const sourceCounts = await countUsedSourceIdsByThread({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadIds: rows.map((row) => row.id),
  });

  return rows.map((row) => mapThread(row, sourceCounts.get(row.id) ?? 0));
}

export async function findThreadRecord(input: {
  threadId: string;
  teamId: string;
  workspaceId: string;
}) {
  const [row] = await db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.id, input.threadId),
        eq(threads.teamId, input.teamId),
        eq(threads.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  if (!row) return null;

  const sourceCounts = await countUsedSourceIdsByThread({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadIds: [row.id],
  });

  return mapThread(row, sourceCounts.get(row.id) ?? 0);
}

export async function deleteThreadRecord(input: {
  threadId: string;
  teamId: string;
  workspaceId: string;
}) {
  const rows = await db
    .delete(threads)
    .where(
      and(
        eq(threads.id, input.threadId),
        eq(threads.teamId, input.teamId),
        eq(threads.workspaceId, input.workspaceId),
      ),
    )
    .returning({ id: threads.id });

  return rows.length > 0;
}

export async function updateThreadModelSettingsRecord(input: {
  threadId: string;
  teamId: string;
  workspaceId: string;
  modelSettings: ThreadModelSettings;
}) {
  const updatedAt = new Date();
  const [row] = await db
    .update(threads)
    .set({
      modelSettingsJson: normalizeThreadModelSettings(input.modelSettings),
      updatedAt: sql`greatest(${threads.updatedAt}, ${updatedAt})`,
    })
    .where(
      and(
        eq(threads.id, input.threadId),
        eq(threads.teamId, input.teamId),
        eq(threads.workspaceId, input.workspaceId),
      ),
    )
    .returning();

  if (!row) return null;

  const sourceCounts = await countUsedSourceIdsByThread({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadIds: [row.id],
  });

  return mapThread(row, sourceCounts.get(row.id) ?? 0);
}

export async function updateThreadTitleIfMatches(input: {
  threadId: string;
  teamId: string;
  workspaceId: string;
  expectedTitles: string[];
  title: string;
}) {
  const expectedTitles = [
    ...new Set(input.expectedTitles.map((title) => title.trim()).filter(Boolean)),
  ];
  const nextTitle = input.title.trim();

  if (expectedTitles.length === 0 || nextTitle.length === 0) {
    return null;
  }

  const updatedAt = new Date();
  const [row] = await db
    .update(threads)
    .set({
      title: nextTitle,
      updatedAt: sql`greatest(${threads.updatedAt}, ${updatedAt})`,
    })
    .where(
      and(
        eq(threads.id, input.threadId),
        eq(threads.teamId, input.teamId),
        eq(threads.workspaceId, input.workspaceId),
        inArray(threads.title, expectedTitles),
      ),
    )
    .returning();

  if (!row) return null;

  const sourceCounts = await countUsedSourceIdsByThread({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadIds: [row.id],
  });

  return mapThread(row, sourceCounts.get(row.id) ?? 0);
}
