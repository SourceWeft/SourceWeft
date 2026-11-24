import { database } from "@sourceweft/db";
import { APIError } from "better-auth/api";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import { decryptSecret, encryptSecret } from "../../shared/secrets";
import {
  AppleTokenError,
  exchangeAppleAuthorizationCode,
  revokeAppleRefreshToken,
  type AppleKeySettings,
} from "./apple-tokens";

/**
 * Apple refresh tokens kept so that deleting an account can revoke the app's
 * access to the person's Apple ID (App Store guideline 5.1.1(v)).
 *
 * Two sign-ins produce them:
 * - Native iOS: Better Auth's ID-token sign-in stores no refresh token, so the
 *   app sends its authorization code afterwards; it is exchanged here, as the
 *   iOS app's bundle id.
 * - Web: Better Auth's redirect flow exchanges the code itself, as the web
 *   Services ID, and writes the refresh token into the account row; the
 *   account database hook ({@link protectAppleAccountWrite}) encrypts it on
 *   the way in.
 *
 * Either way the token lands on the user's `apple` row in Better Auth's
 * `account` table, encrypted with the deployment master secret
 * (`encryptSecret`) because it is a credential of the person, not of a team.
 * Apple only revokes a token as the client it was issued to, so the stored
 * value records that client next to the token. Values written before web
 * sign-in existed are the bare token and were all issued to the bundle id.
 */

type AppleAccountRow = {
  id: string;
  accountId: string;
  refreshToken: string | null;
};

type AppleKey = Omit<AppleKeySettings, "clientId">;

/** The Sign in with Apple key, or null when this server has none. */
function appleKey(): AppleKey | null {
  const auth = config.auth;
  if (!auth.appleTeamId || !auth.appleKeyId || !auth.applePrivateKey) {
    return null;
  }
  return {
    teamId: auth.appleTeamId,
    keyId: auth.appleKeyId,
    privateKey: auth.applePrivateKey,
  };
}

/** Settings for calls made as the iOS app, or null when it is not set up. */
export function appleKeySettings(): AppleKeySettings | null {
  const key = appleKey();
  if (!key || !config.auth.appleAppBundleId) return null;
  return { ...key, clientId: config.auth.appleAppBundleId };
}

function encryptionSecret() {
  return config.modelGatewayEncryptionSecret;
}

type StoredAppleToken = { clientId: string; refreshToken: string };

/** The encrypted column value for a refresh token issued to `clientId`. */
export function sealAppleRefreshToken(token: StoredAppleToken) {
  return encryptSecret(
    JSON.stringify({ clientId: token.clientId, token: token.refreshToken }),
    encryptionSecret(),
  );
}

/**
 * Reads a stored refresh token and the client it was issued to. Apple refresh
 * tokens never start with `{`, so a bare token is a value from before the
 * client was recorded, which only the iOS app could have written.
 */
export function openAppleRefreshToken(
  stored: string,
  legacyClientId: string,
): StoredAppleToken {
  const plain = decryptSecret(stored, encryptionSecret());
  if (!plain.startsWith("{")) {
    return { clientId: legacyClientId, refreshToken: plain };
  }
  const parsed = JSON.parse(plain) as { clientId?: unknown; token?: unknown };
  if (
    typeof parsed.clientId !== "string" ||
    !parsed.clientId ||
    typeof parsed.token !== "string" ||
    !parsed.token
  ) {
    throw new Error("Stored Apple refresh token is malformed.");
  }
  return { clientId: parsed.clientId, refreshToken: parsed.token };
}

async function appleAccountsOf(userId: string) {
  const result = await database.query<AppleAccountRow>(
    `select id, "accountId", "refreshToken" from "account"
     where "userId" = $1 and "providerId" = 'apple'
     order by "createdAt" asc`,
    [userId],
  );
  return result.rows ?? [];
}

export type StoreAppleTokenResult =
  | { kind: "stored" }
  | { kind: "disabled" }
  /** The code belongs to an Apple ID that is not linked to this user. */
  | { kind: "not_linked" };

/**
 * Exchange the authorization code from the app's latest Apple sign-in and keep
 * the refresh token on the signed-in user's matching Apple account. Apple
 * failures are thrown as {@link AppleTokenError}.
 */
export async function storeAppleRefreshToken(
  userId: string,
  code: string,
  apple: {
    exchange: typeof exchangeAppleAuthorizationCode;
    revoke: typeof revokeAppleRefreshToken;
  } = {
    exchange: exchangeAppleAuthorizationCode,
    revoke: revokeAppleRefreshToken,
  },
): Promise<StoreAppleTokenResult> {
  const settings = appleKeySettings();
  if (!settings) return { kind: "disabled" };

  const { refreshToken, subject } = await apple.exchange(settings, code);
  const account = (await appleAccountsOf(userId)).find(
    (row) => row.accountId === subject,
  );
  if (!account) {
    // Nothing was stored, but Apple has just issued a grant for this app: undo
    // it rather than leave an access no account can revoke later.
    await apple.revoke(settings, refreshToken).catch((error: unknown) => {
      logger.warn("apple_unlinked_token_revocation_failed", {
        userId,
        reason: error instanceof AppleTokenError ? error.reason : "unknown",
      });
    });
    return { kind: "not_linked" };
  }

  await database.query(
    `update "account" set "refreshToken" = $1, "updatedAt" = now() where id = $2`,
    [
      sealAppleRefreshToken({ clientId: settings.clientId, refreshToken }),
      account.id,
    ],
  );
  return { kind: "stored" };
}

/**
 * Revoke every Apple refresh token of a user who is deleting their account.
 * Any failure aborts the deletion with a retryable error, so no account is
 * deleted while Apple still grants the app access to its Apple ID.
 */
export async function revokeAppleTokensBeforeDelete(
  userId: string,
  revoke = revokeAppleRefreshToken,
) {
  const accounts = await appleAccountsOf(userId);
  if (accounts.length === 0) return;

  const key = appleKey();
  if (!key) {
    logger.error("apple_token_revocation_unconfigured", { userId });
    throw new APIError("SERVICE_UNAVAILABLE", {
      message:
        "This account uses Sign in with Apple, which this server is not set up to revoke. Contact support to delete it.",
    });
  }

  for (const account of accounts) {
    if (!account.refreshToken) {
      throw new APIError("BAD_REQUEST", {
        message: "Sign in with Apple again, then delete your account.",
      });
    }
    try {
      const { clientId, refreshToken } = openAppleRefreshToken(
        account.refreshToken,
        config.auth.appleAppBundleId,
      );
      await revoke({ ...key, clientId }, refreshToken);
    } catch (error) {
      // invalid_grant: the token was already revoked (for example from the
      // person's Apple ID settings), which is what deletion needs.
      if (
        error instanceof AppleTokenError &&
        error.reason === "invalid_grant"
      ) {
        logger.info("apple_token_already_revoked", { userId });
        continue;
      }
      logger.error("apple_token_revocation_failed", {
        userId,
        reason: error instanceof AppleTokenError ? error.reason : "decrypt",
        status: error instanceof AppleTokenError ? error.status : 0,
      });
      throw new APIError("SERVICE_UNAVAILABLE", {
        message:
          "Your Sign in with Apple access could not be revoked right now. Nothing was deleted; try again in a few minutes.",
      });
    }
  }
}

/**
 * Better Auth database hook for every write to an `account` row, applied in
 * place before the row is written. Only `apple` rows are touched:
 * - A refresh token from the web redirect flow (the OAuth callback) was issued
 *   to the web Services ID; it is sealed with that client before it is stored.
 * - A refresh token written anywhere else did not come from Apple to this
 *   server: the ID-token sign-in accepts one in its request body. It is
 *   dropped, so it can never replace the token deletion revokes.
 * - Apple access tokens open no API this server uses, so they are not kept.
 */
export function protectAppleAccountWrite(
  data: Record<string, unknown>,
  context: { path?: string } | null | undefined,
) {
  if (data.providerId !== "apple") return;
  delete data.accessToken;
  const refreshToken = data.refreshToken;
  delete data.refreshToken;
  const servicesId = config.auth.appleServicesId;
  if (
    typeof refreshToken !== "string" ||
    !refreshToken ||
    !servicesId ||
    !context?.path?.startsWith("/callback/")
  ) {
    return;
  }
  data.refreshToken = sealAppleRefreshToken({
    clientId: servicesId,
    refreshToken,
  });
}
