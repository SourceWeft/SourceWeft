import type { ConnectorOAuthService } from "./oauth-service";
import type { ConnectorManifest, SourceConnectorRecord } from "./types";

export type CredentialDeps = {
  getRuntimeToken: ConnectorOAuthService["getRuntimeToken"];
  getManifest: (connectorType: string) => ConnectorManifest;
};

/**
 * The access token a connector's adapter receives for one run, sync or action.
 * A `none` connector has no account and no credential: it gets `""` and the
 * OAuth account lookup is never reached. `oauth2` and `brokered` connectors
 * resolve through `getRuntimeToken` unchanged, so a missing account still
 * fails with `CONNECTOR_OAUTH_ACCOUNT_REQUIRED`. A manifest without `auth` is
 * treated as `oauth2`, which keeps test doubles that omit it working.
 */
export async function resolveCredential(
  deps: CredentialDeps,
  input: {
    teamId: string;
    workspaceId: string;
    connector: Pick<SourceConnectorRecord, "connectorType" | "oauthAccountId">;
  },
): Promise<string> {
  const { connector } = input;
  const manifest = deps.getManifest(connector.connectorType);
  if (manifest.auth?.kind === "none") {
    return "";
  }
  return deps.getRuntimeToken({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    accountId: connector.oauthAccountId,
    connectorType: connector.connectorType,
  });
}
