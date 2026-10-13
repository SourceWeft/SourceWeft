import { logger } from "../../shared/logger";
import { shortId } from "../../shared/log-ids";

type BetterAuthLogLevel = "debug" | "info" | "warn" | "error";

/**
 * A replayed OAuth callback (the browser re-requesting the callback URL after
 * the session was already established) makes Better Auth log
 * `Failed to parse state` at error with a `StateError` whose code is
 * `state_mismatch`. That is noise, not a failure, so it is reported at warn.
 * `state_security_mismatch` (a state that exists but does not match) keeps its
 * error level.
 */
const PARSE_STATE_MESSAGE = "Failed to parse state";
const REPLAYED_STATE_CODE = "state_mismatch";

function readErrorCode(arg: unknown): string | null {
  if (!arg || typeof arg !== "object") {
    return null;
  }
  const code = (arg as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function resolveBetterAuthLogLevel(input: {
  level: BetterAuthLogLevel;
  message: string;
  args: unknown[];
}): { level: BetterAuthLogLevel; code?: string } {
  if (input.level !== "error" || input.message !== PARSE_STATE_MESSAGE) {
    return { level: input.level };
  }
  const code = input.args.map(readErrorCode).find((value) => value !== null);
  if (code === REPLAYED_STATE_CODE) {
    return { level: "warn", code };
  }
  return code ? { level: "error", code } : { level: "error" };
}

export function logAuthUserCreated(user: { id: string }) {
  logger.info("auth.user_created", { userId: shortId(user.id) });
}

/**
 * `context.path` is the endpoint template that created the session
 * (`/sign-in/email`, `/callback/:id`, `/magic-link/verify`), never a URL with
 * query parameters, so it is safe to log as the sign-in method.
 */
export function logAuthSessionCreated(
  session: { userId: string },
  context: { path?: string } | null | undefined,
) {
  logger.info("auth.session_created", {
    userId: shortId(session.userId),
    via: context?.path ?? null,
  });
}

function readReturnedUserId(returned: unknown): string | null {
  if (!returned || typeof returned !== "object") {
    return null;
  }
  const user = (returned as { user?: { id?: unknown } }).user;
  return typeof user?.id === "string" ? user.id : null;
}

/**
 * The desktop app completes its sign-in handoff by redeeming the one-time
 * token from the deep link; the verify endpoint's return value is the session
 * envelope, whose user id is the only field reported.
 */
export function logDesktopHandoffCompleted(returned: unknown) {
  logger.info("auth.desktop_handoff_completed", {
    userId: shortId(readReturnedUserId(returned)),
  });
}
