import type { ConnectorCredentialInput } from "@sourceweft/contracts";

/**
 * The opaque credential string an adapter receives in `accessToken` for a
 * `credential` connector: the member's username and secret as JSON. Built and
 * parsed in exactly one place so the check path, the stored value and the
 * revoke path never diverge. The secret never leaves this shape — it is
 * encrypted before storage and never logged, copied into configJson, or
 * returned.
 */
export function credentialAccessToken(
  credential: ConnectorCredentialInput,
): string {
  return JSON.stringify({
    username: credential.username,
    secret: credential.secret,
  });
}

/**
 * The inverse of {@link credentialAccessToken}: recover the `{ username, secret }`
 * from a stored, decrypted credential string. Used only where the secret must be
 * handed back to an adapter (e.g. a credential login-flow `discard` at delete
 * time). Throws on a malformed stored value so a corrupt row never yields a
 * partial credential; the caller treats that as a best-effort revoke that could
 * not run.
 */
export function parseCredentialAccessToken(
  token: string,
): ConnectorCredentialInput {
  const parsed = JSON.parse(token) as { username?: unknown; secret?: unknown };
  if (
    typeof parsed?.username !== "string" ||
    typeof parsed?.secret !== "string"
  ) {
    throw new Error("Stored credential is malformed");
  }
  return { username: parsed.username, secret: parsed.secret };
}
