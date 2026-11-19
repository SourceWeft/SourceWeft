import { ConnectorAccessPolicy } from "./access-policy";
import { createHash, randomBytes } from "node:crypto";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import {
  decryptTeamSecret,
  encryptTeamSecret,
  getTeamSecretCipher,
  type TeamSecretCipher,
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
  listOAuthAccountsDueForKeepAlive,
  markOAuthAccountReauthRequiredRecord,
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

/**
 * Narrow a connector manifest to its `oauth2` auth variant, for the standard
 * OAuth2 flow this service implements. `start` and `finishGlobalCallback`
 * branch on the adapter's brokered hooks before this guard runs, so it is
 * only reached for a genuine OAuth2 manifest there; `finish` (the
 * workspace-scoped callback) stays OAuth2-only and keeps calling this
 * unconditionally, so a brokered manifest reaching it is rejected.
 */
function assertOAuth2Manifest(
  manifest: ConnectorManifest,
): asserts manifest is ConnectorManifest & {
  auth: Extract<ConnectorManifest["auth"], { kind: "oauth2" }>;
} {
  if (manifest.auth.kind !== "oauth2") {
    throw new ConnectorError(
      500,
      "CONNECTOR_AUTH_KIND_UNSUPPORTED",
      `${manifest.displayName} does not use the standard OAuth2 authorization flow`,
      { connectorType: manifest.type, authKind: manifest.auth.kind },
    );
  }
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const REFRESH_LOCK_TIMEOUT_MS = 30_000;
const REFRESH_PROVIDER_TIMEOUT_MS = 20_000;
// A refresh token a provider never sees used for a while can silently expire,
// quietly killing a connection nobody is actively touching. The keep-alive
// sweep (`refreshIdleAccounts`) refreshes accounts idle longer than this.
const KEEP_ALIVE_MIN_AGE_MS = 7 * 24 * 60 * 60_000;
const KEEP_ALIVE_BATCH_LIMIT = 50;

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
   * One in-flight `getRuntimeToken` refresh per account at a time: concurrent
   * runtime callers for the same account share one provider call and lock wait
   * instead of racing the provider's single-use refresh token against each
   * other. Only `getRuntimeToken` joins this map; the keep-alive sweep takes
   * its own lock (the row lock already serializes it against everyone) so it is
   * never handed a token decided by the runtime caller's freshness predicate.
   * An entry is removed as soon as its promise settles, success or failure, so
   * the next call tries again rather than reusing a rejected result.
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
    const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);

    if (manifest.auth.kind === "brokered") {
      const adapter = this.registry.getAdapter(input.connectorType);
      const state = randomBytes(32).toString("base64url");
      const callbackUrl = `${config.auth.baseUrl}/v1/connectors/oauth/${input.connectorType}/callback?state=${state}`;
      let started;
      try {
        started = await adapter.startAuthorization?.({
          callbackUrl,
          ownerRef: `ws_${workspace.id}`,
        });
      } catch (error) {
        throw toConnectorError(error);
      }
      if (!started) {
        throw new ConnectorError(
          500,
          "CONNECTOR_AUTH_KIND_UNSUPPORTED",
          `${manifest.displayName} is configured for brokered authorization but its adapter does not implement startAuthorization`,
          { connectorType: input.connectorType },
        );
      }

      await createOAuthStateRecord({
        stateHash: hashState(state),
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        userId: input.userId,
        connectorType: input.connectorType,
        redirectAfter: input.redirectAfter ?? null,
        expiresAt,
        attemptRef: started.attemptRef,
      });

      return {
        authorizationUrl: started.authorizationUrl,
        expiresAt: expiresAt.toISOString(),
      };
    }

    assertOAuth2Manifest(manifest);
    assertAuthorizationParamsConfigured({
      connectorType: input.connectorType,
      manifest,
    });
    const state = randomBytes(32).toString("base64url");

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
    // A brokered connector completes authorization through the global callback
    // (`finishGlobalCallback`), never this workspace-scoped code-exchange path.
    // Reject it before the state row is consumed, so a stray hit here does not
    // burn the single-use handshake, and with a client 400 rather than a 500.
    if (this.usesBrokeredAuthorization(input.connectorType)) {
      throw new ConnectorError(
        400,
        "CONNECTOR_OAUTH_CALLBACK_INVALID",
        "This connector completes authorization through its broker, not the workspace callback",
        { connectorType: input.connectorType },
      );
    }
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
    assertOAuth2Manifest(manifest);
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
    state: string;
    code?: string;
    callbackParams?: Record<string, string>;
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

    let tokenSet: OAuthTokenSet;
    if (adapter.finishAuthorization) {
      if (!stateRow.attemptRef) {
        throw new ConnectorError(
          400,
          "CONNECTOR_OAUTH_STATE_INVALID",
          "Connector OAuth state is invalid or expired",
        );
      }
      try {
        tokenSet = await adapter.finishAuthorization({
          callbackParams: input.callbackParams ?? {},
          attemptRef: stateRow.attemptRef,
          ownerRef: `ws_${stateRow.workspaceId}`,
        });
      } catch (error) {
        throw toConnectorError(error);
      }
    } else {
      assertOAuth2Manifest(manifest);
      if (!input.code) {
        throw new ConnectorError(
          400,
          "CONNECTOR_OAUTH_CALLBACK_INVALID",
          "OAuth callback code is required",
        );
      }
      tokenSet = await adapter.exchangeOAuthCode({
        code: input.code,
        redirectUri: resolveCallbackUrl({
          manifest,
          workspaceId: stateRow.workspaceId,
          connectorType: input.connectorType,
        }),
        scopes: manifest.auth.scopes,
      });
    }

    let account;
    try {
      account = await this.storeAuthorization({
        teamId: stateRow.teamId,
        workspaceId: stateRow.workspaceId,
        userId: stateRow.userId,
        connectorType: input.connectorType,
        manifest,
        tokenSet,
      });
    } catch (error) {
      // A brokered `finishAuthorization` has already created a live connection
      // at the broker. If persisting it fails, the state row is spent and the
      // user must start again, so revoke that connection best-effort rather
      // than leave a grant SourceWeft can no longer see. No account row exists
      // yet, so only the connector type is logged on failure.
      if (adapter.finishAuthorization && adapter.revokeAuthorization) {
        try {
          await adapter.revokeAuthorization({
            accessToken: tokenSet.accessToken,
          });
        } catch {
          logger.error("connector_authorization_revoke_failed", {
            connectorType: input.connectorType,
          });
        }
      }
      throw error;
    }

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
      // Captured before the overwrite below, and only when the adapter can
      // revoke it: brokered adapters with `revokeAuthorization` must revoke
      // the credential being replaced, after the new one is safely stored.
      const adapter = this.registry.getAdapter(input.connectorType);
      const replaced = adapter.revokeAuthorization
        ? await findOAuthAccountRecord({
            teamId: input.teamId,
            workspaceId: input.workspaceId,
            accountId: stored.id,
          })
        : null;
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
        if (replaced) {
          // When the broker re-links the same mailbox under the same
          // connected-account id, the "replaced" credential is byte-for-byte
          // the one just stored; revoking it would delete the connection we
          // just kept. Only revoke a credential that genuinely differs.
          const replacedAccessToken = await decryptTeamSecret(
            replaced.accessTokenEncrypted,
            replaced.teamId,
          );
          if (replacedAccessToken !== tokenSet.accessToken) {
            await this.revokeReplacedAuthorization(replaced);
          }
        }
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

  /**
   * Record that the provider refused a brokered authorization during a live
   * call. A brokered account never refreshes (the broker holds and renews the
   * token), so the refresh path that normally marks an account never runs for
   * it; a revoked or deactivated connection would otherwise keep showing as
   * connected. Only an adapter's `*_REAUTH_REQUIRED` answer on a brokered
   * connector marks the account, which then shows Reconnect and refuses
   * further calls until the mailbox is authorized again. Any other failure
   * (broker unavailable, quota, a transient error) leaves the account alone.
   * Never throws: the caller is already reporting the original error.
   */
  async markBrokeredAccountReauthRequired(input: {
    teamId: string;
    workspaceId: string;
    accountId: string | null;
    connectorType: string;
    error: unknown;
  }): Promise<void> {
    if (!input.accountId) return;
    try {
      if (!toConnectorError(input.error).code.endsWith("_REAUTH_REQUIRED")) {
        return;
      }
      if (!this.usesBrokeredAuthorization(input.connectorType)) return;
      const marked = await markOAuthAccountReauthRequiredRecord({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        lastError: "The authorization is no longer active at the provider",
      });
      if (marked) {
        logger.warn("connector_brokered_account_reauth_required", {
          accountId: input.accountId,
          connectorType: input.connectorType,
        });
      }
    } catch (error) {
      logger.error("connector_brokered_account_mark_failed", {
        accountId: input.accountId,
        connectorType: input.connectorType,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Whether a connector's manifest declares the brokered auth flow. */
  usesBrokeredAuthorization(connectorType: string): boolean {
    return this.registry.getManifest(connectorType).auth?.kind === "brokered";
  }

  /**
   * Revoke a stored authorization at the provider. A no-op when the adapter
   * has no `revokeAuthorization` hook (every standard OAuth2 adapter today).
   * The credential is decrypted only for this call and never logged.
   */
  async revokeStoredAuthorization(
    account: ConnectorOAuthAccountSecretRecord,
  ): Promise<void> {
    let adapter: ConnectorAdapter;
    try {
      adapter = this.registry.getAdapter(account.connectorType);
    } catch (error) {
      // The connector type is switched off at deployment level
      // (e.g. GMAIL_CONNECTOR_ENABLED=false): there is no adapter in this
      // process to revoke through, and a switched-off connector cannot make
      // new connections either, so this is "nothing this process can revoke".
      // Let the local delete proceed, as it did before brokered revocation.
      if (
        error instanceof ConnectorError &&
        error.code === "CONNECTOR_ADAPTER_NOT_FOUND"
      ) {
        logger.error("connector_authorization_revoke_skipped", {
          accountId: account.id,
          connectorType: account.connectorType,
        });
        return;
      }
      throw error;
    }
    if (!adapter.revokeAuthorization) {
      return;
    }
    const accessToken = await decryptTeamSecret(
      account.accessTokenEncrypted,
      account.teamId,
    );
    try {
      await adapter.revokeAuthorization({ accessToken });
    } catch (error) {
      // Record the cause (the classified error code, never its message or any
      // credential) so an operator can see why a provider revoke failed before
      // the caller sees the generic retryable error.
      logger.error("connector_authorization_revoke_failed", {
        accountId: account.id,
        connectorType: account.connectorType,
        code: toConnectorError(error).code,
      });
      throw new ConnectorError(
        502,
        "CONNECTOR_AUTHORIZATION_REVOKE_FAILED",
        "The connection could not be removed at the provider. Try again.",
      );
    }
  }

  /**
   * Same revocation, but for the account a reauthorization just replaced: a
   * failure here must not fail the reconnect that already stored the new
   * credential, so it is logged (account id only) instead of thrown.
   */
  private async revokeReplacedAuthorization(
    account: ConnectorOAuthAccountSecretRecord,
  ): Promise<void> {
    try {
      await this.revokeStoredAuthorization(account);
    } catch {
      logger.error("connector_authorization_revoke_failed", {
        accountId: account.id,
      });
    }
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
   * Walk the accounts idle longer than `KEEP_ALIVE_MIN_AGE_MS` and refresh
   * each one through the same locked path as `getRuntimeToken`, one after
   * another so a pass never holds more than one database connection at a
   * time. One account's outcome never stops the rest of the batch.
   *
   * `isFresh` here decides by `lastRefreshAt` (or `createdAt`, before any
   * refresh), not by `expiresAt`: a token a provider issued without an
   * expiry is otherwise never swept, even though its refresh token can still
   * go stale from disuse.
   */
  async refreshIdleAccounts(input: { now: Date }): Promise<{
    checked: number;
    refreshed: number;
    alreadyFresh: number;
    reauthRequired: number;
    skipped: number;
    failed: number;
  }> {
    const candidates = await listOAuthAccountsDueForKeepAlive({
      refreshedBefore: new Date(input.now.getTime() - KEEP_ALIVE_MIN_AGE_MS),
      limit: KEEP_ALIVE_BATCH_LIMIT,
      // F5: only accounts whose connector still has a registered adapter, so a
      // switched-off connector's accounts never occupy the oldest-first batch
      // and starve everyone else. The per-account CONNECTOR_ADAPTER_NOT_FOUND
      // handling below stays as a safety net for a connector switched off
      // between this query and the lock.
      connectorTypes: this.registry.listManifests().map((m) => m.type),
    });

    const counts = {
      checked: candidates.length,
      refreshed: 0,
      alreadyFresh: 0,
      reauthRequired: 0,
      skipped: 0,
      failed: 0,
    };

    for (const candidate of candidates) {
      try {
        // F6: keep-alive goes straight to the locked refresh and never joins
        // the `getRuntimeToken` single-flight map — the row lock already
        // serializes it, and this way its result is decided by its own
        // `lastRefreshAt`-based predicate, never by a runtime caller's.
        const { refreshed } = await this.lockAndRefresh(
          candidate,
          (locked) =>
            new Date(locked.lastRefreshAt ?? locked.createdAt).getTime() >=
            input.now.getTime() - KEEP_ALIVE_MIN_AGE_MS,
        );
        if (refreshed) {
          counts.refreshed += 1;
        } else {
          counts.alreadyFresh += 1;
        }
      } catch (error) {
        const connectorError = toConnectorError(error);
        if (connectorError.code === "CONNECTOR_REAUTH_REQUIRED") {
          counts.reauthRequired += 1;
          logger.info("connector_token_keep_alive_reauth_required", {
            accountId: candidate.id,
            connectorType: candidate.connectorType,
          });
        } else if (
          // The adapter was never resolved (connector switched off), or the
          // account was gone or no longer active by the time the lock was
          // taken: nothing was attempted and nothing changed, so this is not
          // a failure worth a warning.
          connectorError.code === "CONNECTOR_ADAPTER_NOT_FOUND" ||
          connectorError.code === "CONNECTOR_OAUTH_ACCOUNT_NOT_FOUND" ||
          connectorError.code === "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE"
        ) {
          counts.skipped += 1;
        } else {
          counts.failed += 1;
          logger.warn("connector_token_keep_alive_failed", {
            accountId: candidate.id,
            connectorType: candidate.connectorType,
            code: connectorError.code,
          });
        }
      }
    }

    // Skipped when nothing was checked so an idle deployment does not log
    // every hour.
    if (counts.checked > 0) {
      logger.info("connector_token_keep_alive", counts);
    }

    return counts;
  }

  /**
   * The `getRuntimeToken` refresh entry point: at most one refresh in flight
   * per account, so concurrent runtime callers share one provider call and
   * lock wait. It delegates to {@link lockAndRefresh}, which does the adapter
   * lookup and the locked refresh; the keep-alive sweep calls that directly,
   * without this map.
   */
  private async refreshAccountToken(
    account: OAuthAccountRef,
    isFresh: (locked: ConnectorOAuthAccountSecretRecord) => boolean,
  ): Promise<{ accessToken: string; refreshed: boolean }> {
    const inFlight = this.refreshInFlight.get(account.id);
    if (inFlight) {
      return inFlight;
    }

    const task = this.lockAndRefresh(account, isFresh);
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

  /**
   * Refresh an OAuth account's access token under its row lock. Shared by the
   * `getRuntimeToken` single-flight path and the keep-alive sweep, which pass
   * different `isFresh` predicates: `getRuntimeToken`'s decides by `expiresAt`,
   * keep-alive's by `lastRefreshAt`. `isFresh` is evaluated on the row read
   * under the lock, not on `account`: another caller, the keep-alive sweep, or
   * an administrator may have changed it while this call waited. The adapter
   * (R2) and the team key material (F1) are resolved before the lock, outside
   * the retryable/non-retryable classification, so an unregistered adapter or a
   * key-load failure propagates without locking or marking the account.
   */
  private async lockAndRefresh(
    account: OAuthAccountRef,
    isFresh: (locked: ConnectorOAuthAccountSecretRecord) => boolean,
  ): Promise<{ accessToken: string; refreshed: boolean }> {
    const adapter = this.registry.getAdapter(account.connectorType);
    const cipher = await getTeamSecretCipher(account.teamId);
    const outcome = await withOAuthAccountRefreshLock<RefreshDecision>(
      {
        teamId: account.teamId,
        workspaceId: account.workspaceId,
        accountId: account.id,
        lockTimeoutMs: REFRESH_LOCK_TIMEOUT_MS,
      },
      (locked) => this.decideRefresh(locked, adapter, isFresh, cipher),
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
    cipher: TeamSecretCipher,
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
          accessToken: cipher.decrypt(locked.accessTokenEncrypted),
          refreshed: false,
        },
      };
    }

    // F2: only an absent refresh token (null) or one that decrypts to an empty
    // string marks the account. A decrypt that THROWS (a transient key failure,
    // a wrong deployment secret) is not a reauthorization problem: it
    // propagates out of `decide`, the transaction rolls back, and the healthy
    // account is left untouched.
    const refreshToken = cipher.decrypt(locked.refreshTokenEncrypted);
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

    // F3: classify only the provider's own answer. The try wraps the provider
    // call and its timeout race and nothing else; work after a successful
    // answer (encrypting the rotated tokens, building the write) throws out of
    // `decide` unclassified, so a local failure after the provider already
    // rotated the single-use token never marks the account.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const providerCall = adapter.refreshOAuthToken({
      refreshToken,
      scopes: locked.scopes,
    });
    // F8: the loser of the race (almost always the provider call, when the
    // timeout wins) may still settle later. If it SUCCEEDS after the timeout,
    // the provider likely rotated the token and we dropped the result — warn so
    // the lost rotation is visible. A late rejection stays silent. Either way
    // the settled promise is observed here so it never surfaces as an unhandled
    // rejection.
    providerCall.then(
      () => {
        if (timedOut) {
          logger.warn("connector_token_refresh_late_success", {
            accountId: locked.id,
            connectorType: locked.connectorType,
          });
        }
      },
      () => {},
    );

    let tokenSet: OAuthTokenSet;
    try {
      tokenSet = await Promise.race<OAuthTokenSet>([
        providerCall,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
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
    }

    return {
      write: {
        kind: "token",
        accessTokenEncrypted: cipher.encrypt(tokenSet.accessToken),
        refreshTokenEncrypted:
          tokenSet.refreshToken === undefined
            ? undefined
            : tokenSet.refreshToken
              ? cipher.encrypt(tokenSet.refreshToken)
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
  }
}
