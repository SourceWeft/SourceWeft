export {
  zoteroConnectorContribution,
  ZOTERO_KEY_PATTERN,
  ZOTERO_LIBRARY_ID_PATTERN,
} from "./contribution";
export { builtinZoteroConnectorCapabilityManifest } from "./manifest";
export { toBackendZoteroManifest } from "./backend-manifest";
export { createConnectorAdapters } from "./host-services";
export {
  PAGE_SIZE,
  MAX_OBJECTS,
  MAX_REQUESTS,
  MAX_RESTARTS,
  REQUEST_TIMEOUT_MS,
  SCAN_TIMEOUT_MS,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  MAX_BACKOFF_WAIT_MS,
  MAX_RESPONSE_BYTES,
  MAX_SELECTED_COLLECTIONS,
  SHORTCUT_MAX_AGE_MS,
  MAX_TEXT_CHARS,
} from "./limits";
export { ZoteroError, type ZoteroErrorCode } from "./errors";
export {
  zoteroCredentialIdentity,
  parseStoredCredential,
  libraryPrefixFromConfig,
  type ZoteroLibraryPrefix,
} from "./identity";
export {
  createZoteroClient,
  assertReadOnly,
  type ZoteroClient,
  type ZoteroKeyInfo,
  type ZoteroPage,
  type CreateZoteroClientInput,
} from "./client";
export { ZOTERO_USER_AGENT } from "./limits";
export {
  parseCollection,
  buildCollectionTree,
  parseItem,
  groupLibrary,
  inScope,
  contentHashOf,
  toConnectorItem,
  noteText,
  type ZoteroCollection,
  type CollectionTree,
  type ZoteroObject,
  type ZoteroItemGroup,
} from "./model";
export {
  scanLibrary,
  type ScanLimits,
  type ScanCheckpoint,
  type ScanLibraryInput,
} from "./scan";
