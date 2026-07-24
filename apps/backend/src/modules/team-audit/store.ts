import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db, teamAuditLogs } from "@sourceweft/db";
import type { TeamAuditEntry, TeamAuditLog } from "./types";

export async function insertTeamAuditLogRecord(entry: TeamAuditEntry) {
  const [row] = await db
    .insert(teamAuditLogs)
    .values({
      id: randomUUID(),
      teamId: entry.teamId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      metadata: entry.metadata ?? {},
    })
    .returning();

  return row ?? null;
}

export async function listTeamAuditLogRecords(input: {
  teamId: string;
  limit: number;
}): Promise<TeamAuditLog[]> {
  const rows = await db
    .select()
    .from(teamAuditLogs)
    .where(eq(teamAuditLogs.teamId, input.teamId))
    .orderBy(desc(teamAuditLogs.createdAt))
    .limit(input.limit);

  return rows.map((row) => ({
    id: row.id,
    teamId: row.teamId,
    actorUserId: row.actorUserId,
    action: row.action as TeamAuditLog["action"],
    targetType: row.targetType as TeamAuditLog["targetType"],
    targetId: row.targetId,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  }));
}
