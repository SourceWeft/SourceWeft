import { createHash } from "node:crypto";
import type { ConnectorCredentialInput } from "@sourceweft/contracts";
import { GhostError } from "./errors";
import { parseSiteUrl } from "./site-url";

/** Printable ASCII with no space: nothing that can break a URL or a log line.
 * A real Content API key is 26 hex characters; this is deliberately wider. */
const API_KEY_SECRET = /^[\x21-\x7E]{1,256}$/;

/**
 * The stored credential of a Ghost connector: the Content API key. Never
 * logged, never placed in an error or a result; only the client may put it in
 * the query string of a request to the site's own origin.
 */
export type GhostCredential = { secret: string };

/**
 * Parses the stored credential out of the account's `accessToken` (the JSON
 * `{ username, secret }` the create/rotate flow encrypted). The `username` is
 * required by the platform's credential form but means nothing to Ghost, so it
 * is only checked to be a string; the secret is the key. A token that is not
 * JSON, not an object, carries a field other than those two, or holds an empty,
 * oversized or non-printable secret is a credential failure with a fixed
 * message (`BAD_CREDENTIALS`, the reconnect condition), so a damaged token reads
 * exactly like a key the site rejected and nothing of it is echoed.
 */
export function parseStoredCredential(accessToken: string): GhostCredential {
  const rejected = () => new GhostError("BAD_CREDENTIALS");
  let parsed: unknown;
  try {
    parsed = JSON.parse(accessToken);
  } catch {
    throw rejected();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw rejected();
  }
  const record = parsed as Record<string, unknown>;
  for (const name of Object.keys(record)) {
    if (name !== "username" && name !== "secret") throw rejected();
  }
  const { username, secret } = record;
  if (username !== undefined && typeof username !== "string") throw rejected();
  if (typeof secret !== "string" || !API_KEY_SECRET.test(secret)) {
    throw rejected();
  }
  return { secret };
}

/**
 * A stable, non-secret account identity for the credential connector:
 * `sha256("ghost\n" + siteBase)`, hex. The key is never part of it, and the
 * site base is the normalised one {@link parseSiteUrl} produces, so a different
 * host or subfolder is a different account (the platform then asks for a new
 * key) while a rotated key, another username or another selection keeps it. It
 * is stored as the account's `providerAccountId`, so the same Ghost site cannot
 * be attached twice in one workspace. An unusable address is a
 * `SITE_URL_INVALID` error.
 */
export function ghostCredentialIdentity(
  config: Record<string, unknown>,
  // Part of the adapter signature; deliberately unused so a rotated key (or
  // another username) never changes the identity.
  _credential: ConnectorCredentialInput,
): string {
  const base = parseSiteUrl(
    typeof config.siteUrl === "string" ? config.siteUrl : "",
  );
  return createHash("sha256").update(`ghost\n${base}`).digest("hex");
}
