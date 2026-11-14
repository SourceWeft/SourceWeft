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
 * Apple refresh tokens for accounts created with native Sign in with Apple.
 *
 * Better Auth's ID-token sign-in stores no refresh token, but revoking the
 * app's access when an account is deleted needs one. After each Apple sign-in
 * the app sends its authorization code; it is exchanged here and the refresh
 * token is kept on the user's `apple` row in Better Auth's `account` table.
 * A later sign-in does not clear it: Better Auth skips token fields it was not
 * given.
 *
 * The token is a credential of the person, not of a team, so it is encrypted
 * with the deployment master secret (`encryptSecret`) rather than a team key.
 */

type AppleAccountRow = {
  id: string;
  accountId: string;
  refreshToken: string | null;
};

export function appleKeySettings(): AppleKeySettings | null {
  const auth = config.auth;
  if (!auth.appleAppBundleId) return null;
  return {
    appBundleId: auth.appleAppBundleId,
    teamId: auth.appleTeamId,
    keyId: auth.appleKeyId,
    privateKey: auth.applePrivateKey,
  };
}

function encryptionSecret() {
  return config.modelGatewayEncryptionSecret;
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
    [encryptSecret(refreshToken, encryptionSecret()), account.id],
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

  const settings = appleKeySettings();
  if (!settings) {
    logger.error("apple_token_revocation_unconfigured", { userId });
    throw new APIError("SERVICE_UNAVAILABLE", {
      message:
        "This account uses Sign in with Apple, which this server is not set up to revoke. Contact support to delete it.",
    });
  }

  for (const account of accounts) {
    if (!account.refreshToken) {
      throw new APIError("BAD_REQUEST", {
        message:
          "Sign in with Apple again in the iOS app, then delete your account.",
      });
    }
    try {
      await revoke(
        settings,
        decryptSecret(account.refreshToken, encryptionSecret()),
      );
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
