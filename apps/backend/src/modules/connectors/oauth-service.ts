import { createHash, randomBytes } from "node:crypto";
import { config } from "../../shared/config";
import { decryptSecret, encryptSecret } from "../../shared/secrets";
import { ConnectorError } from "./errors";
import { requireConnectorWorkspace } from "./permissions";
import {
  consumeOAuthStateRecord,
  createOAuthAccountRecord,
  createOAuthStateRecord,
  findOAuthAccountRecord,
  updateOAuthAccountStatusRecord,
  updateOAuthAccountTokenRecord,
} from "./repository";
import { ConnectorRegistry, connectorRegistry } from "./registry";
import type { ConnectorOAuthAccountSecretRecord, OAuthTokenSet } from "./types";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;

function hashState(state: string) {
  return createHash("sha256").update(state).digest("hex");
}

function resolveOAuthEncryptionSecret() {
  return config.modelGatewayEncryptionSecret;
}

function buildCallbackUrl(input: { workspaceId: string; connectorType: string }) {
  return `${config.auth.baseUrl}/v1/workspaces/${input.workspaceId}/connectors/oauth/${input.connectorType}/callback`;
}

function resolveCallbackUrl(input: {
  manifest: { auth: { redirectUri?: string } };
  workspaceId: string;
  connectorType: string;
}) {
  return (
    input.manifest.auth.redirectUri ||
    buildCallbackUrl({
      workspaceId: input.workspaceId,
      connectorType: input.connectorType,
    })
  );
}

function normalizeScopes(tokenSet: OAuthTokenSet, fallback: string[]) {
  const scopes = tokenSet.scopes?.length ? tokenSet.scopes : fallback;
  return Array.from(new Set(scopes));
}

export class ConnectorOAuthService {
  constructor(private readonly registry: ConnectorRegistry = connectorRegistry) {}

  async start(input: {
    workspaceId: string;
    userId: string;
    connectorType: string;
    redirectAfter?: string | null;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.manage",
    });
    const manifest = this.registry.getManifest(input.connectorType);
    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);

    await createOAuthStateRecord({
      stateHash: hashState(state),
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      connectorType: input.connectorType,
      redirectAfter: input.redirectAfter ?? null,
      expiresAt,
    });

    const authorizationUrl = new URL(manifest.auth.authorizationUrl);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set(
      "redirect_uri",
      resolveCallbackUrl({
        manifest,
        workspaceId: input.workspaceId,
        connectorType: input.connectorType,
      }),
    );
    authorizationUrl.searchParams.set("state", state);
    for (const [key, value] of Object.entries(
      manifest.auth.authorizationParams ?? {},
    )) {
      authorizationUrl.searchParams.set(key, value);
    }
    if (manifest.auth.sendScope !== false && manifest.auth.scopes.length > 0) {
      authorizationUrl.searchParams.set("scope", manifest.auth.scopes.join(" "));
    }

    return {
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async finish(input: {
    workspaceId: string;
    connectorType: string;
    code: string;
    state: string;
  }) {
    const stateRow = await consumeOAuthStateRecord({
      stateHash: hashState(input.state),
      connectorType: input.connectorType,
      now: new Date(),
    });
    if (!stateRow || stateRow.workspaceId !== input.workspaceId) {
      throw new ConnectorError(
        400,
        "CONNECTOR_OAUTH_STATE_INVALID",
        "Connector OAuth state is invalid or expired",
      );
    }

    const adapter = this.registry.getAdapter(input.connectorType);
    const manifest = adapter.getManifest();
    const tokenSet = await adapter.exchangeOAuthCode({
      code: input.code,
      redirectUri: resolveCallbackUrl({
        manifest,
        workspaceId: input.workspaceId,
        connectorType: input.connectorType,
      }),
      scopes: manifest.auth.scopes,
    });
    const scopes = normalizeScopes(tokenSet, manifest.auth.scopes);
    const secret = resolveOAuthEncryptionSecret();
    const account = await createOAuthAccountRecord({
      teamId: stateRow.teamId,
      workspaceId: stateRow.workspaceId,
      connectorType: input.connectorType,
      providerAccountId: tokenSet.providerAccountId ?? null,
      providerAccountEmail: tokenSet.providerAccountEmail ?? null,
      displayName:
        tokenSet.displayName ??
        tokenSet.providerAccountEmail ??
        `${manifest.displayName} account`,
      scopes,
      accessTokenEncrypted: encryptSecret(tokenSet.accessToken, secret),
      refreshTokenEncrypted: tokenSet.refreshToken
        ? encryptSecret(tokenSet.refreshToken, secret)
        : null,
      expiresAt: tokenSet.expiresAt ?? null,
      createdBy: stateRow.userId,
    });

    return {
      account,
      redirectAfter: stateRow.redirectAfter,
    };
  }

  async finishGlobalCallback(input: {
    connectorType: string;
    code: string;
    state: string;
  }) {
    const stateRow = await consumeOAuthStateRecord({
      stateHash: hashState(input.state),
      connectorType: input.connectorType,
      now: new Date(),
    });
    if (!stateRow) {
      throw new ConnectorError(
        400,
        "CONNECTOR_OAUTH_STATE_INVALID",
        "Connector OAuth state is invalid or expired",
      );
    }

    const adapter = this.registry.getAdapter(input.connectorType);
    const manifest = adapter.getManifest();
    const tokenSet = await adapter.exchangeOAuthCode({
      code: input.code,
      redirectUri: resolveCallbackUrl({
        manifest,
        workspaceId: stateRow.workspaceId,
        connectorType: input.connectorType,
      }),
      scopes: manifest.auth.scopes,
    });
    const scopes = normalizeScopes(tokenSet, manifest.auth.scopes);
    const secret = resolveOAuthEncryptionSecret();
    const account = await createOAuthAccountRecord({
      teamId: stateRow.teamId,
      workspaceId: stateRow.workspaceId,
      connectorType: input.connectorType,
      providerAccountId: tokenSet.providerAccountId ?? null,
      providerAccountEmail: tokenSet.providerAccountEmail ?? null,
      displayName:
        tokenSet.displayName ??
        tokenSet.providerAccountEmail ??
        `${manifest.displayName} account`,
      scopes,
      accessTokenEncrypted: encryptSecret(tokenSet.accessToken, secret),
      refreshTokenEncrypted: tokenSet.refreshToken
        ? encryptSecret(tokenSet.refreshToken, secret)
        : null,
      expiresAt: tokenSet.expiresAt ?? null,
      createdBy: stateRow.userId,
    });

    return {
      account,
      redirectAfter: stateRow.redirectAfter,
    };
  }

  async getRuntimeToken(input: {
    teamId: string;
    workspaceId: string;
    accountId: string | null;
    connectorType: string;
  }) {
    if (!input.accountId) {
      throw new ConnectorError(
        400,
        "CONNECTOR_OAUTH_ACCOUNT_REQUIRED",
        "Connector OAuth account is required",
      );
    }

    const account = await findOAuthAccountRecord({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      accountId: input.accountId,
    });
    if (!account || account.connectorType !== input.connectorType) {
      throw new ConnectorError(
        404,
        "CONNECTOR_OAUTH_ACCOUNT_NOT_FOUND",
        "Connector OAuth account not found",
      );
    }
    if (account.status !== "active") {
      throw new ConnectorError(
        409,
        "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE",
        "Connector OAuth account is not active",
      );
    }

    const expiresAt = account.expiresAt ? new Date(account.expiresAt) : null;
    if (!expiresAt || expiresAt.getTime() > Date.now() + TOKEN_REFRESH_SKEW_MS) {
      return decryptSecret(
        account.accessTokenEncrypted,
        resolveOAuthEncryptionSecret(),
      );
    }

    return this.refreshAccountToken(account);
  }

  private async refreshAccountToken(account: ConnectorOAuthAccountSecretRecord) {
    const secret = resolveOAuthEncryptionSecret();
    const refreshToken = decryptSecret(account.refreshTokenEncrypted, secret);
    if (!refreshToken) {
      await updateOAuthAccountStatusRecord({
        teamId: account.teamId,
        workspaceId: account.workspaceId,
        accountId: account.id,
        status: "reauth_required",
        lastError: "Refresh token is unavailable",
      });
      throw new ConnectorError(
        409,
        "CONNECTOR_REAUTH_REQUIRED",
        "Connector account must be reauthorized",
      );
    }

    try {
      const adapter = this.registry.getAdapter(account.connectorType);
      const tokenSet = await adapter.refreshOAuthToken({
        refreshToken,
        scopes: account.scopes,
      });
      await updateOAuthAccountTokenRecord({
        teamId: account.teamId,
        workspaceId: account.workspaceId,
        accountId: account.id,
        accessTokenEncrypted: encryptSecret(tokenSet.accessToken, secret),
        refreshTokenEncrypted:
          tokenSet.refreshToken === undefined
            ? undefined
            : tokenSet.refreshToken
              ? encryptSecret(tokenSet.refreshToken, secret)
              : null,
        expiresAt: tokenSet.expiresAt ?? null,
        scopes: normalizeScopes(tokenSet, account.scopes),
      });
      return tokenSet.accessToken;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateOAuthAccountStatusRecord({
        teamId: account.teamId,
        workspaceId: account.workspaceId,
        accountId: account.id,
        status: "reauth_required",
        lastError: message,
      });
      throw new ConnectorError(
        409,
        "CONNECTOR_REAUTH_REQUIRED",
        "Connector account must be reauthorized",
      );
    }
  }
}
