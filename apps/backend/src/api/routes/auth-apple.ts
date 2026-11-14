import { Hono } from "hono";
import { z } from "zod";
import { storeAppleRefreshToken } from "../../modules/auth/apple-account-tokens";
import { AppleTokenError } from "../../modules/auth/apple-tokens";
import { logger } from "../../shared/logger";
import { getSessionUserId, requireSession } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";

const bodySchema = z.object({
  // Apple's authorization codes are short opaque strings; the cap only keeps
  // arbitrary payloads away from Apple.
  code: z.string().trim().min(1).max(2048),
});

/**
 * The iOS app calls this right after a native Sign in with Apple succeeds,
 * with the authorization code Apple gave it. The backend exchanges it for the
 * refresh token it needs to revoke access when the account is deleted. If this
 * fails, the app signs the person out again: an Apple account without a
 * stored token could not be deleted cleanly.
 */
export function registerAuthAppleRoutes(app: Hono) {
  app.post("/v1/auth/apple/authorization-code", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      return ApiResponse.error(c, ApiError.unauthorized());
    }

    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return ApiResponse.error(c, ApiError.validation());
    }

    const userId = getSessionUserId(session);
    try {
      const result = await storeAppleRefreshToken(userId, parsed.data.code);
      if (result.kind === "disabled") {
        return ApiResponse.error(
          c,
          new ApiError(
            404,
            "APPLE_SIGN_IN_DISABLED",
            "Sign in with Apple is not enabled on this server.",
          ),
        );
      }
      if (result.kind === "not_linked") {
        return ApiResponse.error(
          c,
          new ApiError(
            409,
            "APPLE_ACCOUNT_NOT_LINKED",
            "This Apple ID is not linked to the signed-in account.",
          ),
        );
      }
      return ApiResponse.success(c, { stored: true });
    } catch (error) {
      if (!(error instanceof AppleTokenError)) throw error;
      logger.warn("apple_authorization_code_exchange_failed", {
        userId,
        reason: error.reason,
        status: error.status,
      });
      return ApiResponse.error(
        c,
        error.rejected
          ? new ApiError(
              400,
              "APPLE_AUTHORIZATION_CODE_REJECTED",
              "Apple did not accept the sign-in. Sign in with Apple again.",
            )
          : new ApiError(
              502,
              "APPLE_UNAVAILABLE",
              "Apple could not be reached. Sign in with Apple again in a moment.",
            ),
      );
    }
  });
}
