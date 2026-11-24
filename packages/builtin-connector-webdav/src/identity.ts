import { createHash } from "node:crypto";
import type { ConnectorCredentialInput } from "@sourceweft/contracts";
import type { DavCredential } from "./dav-client";
import { parseEndpoint } from "./endpoint";
import { WebDavError } from "./errors";

/**
 * A stable, non-secret account identity for a `credential` connector:
 * `sha256(endpoint.origin + "\n" + username)`, hex. The secret is never part
 * of it. The platform stores it as the account's `providerAccountId` so the
 * same endpoint and user cannot be attached twice in one workspace.
 */
export function webDavCredentialIdentity(
  config: Record<string, unknown>,
  credential: ConnectorCredentialInput,
): string {
  const endpoint = parseEndpoint(
    typeof config.endpoint === "string" ? config.endpoint : "",
  );
  return createHash("sha256")
    .update(`${endpoint.origin}\n${credential.username}`)
    .digest("hex");
}

/**
 * Parses the stored credential out of the account's `accessToken` (the JSON
 * `{ username, secret }` the create/rotate flow encrypted). Nothing else is
 * accepted: an extra field, a missing or empty value, a non-string, or a
 * username containing `:` (which would make an ambiguous Basic header) is a
 * credential failure. The error is a fixed-message `WEBDAV_UNAUTHORIZED` that
 * never echoes the value, so a malformed or empty token reads as "the account
 * needs to reconnect", exactly like a rejected password.
 */
export function parseStoredCredential(accessToken: string): DavCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(accessToken);
  } catch {
    throw new WebDavError("WEBDAV_UNAUTHORIZED");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WebDavError("WEBDAV_UNAUTHORIZED");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !("username" in record) || !("secret" in record)) {
    throw new WebDavError("WEBDAV_UNAUTHORIZED");
  }
  const { username, secret } = record;
  if (
    typeof username !== "string" ||
    typeof secret !== "string" ||
    username.length === 0 ||
    secret.length === 0 ||
    username.includes(":")
  ) {
    throw new WebDavError("WEBDAV_UNAUTHORIZED");
  }
  return { username, secret };
}
