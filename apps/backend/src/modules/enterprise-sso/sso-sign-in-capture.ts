/**
 * Per-request facts the `@better-auth/sso@1.7.7` plugin does not pass to
 * `provisionUser`: whether THIS sign-in created the user row, and the id of the
 * session it created.
 *
 * The plugin creates the user and the session inside the sign-in transaction and
 * only then — after the transaction commits — calls `provisionUser` with just
 * `{ user, userInfo, token, provider }` (no `isRegister`, no session, no endpoint
 * context). So the guard registers `user.create.after` / `session.create.after`
 * database hooks that run (and, being queued as after-transaction hooks, are
 * awaited) between the commit and `provisionUser`; they record the two facts
 * here keyed by userId, and {@link provisionSsoUser} reads and clears them.
 *
 * Keying by userId is exact in the normal case — one SSO sign-in creates at most
 * one user and one session per user per request — and the hooks only record on
 * an SSO callback path, so a concurrent password sign-in's session (created on a
 * different endpoint) is never captured here. Two concurrent sign-ins of the
 * SAME existing identity can overwrite each other's `sessionId`, but that path
 * ends in "already a member" (handled as success, no session revocation), so the
 * stale entry is never read. A user whose session creation itself fails leaves a
 * `userCreated` entry that `provisionUser` never reads; such residue is rare and
 * bounded (a later sign-in by the same user overwrites it).
 */
export type SsoSignInCapture = {
  /** True only when this sign-in created the user row. */
  userCreated: boolean;
  /** The session this sign-in created, for exact revocation on a failed add. */
  sessionId?: string;
};

const captures = new Map<string, SsoSignInCapture>();

function entryFor(userId: string): SsoSignInCapture {
  const existing = captures.get(userId);
  if (existing) {
    return existing;
  }
  const created: SsoSignInCapture = { userCreated: false };
  captures.set(userId, created);
  return created;
}

/** Record that an SSO sign-in created this user row (user.create.after hook). */
export function recordSsoCreatedUser(userId: string): void {
  entryFor(userId).userCreated = true;
}

/** Record the session an SSO sign-in created (session.create.after hook). */
export function recordSsoSignInSession(userId: string, sessionId: string): void {
  entryFor(userId).sessionId = sessionId;
}

/** Read and clear this sign-in's capture for `userId`. */
export function takeSsoSignInCapture(
  userId: string,
): SsoSignInCapture | undefined {
  const capture = captures.get(userId);
  captures.delete(userId);
  return capture;
}
