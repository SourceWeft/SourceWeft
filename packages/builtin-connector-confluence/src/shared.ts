// Constants and helpers shared by the Confluence adapter and its live tools,
// defined once so the read-scope check and invalid-request error cannot drift
// apart between those files.

import { AtlassianApiError, type AtlassianSite } from "@sourceweft/atlassian-client";

/** Product name used in user-facing messages. */
export const CONFLUENCE_PRODUCT_LABEL = "Confluence";

/** A site is a Confluence site this connector may read only if one of its
 * granted scopes is a Confluence scope (`…:confluence`). */
const CONFLUENCE_SCOPE_SUFFIX = ":confluence";

export function hasConfluenceScope(site: AtlassianSite): boolean {
  return site.scopes.some((scope) => scope.endsWith(CONFLUENCE_SCOPE_SUFFIX));
}

/** A `400 CONFLUENCE_INVALID_REQUEST` with a message that never carries a
 * token, a query or a response body. */
export function invalidRequest(
  message = `Invalid ${CONFLUENCE_PRODUCT_LABEL} request`,
): AtlassianApiError {
  return new AtlassianApiError(400, "CONFLUENCE_INVALID_REQUEST", message);
}
