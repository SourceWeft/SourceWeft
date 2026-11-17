// Multi-site paging cursor for the Jira agent tools (R6). A cursor is
// `base64url(JSON.stringify({ v: 1, sites: Record<cloudId, string | null> }))`;
// a `null` token marks a finished site. Part 2 (Confluence) copies this file —
// it is small, product-specific code, so it is not shared via
// `@sourceweft/atlassian-client`.

import { Buffer } from "node:buffer";
import { AtlassianApiError } from "@sourceweft/atlassian-client";

/** Matches the `cursor` field's `maxLength` declared in contribution.ts. */
const CURSOR_MAX_LENGTH = 4096;

function invalidCursor(): AtlassianApiError {
  return new AtlassianApiError(400, "JIRA_INVALID_REQUEST", "Invalid Jira cursor");
}

/** Encodes a per-site paging state (`cloudId -> next page token | null`). */
export function encodeSiteCursor(sites: Record<string, string | null>): string {
  return Buffer.from(JSON.stringify({ v: 1, sites }), "utf8").toString(
    "base64url",
  );
}

/**
 * Decodes and validates a multi-site cursor, throwing `400 JIRA_INVALID_REQUEST`
 * on anything malformed: a non-string, an over-long value, non-base64url JSON,
 * the wrong version, a `sites` map that is not a plain object, a token that is
 * neither a string nor `null`, or a site id that is not in `allowedCloudIds`
 * (R6: a cursor naming a site outside the selection is invalid). Runs before
 * any request reaches Jira.
 */
export function decodeSiteCursor(
  value: unknown,
  allowedCloudIds: string[],
): Record<string, string | null> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CURSOR_MAX_LENGTH
  ) {
    throw invalidCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidCursor();
  }
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) throw invalidCursor();
  const sites = record.sites;
  if (typeof sites !== "object" || sites === null || Array.isArray(sites)) {
    throw invalidCursor();
  }
  const allowed = new Set(allowedCloudIds);
  const result: Record<string, string | null> = {};
  for (const [cloudId, token] of Object.entries(
    sites as Record<string, unknown>,
  )) {
    if (!allowed.has(cloudId)) throw invalidCursor();
    if (token !== null && typeof token !== "string") throw invalidCursor();
    result[cloudId] = token;
  }
  return result;
}
