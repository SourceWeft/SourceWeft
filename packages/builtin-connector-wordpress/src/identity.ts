import { createHash } from "node:crypto";
import type { ConnectorCredentialInput } from "@sourceweft/contracts";
import { WordPressError } from "./errors";
import { parseSiteUrl } from "./site-url";

/** The stored credential of the login connector: a username and an Application
 * Password. Never logged, never placed in a URL, an error or a result. */
export type WordPressCredential = { username: string; secret: string };

/**
 * Parses the stored credential out of the account's `accessToken` (the JSON
 * `{ username, secret }` the create/rotate flow encrypted). Nothing else is
 * accepted: an extra field, a missing or empty value, a non-string, or a
 * username containing `:` (which would make an ambiguous Basic header) is a
 * credential failure. The error is a fixed-message `BAD_CREDENTIALS` that never
 * echoes the value, so a malformed or empty token reads as "the account needs to
 * reconnect", exactly like a password the site rejected.
 */
export function parseStoredCredential(
  accessToken: string,
): WordPressCredential {
  const rejected = () => new WordPressError("BAD_CREDENTIALS");
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
  const keys = Object.keys(record);
  if (keys.length !== 2 || !("username" in record) || !("secret" in record)) {
    throw rejected();
  }
  const { username, secret } = record;
  if (
    typeof username !== "string" ||
    typeof secret !== "string" ||
    username.length === 0 ||
    secret.length === 0 ||
    username.includes(":")
  ) {
    throw rejected();
  }
  return { username, secret };
}

/** The `Authorization: Basic …` value for a credential. Sent by the client only
 * to the site's own origin; the Application Password never leaves it. */
export function basicAuthorization(credential: WordPressCredential): string {
  const token = Buffer.from(
    `${credential.username}:${credential.secret}`,
    "utf8",
  ).toString("base64");
  return `Basic ${token}`;
}

/**
 * A stable, non-secret account identity for the login connector:
 * `sha256(siteBase + "\n" + username)`, hex. The Application Password is never
 * part of it, and the site base is the normalised one {@link parseSiteUrl}
 * produces, so it changes when the site address (host or subfolder) or the
 * username changes — the platform then asks for a new credential — but not when
 * only the password is rotated. The platform stores it as the account's
 * `providerAccountId` so the same site and user cannot be attached twice in one
 * workspace.
 */
export function wordPressCredentialIdentity(
  config: Record<string, unknown>,
  credential: ConnectorCredentialInput,
): string {
  const base = parseSiteUrl(
    typeof config.siteUrl === "string" ? config.siteUrl : "",
  );
  return createHash("sha256")
    .update(`${base}\n${credential.username}`)
    .digest("hex");
}
