// Constants and helpers shared by the Jira adapter and its live tools, defined
// once so the read-scope check and invalid-request error cannot drift apart
// between those files.

import { AtlassianApiError, type AtlassianSite } from "@sourceweft/atlassian-client";

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
