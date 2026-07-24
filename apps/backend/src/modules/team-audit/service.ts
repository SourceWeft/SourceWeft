import { logger } from "../../shared/logger";
import { insertTeamAuditLogRecord, listTeamAuditLogRecords } from "./store";
import type { TeamAuditEntry, TeamAuditLog } from "./types";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

export class TeamAuditService {
  /**
   * Records an administrative action. Auditing is observational: a failure here
   * must not fail the action being audited, so the error is logged and
   * swallowed rather than propagated.
   */
  async record(entry: TeamAuditEntry) {
    try {
      await insertTeamAuditLogRecord(entry);
    } catch (error) {
      logger.error("Failed to write team audit log", {
        action: entry.action,
        teamId: entry.teamId,
        targetId: entry.targetId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async list(input: {
    teamId: string;
    limit?: number;
  }): Promise<TeamAuditLog[]> {
    const limit = Math.min(
      Math.max(input.limit ?? DEFAULT_LIST_LIMIT, 1),
      MAX_LIST_LIMIT,
    );

    return listTeamAuditLogRecords({ teamId: input.teamId, limit });
  }
}

export const teamAuditService = new TeamAuditService();
