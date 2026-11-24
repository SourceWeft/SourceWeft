/**
 * Removes every connector of the teams being erased (a deleted organization,
 * or a deleting user's personal organization), revoking each stored
 * authorization at its provider before anything local is deleted.
 *
 * Revocation goes through `ConnectorOAuthService.revokeStoredAuthorization`, the
 * same call a single connector delete uses: a provider failure throws the
 * retryable `CONNECTOR_AUTHORIZATION_REVOKE_FAILED` and nothing local has been
 * deleted yet, so the caller's delete aborts and can be retried. Revocation is
 * idempotent (Composio answers 404 for an already-removed connection, which is
 * treated as done), so a retry after a partial pass is safe.
 */
import { ConnectorOAuthService } from "./oauth-service";
import {
  hardDeleteTeamConnectorRecords,
  listTeamOAuthAccountSecretRecords,
} from "./repository";

type Revoker = Pick<ConnectorOAuthService, "revokeStoredAuthorization">;

export type TeamConnectorRemovalRepository = {
  listTeamOAuthAccountSecretRecords: typeof listTeamOAuthAccountSecretRecords;
  hardDeleteTeamConnectorRecords: typeof hardDeleteTeamConnectorRecords;
};

const defaultRepository: TeamConnectorRemovalRepository = {
  listTeamOAuthAccountSecretRecords,
  hardDeleteTeamConnectorRecords,
};

export class ConnectorTeamDataRemoval {
  constructor(
    private readonly oauthService: Revoker = new ConnectorOAuthService(),
    private readonly repository: TeamConnectorRemovalRepository = defaultRepository,
  ) {}

  /**
   * Revoke every authorization of every given team first, then delete their
   * connector data, so one failed revocation leaves all of the teams intact.
   */
  async removeTeams(teamIds: string[]) {
    const unique = [...new Set(teamIds)];
    for (const teamId of unique) {
      const accounts =
        await this.repository.listTeamOAuthAccountSecretRecords(teamId);
      for (const account of accounts) {
        await this.oauthService.revokeStoredAuthorization(account);
      }
    }
    const results = [];
    for (const teamId of unique) {
      results.push({
        teamId,
        ...(await this.repository.hardDeleteTeamConnectorRecords(teamId)),
      });
    }
    return results;
  }
}
