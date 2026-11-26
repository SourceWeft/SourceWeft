import type {
  ConnectorActionInput,
  ConnectorActionResult,
  ConnectorAdapter,
  ConnectorDiscoverInput,
  ConnectorDiscoveryPage,
  ConnectorExtractedText,
  ConnectorExtractInput,
  ConnectorSyncReadinessResult,
} from "@sourceweft/contracts";
import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import { toAdapterError, ZoteroAdapterError } from "./adapter-error";
import { toBackendZoteroManifest } from "./backend-manifest";
import { createZoteroClient, type ZoteroClient } from "./client";
import { ZOTERO_KEY_PATTERN } from "./contribution";
import { ZoteroError } from "./errors";
import { extractZoteroItem } from "./extract";
import {
  libraryPrefixFromConfig,
  parseStoredCredential,
  zoteroCredentialIdentity,
  type ZoteroLibraryPrefix,
} from "./identity";
import { MAX_SELECTED_COLLECTIONS } from "./limits";
import { scanLibrary, type ScanLimits } from "./scan";
import { browseCollections, describeCollections } from "./selection";

export { ZoteroAdapterError } from "./adapter-error";

export type ZoteroAdapterInput = {
  /** A credentialed controlled-fetch scope. Opened per operation and closed
   * when the operation finishes. */
  credentialedFetch: () => ConnectorPublicFetchScope;
  logger?: { warn?(message: string, meta?: Record<string, unknown>): void };
  /** Test seams. */
  limits?: Partial<ScanLimits>;
  now?: () => number;
};

const KEY = new RegExp(ZOTERO_KEY_PATTERN);

const NOTES_WARNING_MESSAGE =
  "This Zotero key cannot read notes, so notes will not be indexed.";
const CONFIG_INVALID_MESSAGE = "The Zotero library settings are not valid.";
const NOT_ACCESSIBLE_MESSAGE =
  "The Zotero access you granted does not allow reading this library.";

type ResolvedConfig = {
  libraryType: "user" | "group";
  libraryId: string;
  prefix: ZoteroLibraryPrefix;
  /** Empty means the whole library. */
  selectedCollectionKeys: string[];
};

/** Parses the non-secret config. Anything malformed is `ZOTERO_CONFIG_INVALID`. */
function resolveConfig(config: Record<string, unknown>): ResolvedConfig {
  const prefix = libraryPrefixFromConfig(config);
  const items = config.items ?? [];
  if (!Array.isArray(items) || items.length > MAX_SELECTED_COLLECTIONS) {
    throw new ZoteroError("ZOTERO_CONFIG_INVALID");
  }
  const selectedCollectionKeys: string[] = [];
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) {
      throw new ZoteroError("ZOTERO_CONFIG_INVALID");
    }
    const { id, kind } = entry as Record<string, unknown>;
    if (kind !== "collection" || typeof id !== "string" || !KEY.test(id)) {
      throw new ZoteroError("ZOTERO_CONFIG_INVALID");
    }
    selectedCollectionKeys.push(id);
  }
  return {
    libraryType: config.libraryType as "user" | "group",
    libraryId: config.libraryId as string,
    prefix,
    selectedCollectionKeys,
  };
}

/**
 * The stored key and the library the connector is configured for. A key saved
 * for another library (the stored `username` prefix differs from the config's)
 * is a reconnect condition, so a key rotated to a different library can never
 * be used silently.
 */
function resolveCredential(
  accessToken: string,
  prefix: ZoteroLibraryPrefix,
): { secret: string } {
  const { username, secret } = parseStoredCredential(accessToken);
  if (username !== prefix) throw new ZoteroError("ZOTERO_REAUTH_REQUIRED");
  return { secret };
}

/** A not-ready readiness result for a Zotero-layer error, or null when the
 * error is not one this adapter can explain (it then bubbles up). */
function readinessFailure(error: unknown): ConnectorSyncReadinessResult | null {
  if (!(error instanceof ZoteroError)) return null;
  const reason = {
    ZOTERO_REAUTH_REQUIRED: "reauth_required",
    ZOTERO_KEY_INSUFFICIENT_ACCESS: "library_not_accessible",
    ZOTERO_LIBRARY_NOT_FOUND: "library_not_found",
    ZOTERO_RATE_LIMITED: "rate_limited",
    ZOTERO_BLOCKED_ENDPOINT: "blocked_endpoint",
    ZOTERO_CONFIG_INVALID: "config_invalid",
    ZOTERO_UNAVAILABLE: "unreachable",
    ZOTERO_BAD_RESPONSE: "unreachable",
    ZOTERO_TOO_LARGE: "unreachable",
  }[error.code];
  return {
    ready: false,
    reason,
    message:
      error.code === "ZOTERO_CONFIG_INVALID"
        ? CONFIG_INVALID_MESSAGE
        : error.message,
  };
}

export function createZoteroAdapter(
  adapterInput: ZoteroAdapterInput,
): ConnectorAdapter {
  const { credentialedFetch, logger, limits, now } = adapterInput;

  /**
   * Runs `operation` with a fresh client over a fresh credentialed scope and
   * closes the scope afterwards. The client's request budget is per instance,
   * so one client never spans more than one discovery, extraction or action.
   */
  async function withClient<T>(
    accessToken: string,
    config: Record<string, unknown>,
    operation: (context: {
      client: ZoteroClient;
      config: ResolvedConfig;
    }) => Promise<T>,
  ): Promise<T> {
    const scope = credentialedFetch();
    try {
      const resolved = resolveConfig(config);
      const credential = resolveCredential(accessToken, resolved.prefix);
      const client = createZoteroClient({
        fetch: scope.fetch,
        credential,
        libraryPrefix: resolved.prefix,
      });
      return await operation({ client, config: resolved });
    } catch (error) {
      return toAdapterError(error);
    } finally {
      await scope.close();
    }
  }

  async function* pages(
    input: ConnectorDiscoverInput,
  ): AsyncGenerator<ConnectorDiscoveryPage> {
    const scope = credentialedFetch();
    try {
      const resolved = resolveConfig(input.config);
      const credential = resolveCredential(input.accessToken, resolved.prefix);
      const client = createZoteroClient({
        fetch: scope.fetch,
        credential,
        libraryPrefix: resolved.prefix,
      });
      yield* scanLibrary({
        client,
        libraryType: resolved.libraryType,
        libraryId: resolved.libraryId,
        selectedCollectionKeys: resolved.selectedCollectionKeys,
        cursor: input.cursor as {
          committed?: { libraryVersion?: number; checkedAt?: number } | null;
        } | null,
        now,
        limits,
        logger,
      });
    } catch (error) {
      toAdapterError(error);
    } finally {
      await scope.close();
    }
  }

  return {
    capabilityId: "sourceweft/zotero",
    getManifest: toBackendZoteroManifest,
    credentialIdentity: zoteroCredentialIdentity,

    async checkSyncReadiness(
      input: ConnectorDiscoverInput,
    ): Promise<ConnectorSyncReadinessResult> {
      try {
        const resolved = resolveConfig(input.config);
        const credential = resolveCredential(
          input.accessToken,
          resolved.prefix,
        );
        const scope = credentialedFetch();
        try {
          const client = createZoteroClient({
            fetch: scope.fetch,
            credential,
            libraryPrefix: resolved.prefix,
          });
          const key = await client.keyInfo();
          if (resolved.libraryType === "user") {
            if (key.userId !== resolved.libraryId || !key.access.userLibrary) {
              return {
                ready: false,
                reason: "library_not_accessible",
                message: NOT_ACCESSIBLE_MESSAGE,
              };
            }
            return key.access.userNotes
              ? { ready: true, metadata: { notesAccess: true } }
              : {
                  ready: true,
                  message: NOTES_WARNING_MESSAGE,
                  metadata: { notesAccess: false },
                };
          }
          // A group key has no separate notes flag: readable library, readable notes.
          if (
            !key.access.groupsAll &&
            key.access.groups.get(resolved.libraryId) !== true
          ) {
            return {
              ready: false,
              reason: "library_not_accessible",
              message: NOT_ACCESSIBLE_MESSAGE,
            };
          }
          return { ready: true, metadata: { notesAccess: true } };
        } finally {
          await scope.close();
        }
      } catch (error) {
        const result = readinessFailure(error);
        if (result) return result;
        throw error;
      }
    },

    discover(input: ConnectorDiscoverInput) {
      return (async function* () {
        for await (const page of pages(input)) {
          for (const item of page.items) yield item;
        }
      })();
    },

    discoverPages(input: ConnectorDiscoverInput) {
      return pages(input);
    },

    extract(input: ConnectorExtractInput): Promise<ConnectorExtractedText> {
      return withClient(input.accessToken, input.config, ({ client }) =>
        extractZoteroItem({ client, item: input.item }),
      );
    },

    async executeAction(
      input: ConnectorActionInput,
    ): Promise<ConnectorActionResult> {
      if (input.actionType === "zotero.browse") {
        return {
          result: await withClient(
            input.accessToken,
            input.config,
            ({ client }) =>
              browseCollections({ client, request: input.request }),
          ),
        };
      }
      if (input.actionType === "zotero.describe") {
        return {
          result: await withClient(
            input.accessToken,
            input.config,
            ({ client }) =>
              describeCollections({ client, request: input.request }),
          ),
        };
      }
      throw new ZoteroAdapterError(
        400,
        "ZOTERO_UNSUPPORTED_ACTION",
        "Unsupported Zotero action",
      );
    },
  };
}
