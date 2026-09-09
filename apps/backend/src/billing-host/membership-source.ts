import type { Pool, PoolClient } from "pg";
/** Auth table ownership remains in the host; a caller's billing transaction is preserved. */
export function createBillingMembershipSource(pool: Pool) {
  return {
    async listTeamMemberUserIds(teamId: string, client?: PoolClient) {
      const result = await (client ?? pool).query<{ userId: string }>(
        'select "userId" from member where "organizationId" = $1',
        [teamId],
      );
      return result.rows.map((row) => row.userId);
    },
    async countTeamMembers(teamId: string, client?: PoolClient) {
      const result = await (client ?? pool).query<{ count: string }>(
        'select count(*)::text as count from member where "organizationId" = $1',
        [teamId],
      );
      const count = Number(result.rows[0]?.count ?? 0);
      return Number.isFinite(count) ? count : 0;
    },
    async countPendingTeamInvitations(teamId: string, client?: PoolClient) {
      const result = await (client ?? pool).query<{ count: string }>(
        `select count(*)::text as count from invitation where "organizationId" = $1 and status = 'pending' and "expiresAt" > now()`,
        [teamId],
      );
      const count = Number(result.rows[0]?.count ?? 0);
      return Number.isFinite(count) ? count : 0;
    },
  };
}
