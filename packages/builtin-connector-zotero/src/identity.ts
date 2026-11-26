import { createHash } from "node:crypto";
import type { ConnectorCredentialInput } from "@sourceweft/contracts";
import { ZOTERO_LIBRARY_ID_PATTERN } from "./contribution";
import { ZoteroError } from "./errors";

const LIBRARY_ID = new RegExp(ZOTERO_LIBRARY_ID_PATTERN);
const LIBRARY_PREFIX = /^(?:users|groups)\/[1-9][0-9]{0,11}$/;
/** Printable ASCII with no space: safe in an HTTP header value. */
const API_KEY_SECRET = /^[\x21-\x7E]+$/;

export type ZoteroLibraryPrefix = `users/${string}` | `groups/${string}`;

/** True for a string usable as a Zotero API key in a request header. */
export function isUsableApiKey(secret: unknown): secret is string {
  return typeof secret === "string" && API_KEY_SECRET.test(secret);
}

/** True for `users/<id>` or `groups/<id>` with a valid numeric library id. */
export function isLibraryPrefix(value: unknown): value is ZoteroLibraryPrefix {
  return typeof value === "string" && LIBRARY_PREFIX.test(value);
}

/**
 * The library prefix (`users/<id>` or `groups/<id>`) named by a connector's
 * non-secret configuration. Throws `ZOTERO_CONFIG_INVALID` for anything else.
 */
export function libraryPrefixFromConfig(
  config: Record<string, unknown>,
): ZoteroLibraryPrefix {
  const { libraryType, libraryId } = config;
  if (
    (libraryType !== "user" && libraryType !== "group") ||
    typeof libraryId !== "string" ||
    !LIBRARY_ID.test(libraryId)
  ) {
    throw new ZoteroError("ZOTERO_CONFIG_INVALID");
  }
  return `${libraryType === "user" ? "users" : "groups"}/${libraryId}`;
}

/**
 * A stable, non-secret account identity for the `credential` connector:
 * `sha256("zotero\n" + libraryType + "/" + libraryId)`, hex. The API key is
 * never part of it, so rotating the key keeps the account while a different
 * library (or library type) is a different account.
 */
export function zoteroCredentialIdentity(
  config: Record<string, unknown>,
  // Part of the adapter signature; deliberately unused so a rotated key
  // never changes the identity.
  _credential: ConnectorCredentialInput,
): string {
  return createHash("sha256")
    .update(`zotero\n${libraryPrefixFromConfig(config)}`)
    .digest("hex");
}

/**
 * Parses the stored credential out of the account's `accessToken` (the JSON
 * `{ username: "<users|groups>/<libraryId>", secret: "<api key>" }` the
 * create/rotate flow encrypted). Exactly those two fields are accepted; a
 * non-JSON token, an extra or missing field, a username that is not a library
 * prefix, or a secret that is empty or contains anything outside printable
 * ASCII is a `ZOTERO_REAUTH_REQUIRED` error with a fixed message.
 */
export function parseStoredCredential(accessToken: string): {
  username: string;
  secret: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(accessToken);
  } catch {
    throw new ZoteroError("ZOTERO_REAUTH_REQUIRED");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ZoteroError("ZOTERO_REAUTH_REQUIRED");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !("username" in record) ||
    !("secret" in record)
  ) {
    throw new ZoteroError("ZOTERO_REAUTH_REQUIRED");
  }
  const { username, secret } = record;
  if (!isLibraryPrefix(username) || !isUsableApiKey(secret)) {
    throw new ZoteroError("ZOTERO_REAUTH_REQUIRED");
  }
  return { username, secret };
}
