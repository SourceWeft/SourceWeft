export {
  wordpressConnectorContribution,
  WORDPRESS_SITE_URL_PATTERN,
  WORDPRESS_ID_PATTERN,
  WORDPRESS_CATEGORY_ID_PATTERN,
} from "./contribution";
export { wordpressLoginConnectorContribution } from "./login-contribution";
export { builtinWordPressConnectorCapabilityManifest } from "./manifest";
export { toBackendWordPressManifest } from "./backend-manifest";
export { toBackendWordPressLoginManifest } from "./login-backend-manifest";
export { createConnectorAdapters } from "./host-services";
export {
  createWordPressAdapter,
  WordPressAdapterError,
  type WordPressAdapterInput,
} from "./adapter";
export { wordPressCredentialIdentity } from "./identity";
export {
  PER_PAGE,
  MAX_ITEMS,
  MAX_REQUESTS,
  SCAN_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  MIN_REQUEST_GAP_MS,
  MAX_SELECTED_ITEMS,
  MAX_TEXT_CHARS,
  MAX_CATEGORY_PAGES,
  MAX_TAG_IDS,
  MAX_METADATA_TERMS,
  ACTION_DEADLINE_MS,
  HOME_HTML_BYTES,
  MAX_SCAN_RESTARTS,
} from "./limits";
