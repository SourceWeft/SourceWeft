import type {
  ConnectorCredentialInput,
  ConnectorCredentialStatus,
} from "@sourceweft/contracts";
import { ConnectorError } from "./errors";
import { validateObjectWithJsonSchema } from "./config-validation";
import { comparableConfig } from "./json-compare";
import { withoutSyncReadinessMetadata } from "./sync-readiness-metadata";
import { ConnectorOAuthService } from "./oauth-service";
import { requireConnectorWorkspace } from "./permissions";
import { encryptTeamSecret } from "../../shared/team-secrets";
import {
  archiveConnectorSources,
  createCredentialConnectorRecord,
  createSourceConnectorRecord,
  deleteOAuthAccountRecord,
  findOAuthAccountByProviderAccountInWorkspace,
  findOAuthAccountRecord,
  findSourceConnectorRecord,
  findSourceConnectorRecordByName,
  getConnectorScheduleStatus,
  hardDeleteSourceConnectorRecord,
  hasOtherSourceConnectorOAuthAccountReferences,
  hasSourceConnectorOAuthAccountReferences,
  listOAuthAccountRecords,
  listSourceConnectorRecords,
  listConnectorScheduleStatuses,
  listWorkspaceSourceConnectorRecordsByOAuthAccount,
  putConnectorSchedule,
  updateOAuthAccountCredentialRecord,
  updateSourceConnectorRecord,
} from "./repository";
import { ConnectorRegistry, connectorRegistry } from "./registry";
import type {
  ConnectorStatus,
  ConnectorSyncReadinessResult,
  SourceConnectorRecord,
} from "./types";

/**
 * The opaque credential string an adapter receives in `accessToken` for a
 * `credential` connector: the member's username and secret as JSON. Built in
 * exactly one place so the check path and the stored value never diverge. The
 * secret never leaves this shape — it is encrypted before storage and never
 * logged, copied into configJson, or returned.
 */
function credentialAccessToken(credential: ConnectorCredentialInput): string {
  return JSON.stringify({
    username: credential.username,
    secret: credential.secret,
  });
}

/**
 * Rejects a username the stored credential could not be parsed back out of. A
 * ':' separates the username from the secret in a Basic `Authorization` header,
 * so a username containing one makes the stored credential ambiguous and the
 * account would get stuck `reauth_required` on the first sync. The web already
 * blocks this; this guard closes the direct-API path. The contract schema is
 * left as-is (a `trim().min(1).max(200)` string) and the check lives here so
 * create, check and rotate all raise the same fixed code with no input echoed.
 */
function assertCredentialUsername(credential: ConnectorCredentialInput): void {
  if (credential.username.includes(":")) {
    throw new ConnectorError(
      400,
      "CONNECTOR_CREDENTIAL_USERNAME_INVALID",
      "The username cannot contain a colon",
    );
  }
}

export class ConnectorService {
  constructor(
    private readonly registry: ConnectorRegistry = connectorRegistry,
    private readonly oauthService: ConnectorOAuthService = new ConnectorOAuthService(
      registry,
    ),
  ) {}

  /**
   * Runs the adapter's readiness check against a configuration that is not
   * yet (or not yet newly) stored. Only credential-free connectors can be
   * checked this way: an OAuth connector has no usable credential until an
   * account is attached.
   */
  private async evaluateConfigReadiness(input: {
    teamId: string;
    workspaceId: string;
    connectorType: string;
    connectorId: string;
    connectorName?: string;
    configJson: Record<string, unknown>;
    /** The credential a readiness check runs with. `""` (the default) for a
     * credential-free connector; the credential JSON for a `credential` one.
     * It is passed straight to the adapter and never persisted. */
    accessToken?: string;
  }): Promise<ConnectorSyncReadinessResult> {
    const adapter = this.registry.getAdapter(input.connectorType);
    if (!adapter.checkSyncReadiness) {
      return { ready: true };
    }
    return adapter.checkSyncReadiness({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      connectorType: input.connectorType,
      connectorName: input.connectorName,
      config: input.configJson,
      accessToken: input.accessToken ?? "",
    });
  }

  /** The connector's declared auth kind, or `undefined` when its adapter is not
   * registered in this process (e.g. a connector type switched off at
   * deployment level). Never throws, so response enrichment and listing stay
   * safe for a connector whose adapter is absent. */
  private safeManifestAuthKind(connectorType: string): string | undefined {
    try {
      return this.registry.getManifest(connectorType).auth?.kind;
    } catch {
      return undefined;
    }
  }

  /**
   * Attach `credentialConfigured`/`credentialDisplayName` to a connector that
   * is served in a response, but only for a `credential`-kind connector. The
   * values come from the connector's own stored account; the secret is read
   * neither here nor anywhere a response is built. Every other kind is returned
   * unchanged, with no extra account lookup.
   */
  private async withCredentialStatus<
    T extends { connectorType: string; oauthAccountId: string | null },
  >(
    teamId: string,
    workspaceId: string,
    connector: T,
  ): Promise<
    T & {
      credentialConfigured?: boolean;
      credentialDisplayName?: string | null;
    }
  > {
    if (this.safeManifestAuthKind(connector.connectorType) !== "credential") {
      return connector;
    }
    const account = connector.oauthAccountId
      ? await findOAuthAccountRecord({
          teamId,
          workspaceId,
          accountId: connector.oauthAccountId,
        })
      : null;
    return {
      ...connector,
      credentialConfigured: Boolean(account && account.status === "active"),
      credentialDisplayName: account ? account.displayName : null,
    };
  }

  private async requireConfigReady(
    input: Parameters<ConnectorService["evaluateConfigReadiness"]>[0],
  ) {
    const readiness = await this.evaluateConfigReadiness(input);
    if (!readiness.ready) {
      throw new ConnectorError(
        400,
        "CONNECTOR_CONFIG_NOT_READY",
        readiness.message ?? "The connector configuration is not ready",
        { reason: readiness.reason },
      );
    }
  }

  async checkConfigReadiness(input: {
    workspaceId: string;
    userId: string;
    connectorType: string;
    configJson: Record<string, unknown>;
    credential?: ConnectorCredentialInput;
  }): Promise<ConnectorSyncReadinessResult> {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.manage",
    });
    const manifest = this.registry.getManifest(input.connectorType);
    const authKind = manifest.auth?.kind;
    // A credential belongs only to a credential connector; reject (never ignore)
    // one sent for any other kind, before the unsupported-check branch so an
    // oauth2 request carrying a credential is rejected for the right reason.
    if (authKind !== "credential" && input.credential != null) {
      throw new ConnectorError(
        400,
        "CONNECTOR_CREDENTIAL_NOT_ALLOWED",
        "This connector does not accept a username and secret",
      );
    }
    if (authKind !== "none" && authKind !== "credential") {
      throw new ConnectorError(
        400,
        "CONNECTOR_CHECK_UNSUPPORTED",
        "This connector does not support a configuration check",
      );
    }
    validateObjectWithJsonSchema({
      schema: manifest.configSchema,
      value: input.configJson,
      label: "configJson",
    });
    // A credential connector is checked against the entered credential; nothing
    // is persisted. The credential JSON is handed to the adapter only, never
    // stored or logged here.
    let accessToken = "";
    if (authKind === "credential") {
      if (!input.credential) {
        throw new ConnectorError(
          400,
          "CONNECTOR_CREDENTIAL_REQUIRED",
          "This connector requires a username and secret",
        );
      }
      assertCredentialUsername(input.credential);
      accessToken = credentialAccessToken(input.credential);
    }
    return this.evaluateConfigReadiness({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorType: input.connectorType,
      connectorId: "pending",
      configJson: input.configJson,
      accessToken,
    });
  }

  listManifests() {
    return { items: this.registry.listManifests() };
  }

  async listAccounts(input: {
    workspaceId: string;
    userId: string;
    connectorType?: string;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.read",
    });
    const items = await listOAuthAccountRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorType: input.connectorType,
    });
    // Retain existing rows under workspace ACL for disconnect and cleanup after revocation.
    return { items };
  }

  async createConnector(input: {
    workspaceId: string;
    userId: string;
    connectorType: string;
    name: string;
    oauthAccountId?: string | null;
    configJson?: Record<string, unknown>;
    periodicIndexingEnabled?: boolean;
    indexingFrequencyMinutes?: number | null;
    credential?: ConnectorCredentialInput;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.manage",
    });
    const manifest = this.registry.getManifest(input.connectorType);
    const isNone = manifest.auth?.kind === "none";
    const isCredential = manifest.auth?.kind === "credential";
    if ((isNone || isCredential) && input.oauthAccountId != null) {
      throw new ConnectorError(
        400,
        "CONNECTOR_OAUTH_ACCOUNT_NOT_ALLOWED",
        "This connector does not use an OAuth account",
      );
    }
    // A credential belongs only to a credential connector; a none or oauth2
    // request that carries one is a client error, not a field to ignore.
    if (!isCredential && input.credential != null) {
      throw new ConnectorError(
        400,
        "CONNECTOR_CREDENTIAL_NOT_ALLOWED",
        "This connector does not accept a username and secret",
      );
    }
    if (isCredential && !input.credential) {
      throw new ConnectorError(
        400,
        "CONNECTOR_CREDENTIAL_REQUIRED",
        "This connector requires a username and secret",
      );
    }
    const configJson = input.configJson ?? {};
    validateObjectWithJsonSchema({
      schema: manifest.configSchema,
      value: configJson,
      label: "configJson",
    });

    const existingConnector = await findSourceConnectorRecordByName({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorType: input.connectorType,
      name: input.name,
    });
    if (existingConnector) {
      if (existingConnector.status === "disabled") {
        throw new ConnectorError(
          409,
          "CONNECTOR_DISABLED_CONFLICT",
          "A disabled connector with this name already exists. Enable it or hard delete it before reconnecting.",
          { connectorId: existingConnector.id },
        );
      }
      throw new ConnectorError(
        409,
        "CONNECTOR_ALREADY_EXISTS",
        "A connector with this name already exists",
        { connectorId: existingConnector.id },
      );
    }

    if (isNone) {
      // A credential-free connector has no account to make two of them
      // distinct, so the configuration is its identity.
      // The platform's own readiness marker is not part of the identity.
      const identity = (config: Record<string, unknown>) =>
        comparableConfig(withoutSyncReadinessMetadata(config));
      const wanted = identity(configJson);
      const siblings = await listSourceConnectorRecords({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        includeDisabled: true,
      });
      const duplicate = siblings.find(
        (sibling) =>
          sibling.connectorType === input.connectorType &&
          identity(sibling.configJson) === wanted,
      );
      if (duplicate) {
        throw new ConnectorError(
          409,
          "CONNECTOR_ALREADY_EXISTS",
          "A connector with the same configuration already exists in this workspace",
          { connectorId: duplicate.id },
        );
      }
    }

    if (input.oauthAccountId) {
      const account = await findOAuthAccountRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        accountId: input.oauthAccountId,
      });
      if (!account || account.connectorType !== input.connectorType) {
        throw new ConnectorError(
          400,
          "CONNECTOR_OAUTH_ACCOUNT_INVALID",
          "OAuth account does not belong to this connector type",
        );
      }
      if (account.status !== "active") {
        throw new ConnectorError(
          400,
          "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE",
          "OAuth account is not active",
        );
      }
      const accountInUse = await hasSourceConnectorOAuthAccountReferences({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        accountId: input.oauthAccountId,
      });
      if (accountInUse) {
        throw new ConnectorError(
          409,
          "CONNECTOR_OAUTH_ACCOUNT_IN_USE",
          "OAuth account is already attached to another connector",
        );
      }
    }

    const frequency =
      input.indexingFrequencyMinutes ?? manifest.sync.defaultFrequencyMinutes;
    const periodicIndexingEnabled = input.periodicIndexingEnabled ?? false;
    if (periodicIndexingEnabled && manifest.sync.resources.length === 0) {
      throw new ConnectorError(
        400,
        "CONNECTOR_PERIODIC_SYNC_UNSUPPORTED",
        "This connector does not support periodic sync",
      );
    }
    if (
      periodicIndexingEnabled &&
      frequency < (manifest.sync.minFrequencyMinutes ?? 1)
    ) {
      throw new ConnectorError(
        400,
        "CONNECTOR_SYNC_FREQUENCY_TOO_FAST",
        `Minimum sync frequency is ${manifest.sync.minFrequencyMinutes} minutes`,
      );
    }
    if (isNone) {
      await this.requireConfigReady({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorType: input.connectorType,
        connectorId: "pending",
        connectorName: input.name,
        configJson,
      });
    }

    if (isCredential) {
      // input.credential is guaranteed present by the early check above.
      const credential = input.credential as ConnectorCredentialInput;
      assertCredentialUsername(credential);
      const adapter = this.registry.getAdapter(input.connectorType);
      if (!adapter.credentialIdentity) {
        throw new ConnectorError(
          500,
          "CONNECTOR_CREDENTIAL_IDENTITY_UNSUPPORTED",
          `${manifest.displayName} does not support credential authorization`,
          { connectorType: input.connectorType },
        );
      }
      const providerAccountId = adapter.credentialIdentity(
        configJson,
        credential,
      );
      const existing = await findOAuthAccountByProviderAccountInWorkspace({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorType: input.connectorType,
        providerAccountId,
      });
      if (existing) {
        throw new ConnectorError(
          409,
          "CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS",
          "A connector for this endpoint and user already exists in this workspace",
        );
      }
      // Verify the entered credential against the endpoint before writing the
      // account, so a wrong password or unreachable server fails fast rather
      // than creating a connector that is immediately reauth_required. Mirrors
      // the `none` kind's readiness gate, but runs with the supplied credential
      // and is NOT applied to rotate.
      await this.requireConfigReady({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorType: input.connectorType,
        connectorId: "pending",
        connectorName: input.name,
        configJson,
        accessToken: credentialAccessToken(credential),
      });
      const accessTokenEncrypted = await encryptTeamSecret(
        credentialAccessToken(credential),
        workspace.organizationId,
      );
      const { connector } = await createCredentialConnectorRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorType: input.connectorType,
        name: input.name,
        configJson,
        providerAccountId,
        displayName: credential.username,
        accessTokenEncrypted,
        periodicIndexingEnabled,
        indexingFrequencyMinutes: periodicIndexingEnabled ? frequency : null,
        createdBy: input.userId,
      });
      return {
        connector: await this.buildConnectorResponse(
          workspace.organizationId,
          workspace.id,
          connector,
        ),
      };
    }

    const connector = await createSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorType: input.connectorType,
      name: input.name,
      configJson,
      oauthAccountId: input.oauthAccountId ?? null,
      periodicIndexingEnabled,
      indexingFrequencyMinutes: periodicIndexingEnabled ? frequency : null,
      createdBy: input.userId,
    });

    return {
      connector: await this.buildConnectorResponse(
        workspace.organizationId,
        workspace.id,
        connector,
      ),
    };
  }

  /**
   * Re-read a connector (so the response carries every stored column), attach
   * its schedule status, and — for a `credential` connector only — its
   * credential status. The secret is never read. Falls back to the record it
   * was handed if the re-read finds nothing.
   */
  private async buildConnectorResponse(
    teamId: string,
    workspaceId: string,
    connector: SourceConnectorRecord,
  ) {
    const current =
      (await findSourceConnectorRecord({
        teamId,
        workspaceId,
        connectorId: connector.id,
      })) ?? connector;
    return this.withCredentialStatus(teamId, workspaceId, {
      ...current,
      scheduleStatus: await getConnectorScheduleStatus(connector.id),
    });
  }

  async listConnectors(input: {
    workspaceId: string;
    userId: string;
    includeDisabled?: boolean;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.read",
    });
    const items = await listSourceConnectorRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      includeDisabled: input.includeDisabled,
    });
    const schedules = await listConnectorScheduleStatuses({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });
    return {
      items: await Promise.all(
        items.map((connector) =>
          this.withCredentialStatus(workspace.organizationId, workspace.id, {
            ...connector,
            scheduleStatus: schedules.get(connector.id) ?? null,
          }),
        ),
      ),
    };
  }

  async updateConnector(input: {
    workspaceId: string;
    userId: string;
    connectorId: string;
    oauthAccountId?: string;
    name?: string;
    configJson?: Record<string, unknown>;
    status?: Extract<ConnectorStatus, "active" | "paused" | "disabled">;
    periodicIndexingEnabled?: boolean;
    indexingFrequencyMinutes?: number | null;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.manage",
    });
    const current = await findSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
    });
    if (!current) {
      throw new ConnectorError(
        404,
        "CONNECTOR_NOT_FOUND",
        "Connector not found",
      );
    }
    if (
      input.oauthAccountId &&
      input.oauthAccountId !== current.oauthAccountId
    ) {
      if (current.connectorType !== "gmail") {
        throw new ConnectorError(
          400,
          "CONNECTOR_OAUTH_REBIND_UNSUPPORTED",
          "Account rebinding is not supported for this connector",
        );
      }
      const nextAccount = await findOAuthAccountRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        accountId: input.oauthAccountId,
      });
      const currentAccount = current.oauthAccountId
        ? await findOAuthAccountRecord({
            teamId: workspace.organizationId,
            workspaceId: workspace.id,
            accountId: current.oauthAccountId,
          })
        : null;
      if (
        !nextAccount ||
        nextAccount.status !== "active" ||
        nextAccount.connectorType !== current.connectorType ||
        (currentAccount?.providerAccountId &&
          nextAccount.providerAccountId !== currentAccount.providerAccountId)
      ) {
        throw new ConnectorError(
          409,
          "CONNECTOR_OAUTH_ACCOUNT_MISMATCH",
          "Reconnect with the same provider account in this workspace",
        );
      }
    }

    const manifest = this.registry.getManifest(current.connectorType);
    const nextConfig = input.configJson ?? current.configJson;
    const gmailIndexTurnedOff =
      current.connectorType === "gmail" &&
      current.configJson.indexingEnabled === true &&
      nextConfig.indexingEnabled !== true;
    // Only validate when the caller actually supplies a config. A stricter
    // validator (maxItems, uniqueItems, pattern, per-item schemas) must not
    // block an unrelated update (rename, pause, disable, reschedule) of a
    // connector whose stored config predates that stricter enforcement.
    if (input.configJson !== undefined) {
      validateObjectWithJsonSchema({
        schema: manifest.configSchema,
        value: nextConfig,
        label: "configJson",
      });
    }
    // A credential connector's endpoint is bound to its stored secret: the
    // account identity and the Authorization target are fixed at create time.
    // A member with connector.manage who never knew the password must not be
    // able to point that credential at another origin by editing the config
    // (which would send `Authorization: Basic` to an attacker on the next sync
    // or browse). Same-origin path changes and `roots` edits stay allowed; a
    // different or unparsable endpoint origin is rejected with a fixed message
    // that echoes no input.
    if (
      input.configJson !== undefined &&
      manifest.auth?.kind === "credential"
    ) {
      const endpointOrigin = (value: unknown): string | null => {
        if (typeof value !== "string") return null;
        try {
          return new URL(value).origin;
        } catch {
          return null;
        }
      };
      const storedOrigin = endpointOrigin(current.configJson.endpoint);
      const nextOrigin = endpointOrigin(nextConfig.endpoint);
      if (
        storedOrigin === null ||
        nextOrigin === null ||
        storedOrigin !== nextOrigin
      ) {
        throw new ConnectorError(
          400,
          "CONNECTOR_CREDENTIAL_ENDPOINT_LOCKED",
          "This connector's server address cannot be changed",
        );
      }
    }

    const periodicIndexingEnabled =
      input.periodicIndexingEnabled ?? current.periodicIndexingEnabled;
    if (periodicIndexingEnabled && manifest.sync.resources.length === 0) {
      throw new ConnectorError(
        400,
        "CONNECTOR_PERIODIC_SYNC_UNSUPPORTED",
        "This connector does not support periodic sync",
      );
    }
    const frequency =
      input.indexingFrequencyMinutes === undefined
        ? (current.indexingFrequencyMinutes ??
          manifest.sync.defaultFrequencyMinutes)
        : (input.indexingFrequencyMinutes ??
          manifest.sync.defaultFrequencyMinutes);
    if (
      periodicIndexingEnabled &&
      (input.indexingFrequencyMinutes !== undefined ||
        (input.periodicIndexingEnabled === true &&
          !current.periodicIndexingEnabled)) &&
      frequency < (manifest.sync.minFrequencyMinutes ?? 1)
    ) {
      throw new ConnectorError(
        400,
        "CONNECTOR_SYNC_FREQUENCY_TOO_FAST",
        `Minimum sync frequency is ${manifest.sync.minFrequencyMinutes} minutes`,
      );
    }
    if (input.configJson !== undefined && manifest.auth?.kind === "none") {
      await this.requireConfigReady({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorType: current.connectorType,
        connectorId: current.id,
        connectorName: input.name ?? current.name,
        configJson: nextConfig,
      });
    }
    const connector = await updateSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
      oauthAccountId: input.oauthAccountId,
      name: input.name,
      configJson: input.configJson === undefined ? undefined : nextConfig,
      status: input.status,
      lastError: input.status === "active" ? null : undefined,
    });

    if (!connector) {
      throw new ConnectorError(
        404,
        "CONNECTOR_NOT_FOUND",
        "Connector not found",
      );
    }
    if (gmailIndexTurnedOff) {
      await archiveConnectorSources({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorId: connector.id,
      });
    }
    await putConnectorSchedule({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: connector.id,
      enabled: periodicIndexingEnabled && connector.status === "active",
      requestedPeriodicIndexingEnabled: periodicIndexingEnabled,
      intervalMinutes: frequency ?? manifest.sync.defaultFrequencyMinutes,
    });
    return {
      connector: await this.buildConnectorResponse(
        workspace.organizationId,
        workspace.id,
        connector,
      ),
    };
  }

  /**
   * Replace a `credential` connector's stored secret in place — the "reconnect"
   * path for credential connectors. Requires `connector.manage` (the same
   * permission as editing the connector) and the connector's own workspace. The
   * new `{ username, secret }` is encrypted and written to the connector's
   * existing account row, which returns to `active` with any prior
   * reauthorization requirement cleared. The secret is never returned, logged,
   * or copied into configJson.
   */
  async rotateConnectorCredential(input: {
    workspaceId: string;
    userId: string;
    connectorId: string;
    credential: ConnectorCredentialInput;
  }): Promise<ConnectorCredentialStatus> {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.manage",
    });
    const connector = await findSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
    });
    if (!connector) {
      throw new ConnectorError(
        404,
        "CONNECTOR_NOT_FOUND",
        "Connector not found",
      );
    }
    const manifest = this.registry.getManifest(connector.connectorType);
    if (manifest.auth?.kind !== "credential") {
      throw new ConnectorError(
        400,
        "CONNECTOR_CREDENTIAL_UNSUPPORTED",
        "This connector does not use a username and secret",
      );
    }
    if (!connector.oauthAccountId) {
      throw new ConnectorError(
        409,
        "CONNECTOR_CREDENTIAL_ACCOUNT_MISSING",
        "This connector has no stored credential to replace",
      );
    }
    assertCredentialUsername(input.credential);
    const adapter = this.registry.getAdapter(connector.connectorType);
    if (!adapter.credentialIdentity) {
      throw new ConnectorError(
        500,
        "CONNECTOR_CREDENTIAL_IDENTITY_UNSUPPORTED",
        `${manifest.displayName} does not support credential authorization`,
        { connectorType: connector.connectorType },
      );
    }
    const providerAccountId = adapter.credentialIdentity(
      connector.configJson,
      input.credential,
    );
    const accessTokenEncrypted = await encryptTeamSecret(
      credentialAccessToken(input.credential),
      workspace.organizationId,
    );
    const account = await updateOAuthAccountCredentialRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      accountId: connector.oauthAccountId,
      displayName: input.credential.username,
      providerAccountId,
      accessTokenEncrypted,
    });
    if (!account) {
      throw new ConnectorError(
        404,
        "CONNECTOR_OAUTH_ACCOUNT_NOT_FOUND",
        "Connector credential account not found",
      );
    }
    // The oauth2 reconnect path returns only the ACCOUNT to `active` with its
    // error cleared (reauthorizeOAuthAccountRecord); it does not re-enable a
    // schedule that a reauth failure disabled, and it leaves the connector row
    // to recover on its next sync. `updateOAuthAccountCredentialRecord` already
    // mirrors that account reset. A reauth failure also leaves the connector
    // itself in `error`, so — so the reconnected connector is not left showing
    // a stale error — clear that one error here (to `active`, lastError null).
    // Scheduling is deliberately NOT re-enabled, matching the oauth2 path.
    if (connector.status === "error") {
      await updateSourceConnectorRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorId: connector.id,
        status: "active",
        lastError: null,
      });
    }
    return {
      credentialConfigured: account.status === "active",
      displayName: account.displayName,
    };
  }

  async deleteConnector(input: {
    workspaceId: string;
    userId: string;
    connectorId: string;
    disable?: boolean;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.manage",
    });
    const current = await findSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
    });
    if (!current) {
      throw new ConnectorError(
        404,
        "CONNECTOR_NOT_FOUND",
        "Connector not found",
      );
    }

    if (input.disable) {
      const connector = await updateSourceConnectorRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorId: input.connectorId,
        status: "disabled",
        periodicIndexingEnabled: false,
        indexingFrequencyMinutes: null,
        nextScheduledAt: null,
        lastError: null,
      });
      if (!connector) {
        throw new ConnectorError(
          404,
          "CONNECTOR_NOT_FOUND",
          "Connector not found",
        );
      }
      await putConnectorSchedule({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorId: input.connectorId,
        enabled: false,
        requestedPeriodicIndexingEnabled: false,
        intervalMinutes:
          current.indexingFrequencyMinutes ??
          this.registry.getManifest(current.connectorType).sync
            .defaultFrequencyMinutes,
      });
      return {
        disabled: true,
        hardDeleted: false,
        connectorId: input.connectorId,
      };
    }

    if (current.oauthAccountId) {
      const hasOtherReferences =
        await hasOtherSourceConnectorOAuthAccountReferences({
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          accountId: current.oauthAccountId,
          connectorId: input.connectorId,
        });
      if (hasOtherReferences) {
        throw new ConnectorError(
          409,
          "CONNECTOR_OAUTH_ACCOUNT_IN_USE",
          "Connector OAuth account is attached to another connector",
        );
      }

      // Revoke at the provider before any local row is removed: a failure
      // here must leave the connector, its sources and the account intact.
      const account = await findOAuthAccountRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        accountId: current.oauthAccountId,
      });
      if (account) {
        await this.oauthService.revokeStoredAuthorization(account);
      }
    }

    const result = await hardDeleteSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
      oauthAccountId: current.oauthAccountId,
    });
    if (!result.connectorDeleted) {
      throw new ConnectorError(
        404,
        "CONNECTOR_NOT_FOUND",
        "Connector not found",
      );
    }
    return {
      disabled: false,
      hardDeleted: true,
      connectorId: input.connectorId,
      indexedContentDeleted: true,
      sourcesDeleted: result.sourcesDeleted,
      documentsDeleted: result.documentsDeleted,
      authorizationDeleted: result.authorizationDeleted,
    };
  }

  async deleteOAuthAccount(input: {
    workspaceId: string;
    userId: string;
    accountId: string;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.manage",
    });
    const account = await findOAuthAccountRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      accountId: input.accountId,
    });
    if (!account) {
      throw new ConnectorError(
        404,
        "CONNECTOR_OAUTH_ACCOUNT_NOT_FOUND",
        "Connector OAuth account not found",
      );
    }

    const referencingConnectors =
      await listWorkspaceSourceConnectorRecordsByOAuthAccount({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        oauthAccountId: input.accountId,
      });
    if (referencingConnectors.length > 0) {
      throw new ConnectorError(
        409,
        "CONNECTOR_OAUTH_ACCOUNT_IN_USE",
        "Connector OAuth account is still attached to a connector",
        {
          connectorIds: referencingConnectors.map((connector) => connector.id),
        },
      );
    }

    // Revoke at the provider before the row is removed: abort on failure.
    await this.oauthService.revokeStoredAuthorization(account);

    const deleted = await deleteOAuthAccountRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      accountId: input.accountId,
    });
    if (!deleted) {
      throw new ConnectorError(
        404,
        "CONNECTOR_OAUTH_ACCOUNT_NOT_FOUND",
        "Connector OAuth account not found",
      );
    }

    return {
      deleted: true,
      accountId: input.accountId,
    };
  }
}
