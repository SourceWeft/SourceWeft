import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";

/**
 * Per-request facts the `@better-auth/sso@1.7.7` plugin does not pass to
 * `provisionUser`: whether THIS sign-in created the user row, and the id of the
 * session it created.
 *
 * The plugin creates the user and the session inside the sign-in transaction and
 * only then — after the transaction commits — calls `provisionUser` with just
 * `{ user, userInfo, token, provider }` (no `isRegister`, no session). So the
 * guard registers `user.create.after` / `session.create.after` database hooks
 * that run (and, being queued as after-transaction hooks, are awaited) between
 * the commit and `provisionUser`, and record the two facts here.
 *
 * The capture is keyed by the REQUEST's endpoint context object — the same
 * object better-auth threads through the whole request via `runWithEndpointContext`
 * and hands every database hook (and which `provisionUser` reads back through
 * `tryGetCurrentAuthEndpointContext`). Two concurrent sign-ins of one user run in
 * two different endpoint contexts, so they can never cross-read each other's
 * capture (the earlier user-id key could). A `WeakMap` lets the entry be
 * collected with its request even if `provisionUser` never takes it (e.g. a
 * sign-in whose session creation itself failed).
 */
export type SsoSignInCapture = {
  /** True only when this sign-in created the user row. */
  userCreated: boolean;
  /** The session this sign-in created, for exact revocation on a failed add. */
  sessionId?: string;
};

const captures = new WeakMap<object, SsoSignInCapture>();

function entryFor(context: object): SsoSignInCapture {
  const existing = captures.get(context);
  if (existing) {
    return existing;
  }
  const created: SsoSignInCapture = { userCreated: false };
  captures.set(context, created);
  return created;
}

/**
 * Record that an SSO sign-in created this user row (`user.create.after` hook).
 * `context` is the endpoint context the hook receives.
 */
export function recordSsoCreatedUser(context: object): void {
  entryFor(context).userCreated = true;
}

/**
 * Record the session an SSO sign-in created (`session.create.after` hook).
 * `context` is the endpoint context the hook receives.
 */
export function recordSsoSignInSession(
  context: object,
  sessionId: string,
): void {
  entryFor(context).sessionId = sessionId;
}

/**
 * Read and clear this request's capture, resolving the endpoint context from the
 * async context `provisionUser` runs in. Returns `undefined` outside a request
 * or when nothing was recorded.
 */
export function takeSsoSignInCapture(): SsoSignInCapture | undefined {
  const context = tryGetCurrentAuthEndpointContext();
  if (!context) {
    return undefined;
  }
  const capture = captures.get(context);
  captures.delete(context);
  return capture;
}
