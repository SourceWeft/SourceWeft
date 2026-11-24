export {
  webDavConnectorContribution,
  WEBDAV_ENDPOINT_PATTERN,
  WEBDAV_PATH_PATTERN,
} from "./contribution";
export { builtinWebDavConnectorCapabilityManifest } from "./manifest";
export { toBackendWebDavManifest } from "./backend-manifest";
export {
  createWebdavAdapter,
  WebDavAdapterError,
  type WebDavAdapterInput,
} from "./adapter";
export {
  discoverWebDavPages,
  DEFAULT_DISCOVERY_LIMITS,
  type DiscoveryLimits,
  type DiscoveryOptions,
} from "./discovery";
export { webDavCredentialIdentity, parseStoredCredential } from "./identity";
export { WebDavError, type WebDavErrorCode } from "./errors";
export { parseEndpoint, redactEndpoint } from "./endpoint";
export {
  isStrictDescendant,
  normalizePath,
  normalizeRoot,
  samePath,
  toExternalId,
  toRequestUrl,
} from "./paths";
export { parseMultistatus, type DavEntry } from "./multistatus";
export {
  createDavClient,
  assertReadOnlyMethod,
  type CreateDavClientInput,
  type DavClient,
  type DavCredential,
  type DavDownload,
  type DavMethod,
  type DavServerInfo,
} from "./dav-client";
export {
  MAX_DEPTH,
  MAX_ENTRIES,
  MAX_ROOTS,
  MAX_MULTISTATUS_BYTES,
  REQUEST_TIMEOUT_MS,
  SCAN_TIMEOUT_MS,
  MAX_FILE_BYTES,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  WEBDAV_USER_AGENT,
} from "./limits";
