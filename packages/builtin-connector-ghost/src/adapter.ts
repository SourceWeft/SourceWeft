import type {
  ConnectorActionInput,
  ConnectorActionResult,
  ConnectorAdapter,
  ConnectorCredentialInput,
  ConnectorDiscoverInput,
  ConnectorDiscoveryPage,
  ConnectorExtractedContent,
  ConnectorExtractInput,
  ConnectorSyncReadinessResult,
} from "@sourceweft/contracts";
import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import {
  mapGhostError,
  readinessFailure,
  unsupportedActionError,
} from "./adapter-error";
import { toBackendGhostManifest } from "./backend-manifest";
import {
  createGhostClient,
  type ClientLimits,
  type GhostClient,
} from "./client";
import { GHOST_ID_PATTERN } from "./contribution";
import { GhostError } from "./errors";
import { extractGhostItem } from "./extract";
import {
  ghostCredentialIdentity,
  parseStoredCredential,
  type GhostCredential,
} from "./identity";
import { ACTION_DEADLINE_MS, MAX_SELECTED_ITEMS } from "./limits";
import { scanSite, type ScanLimits } from "./scan";
import type { SelectionItem } from "./selection-scope";
import {
  browseSelection,
  describeSelection,
  searchSelection,
  type SelectionContext,
} from "./selection";
import { parseSiteUrl, siteHostOf } from "./site-url";

export { GhostAdapterError } from "./adapter-error";

/** Limits a test may lower; all default to the package constants. The scan and
 * client limit shapes are disjoint (`MAX_REQUESTS` vs `maxRequests`), and
 * `ACTION_DEADLINE_MS` bounds one selection action or readiness check. */
export type GhostAdapterLimits = Partial<
  ScanLimits & ClientLimits & { ACTION_DEADLINE_MS: number }
>;

export type GhostAdapterInput = {
  /** The host's credentialed fetch scope (public HTTPS only, cross-origin
   * redirects refused). Opened per operation and closed when it finishes. */
  credentialedFetch: () => ConnectorPublicFetchScope;
  logger?: { warn?(message: string, meta?: Record<string, unknown>): void };
  /** Test seams. */
  now?: () => number;
  limits?: GhostAdapterLimits;
};

const ITEM_ID = new RegExp(GHOST_ID_PATTERN);
const ITEM_KINDS: ReadonlySet<string> = new Set([
  "type",
  "tag",
  "post",
  "page",
]);

const SCAN_WARNING_EVENT = "ghost_scan_warning";

type ResolvedConfig = {
  /** The validated site base (see `parseSiteUrl`). */
  siteBase: string;
  /** The lower-case site host recorded in every item's metadata. */
  siteHost: string;
  /** The kind-qualified selection (empty means everything). */
  selection: SelectionItem[];
};

/**
 * Parses the non-secret config. The backend validator ignores `minItems`,
 * `maxItems` and uniqueness, so every bound is enforced here, and the id prefix
 * is checked against `kind` on every operation (a post id is never a tag). A
 * bad site address is `SITE_URL_INVALID`; anything else malformed is
 * `CONFIG_INVALID`; nothing of the input is echoed.
 */
function resolveConfig(config: Record<string, unknown>): ResolvedConfig {
  const siteBase = parseSiteUrl(
    typeof config.siteUrl === "string" ? config.siteUrl : "",
  );
  const siteHost = siteHostOf(siteBase);

  const items = config.items ?? [];
  if (!Array.isArray(items) || items.length > MAX_SELECTED_ITEMS) {
    throw new GhostError("CONFIG_INVALID");
  }
  const selection: SelectionItem[] = [];
  const seen = new Set<string>();
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new GhostError("CONFIG_INVALID");
    }
    const { id, kind } = entry as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      !ITEM_ID.test(id) ||
      typeof kind !== "string" ||
      !ITEM_KINDS.has(kind) ||
      id.slice(0, id.indexOf(":")) !== kind ||
      seen.has(id)
    ) {
      throw new GhostError("CONFIG_INVALID");
    }
    seen.add(id);
    selection.push({ id, kind });
  }
  return { siteBase, siteHost, selection };
}

export function createGhostAdapter(input: GhostAdapterInput): ConnectorAdapter {
  const { credentialedFetch, logger, now, limits } = input;
  const deadlineMs = limits?.ACTION_DEADLINE_MS ?? ACTION_DEADLINE_MS;

  type Context = {
    client: GhostClient;
    resolved: ResolvedConfig;
    signal: AbortSignal;
  };

  /**
   * Resolves the config and the stored key, then opens a fresh scope and a
   * fresh client for one operation and closes the scope however it ends. The
   * client's request ceiling is per instance, so a client never spans two
   * operations. Config and credential are checked before a scope opens, so an
   * invalid one never touches the network. The operation's signal reaches the
   * client, so an abort cancels the request in flight; it fires when the
   * `bounded` deadline passes and, at the end, to stop anything an early exit
   * left behind. Failures stay {@link GhostError}s here; callers decide how
   * they cross the boundary.
   */
  async function useClient<T>(
    source: { config: Record<string, unknown>; accessToken: string },
    operation: (context: Context) => Promise<T>,
    options: { bounded?: boolean } = {},
  ): Promise<T> {
    const resolved = resolveConfig(source.config);
    const credential: GhostCredential = parseStoredCredential(
      source.accessToken,
    );
    const scope = credentialedFetch();
    const controller = new AbortController();
    const timer = options.bounded
      ? setTimeout(() => controller.abort(), deadlineMs)
      : undefined;
    try {
      const client = createGhostClient({
        fetch: scope.fetch,
        siteBase: resolved.siteBase,
        key: credential.secret,
        now,
        signal: controller.signal,
        limits,
      });
      return await operation({ client, resolved, signal: controller.signal });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      await scope.close();
    }
  }

  async function withClient<T>(
    source: { config: Record<string, unknown>; accessToken: string },
    operation: (context: Context) => Promise<T>,
    options?: { bounded?: boolean },
  ): Promise<T> {
    try {
      return await useClient(source, operation, options);
    } catch (error) {
      return mapGhostError(error);
    }
  }

  async function* pages(
    source: ConnectorDiscoverInput,
  ): AsyncGenerator<ConnectorDiscoveryPage> {
    let page: ConnectorDiscoveryPage;
    try {
      // The scan is one bounded read (its own caps and deadline); the page is
      // yielded after the scope is closed, so a slow consumer holds nothing.
      const scanned = await useClient(
        source,
        async ({ client, resolved, signal }) =>
          scanSite({
            client,
            items: resolved.selection,
            siteHost: resolved.siteHost,
            now,
            limits,
            signal,
          }),
      );
      // The contract has no field for notices: they are logged (fixed strings,
      // never the key or any site data) and only the page part is yielded.
      const { warnings, ...rest } = scanned;
      for (const warning of warnings) {
        logger?.warn?.(SCAN_WARNING_EVENT, { warning });
      }
      page = rest;
    } catch (error) {
      return mapGhostError(error);
    }
    yield page;
  }

  const selectionAction = (
    source: ConnectorActionInput,
    run: (context: SelectionContext) => Promise<unknown>,
  ): Promise<ConnectorActionResult> =>
    withClient(
      source,
      async ({ client }) => ({
        result: (await run({ client, request: source.request })) as Record<
          string,
          unknown
        >,
      }),
      { bounded: true },
    );

  return {
    capabilityId: "sourceweft/ghost",
    getManifest: toBackendGhostManifest,

    credentialIdentity(
      config: Record<string, unknown>,
      credential: ConnectorCredentialInput,
    ): string {
      try {
        return ghostCredentialIdentity(config, credential);
      } catch (error) {
        return mapGhostError(error);
      }
    },

    async checkSyncReadiness(
      source: ConnectorDiscoverInput,
    ): Promise<ConnectorSyncReadinessResult> {
      try {
        // The settings read proves a Ghost site, the key and the endpoint
        // policy. An empty selection is valid: it means everything.
        return await useClient(
          source,
          async ({ client }) => {
            await client.getSettings();
            return { ready: true };
          },
          { bounded: true },
        );
      } catch (error) {
        const result = readinessFailure(error);
        if (result) return result;
        throw error;
      }
    },

    discover(source: ConnectorDiscoverInput) {
      return (async function* () {
        for await (const page of pages(source)) {
          for (const item of page.items) yield item;
        }
      })();
    },

    discoverPages(source: ConnectorDiscoverInput) {
      return pages(source);
    },

    extract(source: ConnectorExtractInput): Promise<ConnectorExtractedContent> {
      return withClient(source, ({ client, resolved, signal }) =>
        extractGhostItem({
          client,
          externalId: source.item.externalId,
          siteHost: resolved.siteHost,
          signal,
        }),
      );
    },

    async executeAction(
      source: ConnectorActionInput,
    ): Promise<ConnectorActionResult> {
      switch (source.actionType) {
        case "ghost.browse":
          return selectionAction(source, browseSelection);
        case "ghost.search":
          return selectionAction(source, searchSelection);
        case "ghost.describe":
          return selectionAction(source, describeSelection);
        default:
          throw unsupportedActionError();
      }
    },
  };
}
