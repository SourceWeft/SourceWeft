export { rssConnectorContribution, RSS_FEED_URL_PATTERN } from "./contribution";
export { builtinRssConnectorCapabilityManifest } from "./manifest";
export { toBackendRssManifest } from "./backend-manifest";
export { createRssConnectorAdapter } from "./adapter";
export { RssAdapterError } from "./errors";
export { createConnectorAdapters } from "./host-services";
export {
  FEED_MAX_BODY_BYTES,
  FEED_TIMEOUT_MS,
  FEED_MAX_ITEMS,
  FEED_USER_AGENT,
} from "./limits";
