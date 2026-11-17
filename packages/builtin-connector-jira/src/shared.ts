// Constants and helpers shared by the Jira adapter, its live tools and its
// cursor, defined once so the fan-out cap, cursor length, read-scope check and
// invalid-request error cannot drift apart between those files.

import { AtlassianApiError, type AtlassianSite } from "@sourceweft/atlassian-client";

/** At most this many sites are contacted per call, in cloud-id ascending order. */
export const MAX_FANOUT_SITES = 5;

/** The upper bound on a cursor, matching the `cursor` field's `maxLength` in the
 * contribution input schemas. */
export const CURSOR_MAX_LENGTH = 4096;

/** The OAuth scope that marks a site as a Jira site this connector may read. A
 * site is included only if its scopes contain this. */
export const JIRA_READ_SCOPE = "read:jira-work";

export function hasJiraScope(site: AtlassianSite): boolean {
  return site.scopes.includes(JIRA_READ_SCOPE);
}

/** A `400 JIRA_INVALID_REQUEST` with a message that never carries a token, a
 * query or a response body. */
export function invalidRequest(message = "Invalid Jira request"): AtlassianApiError {
  return new AtlassianApiError(400, "JIRA_INVALID_REQUEST", message);
}
