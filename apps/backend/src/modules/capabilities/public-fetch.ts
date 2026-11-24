import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import { createControlledFetch } from "../../shared/security/controlled-fetch";

/**
 * Opens a public-internet-only fetch scope for a connector adapter.
 *
 * The host owns the policy so no connector can widen it: address checks stay
 * on, no internal origin is allowed, and cross-origin redirects are followed
 * (bounded by the controlled fetch's redirect cap, with credential headers
 * dropped) because feed hosts routinely redirect to a CDN. Every call opens a
 * new scope; the holder closes it.
 */
export function createPublicFetchScope(): ConnectorPublicFetchScope {
  const scope = createControlledFetch(
    { enforceAddressChecks: true, allowedInternalOrigins: [] },
    { allowCrossOriginRedirects: true },
  );
  return { fetch: scope.fetch, close: scope.close };
}
