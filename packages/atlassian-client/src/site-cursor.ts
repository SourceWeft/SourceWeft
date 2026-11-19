// Multi-site paging cursor for the agent tools. A cursor is
// `base64url(JSON.stringify({ v: 1, sites: Record<cloudId, string | null> }))`;
// a `null` token marks a finished site.

import { Buffer } from "node:buffer";
import { AtlassianApiError, type AtlassianErrorPrefix } from "./errors";
import { CURSOR_MAX_LENGTH } from "./sites";

const PRODUCT_NAMES: Record<AtlassianErrorPrefix, string> = {
  JIRA: "Jira",
  CONFLUENCE: "Confluence",
};

function invalidCursor(prefix: AtlassianErrorPrefix): AtlassianApiError {
  return new AtlassianApiError(
    400,
    `${prefix}_INVALID_REQUEST`,
    `Invalid ${PRODUCT_NAMES[prefix]} cursor`,
  );
}

/** Encodes a per-site paging state (`cloudId -> next page token | null`). */
export function encodeSiteCursor(sites: Record<string, string | null>): string {
  return Buffer.from(JSON.stringify({ v: 1, sites }), "utf8").toString(
    "base64url",
  );
}

/**
 * Decodes and validates a multi-site cursor, throwing
 * `400 <PREFIX>_INVALID_REQUEST` on anything malformed: a non-string, an
 * over-long value, non-base64url JSON, the wrong version, a `sites` map that is
 * not a plain object, a token that is neither a string nor `null`, or a site id
 * that is not in `allowedCloudIds` (a cursor naming a site outside the selection
 * is invalid). Runs before any request reaches Atlassian.
 */
export function decodeSiteCursor(
  value: unknown,
  allowedCloudIds: readonly string[],
  errorPrefix: AtlassianErrorPrefix,
): Record<string, string | null> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CURSOR_MAX_LENGTH
  ) {
    throw invalidCursor(errorPrefix);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor(errorPrefix);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidCursor(errorPrefix);
  }
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) throw invalidCursor(errorPrefix);
  const sites = record.sites;
  if (typeof sites !== "object" || sites === null || Array.isArray(sites)) {
    throw invalidCursor(errorPrefix);
  }
  const allowed = new Set(allowedCloudIds);
  const result: Record<string, string | null> = {};
  for (const [cloudId, token] of Object.entries(
    sites as Record<string, unknown>,
  )) {
    if (!allowed.has(cloudId)) throw invalidCursor(errorPrefix);
    if (token !== null && typeof token !== "string") {
      throw invalidCursor(errorPrefix);
    }
    result[cloudId] = token;
  }
  return result;
}
