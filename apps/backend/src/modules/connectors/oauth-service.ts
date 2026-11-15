import { ConnectorAccessPolicy } from "./access-policy";
import { createHash, randomBytes } from "node:crypto";
import { config } from "../../shared/config";
import {
  decryptTeamSecret,
  encryptTeamSecret,
} from "../../shared/team-secrets";
import { ConnectorError, toConnectorError } from "./errors";
import { isRetryableOAuthRefreshError } from "./oauth-refresh-error";
import { requireConnectorWorkspace } from "./permissions";
import {
  consumeOAuthStateRecord,
  createOAuthAccountRecord,
  createOAuthStateRecord,
  findOAuthAccountRecord,
  findOAuthStateRecord,
  findReauthorizableOAuthAccountRecord,
  reauthorizeOAuthAccountRecord,
  withOAuthAccountRefreshLock,
  type OAuthAccountRefreshWrite,
} from "./repository";
import { ConnectorRegistry, connectorRegistry } from "./registry";
import type {
  ConnectorAdapter,
  ConnectorManifest,
  ConnectorOAuthAccountSecretRecord,
  OAuthTokenSet,
} from "./types";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const REFRESH_LOCK_TIMEOUT_MS = 30_000;
const REFRESH_PROVIDER_TIMEOUT_MS = 20_000;

type OAuthAccountRef = {
  id: string;
  teamId: string;
  workspaceId: string;
  connectorType: string;
};

type RefreshDecision =
  | { ok: true; accessToken: string; refreshed: boolean }
  | { ok: false; error: ConnectorError };

function reauthRequiredError() {
  return new ConnectorError(
    409,
    "CONNECTOR_REAUTH_REQUIRED",
    "Connector account must be reauthorized",
  );
}

function hashState(state: string) {
  return createHash("sha256").update(state).digest("hex");
}

function buildCallbackUrl(input: {
  workspaceId: string;
  connectorType: string;
}) {
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

function assertAuthorizationParamsConfigured(input: {
  connectorType: string;
  manifest: {
    auth: { authorizationParams?: Record<string, string> };
    displayName: string;
  };
}) {
  for (const [key, value] of Object.entries(
    input.manifest.auth.authorizationParams ?? {},
  )) {
    if (!value.trim()) {
      throw new ConnectorError(
        500,
        "CONNECTOR_OAUTH_CONFIG_MISSING",
        `${input.manifest.displayName} OAuth is not configured: ${key} is missing`,
        { connectorType: input.connectorType, parameter: key },
      );
    }
  }
}

export class ConnectorOAuthService {
  constructor(
    private readonly registry: ConnectorRegistry = connectorRegistry,
    private readonly access = new ConnectorAccessPolicy(undefined, registry),
  ) {}

  /**
   * One in-flight refresh per account at a time: a later task's keep-alive
   * sweep and concurrent `getRuntimeToken` callers for the same account share
   * the same provider call and lock wait instead of racing the provider's
   * single-use refresh token against each other. An entry is removed as soon
   * as its promise settles, success or failure, so the next call tries again
   * rather than reusing a rejected result.
   */
  private readonly refreshInFlight = new Map<
    string,
    Promise<{ accessToken: string; refreshed: boolean }>
  >();

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
    await this.access.requireAvailable(input.connectorType, input.userId);
    const manifest = this.registry.getManifest(input.connectorType);
    assertAuthorizationParamsConfigured({
      connectorType: input.connectorType,
      manifest,
    });
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
      authorizationUrl.searchParams.set(
        "scope",
        manifest.auth.scopes.join(" "),
      );
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

    await requireConnectorWorkspace({
      workspaceId: stateRow.workspaceId,
      userId: stateRow.userId,
      permission: "connector.manage",
    });
    await this.access.requireAvailable(input.connectorType, stateRow.userId);
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
    const account = await this.storeAuthorization({
      teamId: stateRow.teamId,
      workspaceId: stateRow.workspaceId,
      userId: stateRow.userId,
      connectorType: input.connectorType,
      manifest,
      tokenSet,
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

    await requireConnectorWorkspace({
      workspaceId: stateRow.workspaceId,
      userId: stateRow.userId,
      permission: "connector.manage",
    });
    await this.access.requireAvailable(input.connectorType, stateRow.userId);
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
    const account = await this.storeAuthorization({
      teamId: stateRow.teamId,
      workspaceId: stateRow.workspaceId,
      userId: stateRow.userId,
      connectorType: input.connectorType,
      manifest,
      tokenSet,
    });

    return {
      account,
      redirectAfter: stateRow.redirectAfter,
    };
  }

  /**
   * Persist a completed authorization. When the provider account already has
   * a stored authorization in this workspace, its tokens are replaced in place
   * so the connector that runs against it keeps working; authorizing again is
   * how a connector whose grant was revoked or expired is reconnected.
   */
  private async storeAuthorization(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    connectorType: string;
    manifest: ConnectorManifest;
    tokenSet: OAuthTokenSet;
  }) {
    const { tokenSet } = input;
    const scopes = normalizeScopes(tokenSet, input.manifest.auth.scopes);
    const displayName =
      tokenSet.displayName ??
      tokenSet.providerAccountEmail ??
      `${input.manifest.displayName} account`;
    const accessTokenEncrypted = await encryptTeamSecret(
      tokenSet.accessToken,
      input.teamId,
    );
    const refreshTokenEncrypted = tokenSet.refreshToken
      ? await encryptTeamSecret(tokenSet.refreshToken, input.teamId)
      : null;
    const expiresAt = tokenSet.expiresAt ?? null;

    const stored = tokenSet.providerAccountId
      ? await findReauthorizableOAuthAccountRecord({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          connectorType: input.connectorType,
          providerAccountId: tokenSet.providerAccountId,
        })
      : null;
    if (stored) {
      const reauthorized = await reauthorizeOAuthAccountRecord({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        accountId: stored.id,
        providerAccountEmail: tokenSet.providerAccountEmail ?? null,
        displayName,
        scopes,
        accessTokenEncrypted,
        refreshTokenEncrypted: refreshTokenEncrypted ?? undefined,
        expiresAt,
      });
      if (reauthorized) {
        return reauthorized;
      }
    }

    return createOAuthAccountRecord({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorType: input.connectorType,
      providerAccountId: tokenSet.providerAccountId ?? null,
      providerAccountEmail: tokenSet.providerAccountEmail ?? null,
      displayName,
      scopes,
      accessTokenEncrypted,
      refreshTokenEncrypted,
      expiresAt,
      createdBy: input.userId,
    });
  }

  async getGlobalCallbackState(input: {
    connectorType: string;
    state: string;
  }) {
    const stateRow = await findOAuthStateRecord({
      stateHash: hashState(input.state),
      connectorType: input.connectorType,
      now: new Date(),
    });
    if (!stateRow) {
      return null;
    }

    return {
      connectorType: stateRow.connectorType,
      redirectAfter: stateRow.redirectAfter,
      workspaceId: stateRow.workspaceId,
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
    if (
      !expiresAt ||
      expiresAt.getTime() > Date.now() + TOKEN_REFRESH_SKEW_MS
    ) {
      return decryptTeamSecret(account.accessTokenEncrypted, account.teamId);
    }

    const { accessToken } = await this.refreshAccountToken(
      account,
      (locked) =>
        !locked.expiresAt ||
        new Date(locked.expiresAt).getTime() >
          Date.now() + TOKEN_REFRESH_SKEW_MS,
    );
    return accessToken;
  }

  /**
   * Refresh an OAuth account's access token, one caller at a time per
   * account. `isFresh` is evaluated on the row read under the lock, not on
   * `account`: another caller, the keep-alive sweep, or an administrator may
   * have changed it while this call waited.
   */
  private async refreshAccountToken(
    account: OAuthAccountRef,
    isFresh: (locked: ConnectorOAuthAccountSecretRecord) => boolean,
  ): Promise<{ accessToken: string; refreshed: boolean }> {
    // R2: resolve the adapter before touching the lock or the single-flight
    // map, and outside the retryable/non-retryable classification below, so
    // an unregistered adapter never marks the account.
    const adapter = this.registry.getAdapter(account.connectorType);

    const inFlight = this.refreshInFlight.get(account.id);
    if (inFlight) {
      return inFlight;
    }

    const task = this.lockAndRefresh(account, adapter, isFresh);
    this.refreshInFlight.set(account.id, task);
    task
      .finally(() => {
        this.refreshInFlight.delete(account.id);
      })
      .catch(() => {
        // Cleanup only; callers holding `task` itself still observe the
        // rejection, so this chained promise must not become unhandled.
      });
    return task;
  }

  private async lockAndRefresh(
    account: OAuthAccountRef,
    adapter: ConnectorAdapter,
    isFresh: (locked: ConnectorOAuthAccountSecretRecord) => boolean,
  ): Promise<{ accessToken: string; refreshed: boolean }> {
    const outcome = await withOAuthAccountRefreshLock<RefreshDecision>(
      {
        teamId: account.teamId,
        workspaceId: account.workspaceId,
        accountId: account.id,
        lockTimeoutMs: REFRESH_LOCK_TIMEOUT_MS,
      },
      (locked) => this.decideRefresh(locked, adapter, isFresh),
    );

    if (!outcome.ok) {
      throw outcome.error;
    }
    return { accessToken: outcome.accessToken, refreshed: outcome.refreshed };
  }

  private async decideRefresh(
    locked: ConnectorOAuthAccountSecretRecord | null,
    adapter: ConnectorAdapter,
    isFresh: (locked: ConnectorOAuthAccountSecretRecord) => boolean,
  ): Promise<{ write: OAuthAccountRefreshWrite; result: RefreshDecision }> {
    if (!locked) {
      throw new ConnectorError(
        404,
        "CONNECTOR_OAUTH_ACCOUNT_NOT_FOUND",
        "Connector OAuth account not found",
      );
    }
    if (locked.status !== "active") {
      throw new ConnectorError(
        409,
        "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE",
        "Connector OAuth account is not active",
      );
    }
    if (isFresh(locked)) {
      return {
        write: { kind: "none" },
        result: {
          ok: true,
          accessToken: await decryptTeamSecret(
            locked.accessTokenEncrypted,
            locked.teamId,
          ),
          refreshed: false,
        },
      };
    }

    const refreshToken = await this.decryptRefreshToken(locked);
    if (!refreshToken) {
      return {
        write: {
          kind: "status",
          status: "reauth_required",
          lastError: "Refresh token is unavailable",
        },
        result: { ok: false, error: reauthRequiredError() },
      };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const providerCall = adapter.refreshOAuthToken({
      refreshToken,
      scopes: locked.scopes,
    });
    try {
      const tokenSet = await Promise.race<OAuthTokenSet>([
        providerCall,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new ConnectorError(
                503,
                "CONNECTOR_OAUTH_REFRESH_TIMEOUT",
                "Connector token refresh timed out",
              ),
            );
          }, REFRESH_PROVIDER_TIMEOUT_MS);
        }),
      ]);

      return {
        write: {
          kind: "token",
          accessTokenEncrypted: await encryptTeamSecret(
            tokenSet.accessToken,
            locked.teamId,
          ),
          refreshTokenEncrypted:
            tokenSet.refreshToken === undefined
              ? undefined
              : tokenSet.refreshToken
                ? await encryptTeamSecret(tokenSet.refreshToken, locked.teamId)
                : null,
          expiresAt: tokenSet.expiresAt ?? null,
          scopes: normalizeScopes(tokenSet, locked.scopes),
        },
        result: {
          ok: true,
          accessToken: tokenSet.accessToken,
          refreshed: true,
        },
      };
    } catch (error) {
      if (isRetryableOAuthRefreshError(error)) {
        // Nothing written: a transport failure or a timeout (itself a 503
        // ConnectorError, which this classifier also treats as retryable)
        // should not be mistaken for a reauthorization failure.
        throw toConnectorError(error);
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        write: {
          kind: "status",
          status: "reauth_required",
          lastError: message,
        },
        result: { ok: false, error: reauthRequiredError() },
      };
    } finally {
      if (timer) clearTimeout(timer);
      // The loser of the race (almost always the provider call, when the
      // timeout wins) may still settle later; swallow that so it never
      // surfaces as an unhandled rejection.
      providerCall.catch(() => {});
    }
  }

  private async decryptRefreshToken(
    locked: ConnectorOAuthAccountSecretRecord,
  ): Promise<string | null> {
    try {
      return await decryptTeamSecret(
        locked.refreshTokenEncrypted,
        locked.teamId,
      );
    } catch {
      return null;
    }
  }
}
