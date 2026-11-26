import type {
  ConnectorActionInput,
  ConnectorActionResult,
  ConnectorAdapter,
  ConnectorCredentialInput,
  ConnectorDiscoverInput,
  ConnectorDiscoveryPage,
  ConnectorExtractInput,
  ConnectorExtractedContent,
  ConnectorSyncReadinessResult,
} from "@sourceweft/contracts";
import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import {
  mapWordPressError,
  readinessFailure,
  unsupportedActionError,
  WordPressAdapterError,
} from "./adapter-error";
import { toBackendWordPressManifest } from "./backend-manifest";
import {
  createWordPressClient,
  isNotFound,
  type ClientLimits,
  type WordPressClient,
} from "./client";
import { WORDPRESS_ID_PATTERN } from "./contribution";
import { WordPressError } from "./errors";
import { extractWordPressItem } from "./extract";
import {
  basicAuthorization,
  parseStoredCredential,
  wordPressCredentialIdentity,
} from "./identity";
import { ACTION_DEADLINE_MS, MAX_SELECTED_ITEMS } from "./limits";
import { toBackendWordPressLoginManifest } from "./login-backend-manifest";
import { scanSite, type ScanLimits } from "./scan";
import type { SelectionItem } from "./selection-scope";
import {
  browseSelection,
  describeSelection,
  searchSelection,
  type SelectionContext,
} from "./selection";
import { parseSiteUrl, siteHostOf } from "./site-url";

export { WordPressAdapterError } from "./adapter-error";

/** Limits a test may lower; all default to the package constants. The scan and
 * client limit shapes are disjoint (`MAX_REQUESTS` vs `maxRequests`), and
 * `ACTION_DEADLINE_MS` bounds one selection action or readiness check. */
export type WordPressAdapterLimits = Partial<
  ScanLimits & ClientLimits & { ACTION_DEADLINE_MS: number }
>;

type CommonInput = {
  logger?: { warn?(message: string, meta?: Record<string, unknown>): void };
  now?: () => number;
  limits?: WordPressAdapterLimits;
};

export type WordPressAdapterInput =
  | ({
      flavor: "public";
      /** A public-internet-only fetch scope; opened per operation, closed after. */
      publicFetch: () => ConnectorPublicFetchScope;
    } & CommonInput)
  | ({
      flavor: "login";
      /** A credentialed fetch scope (public HTTPS plus the deployment's allowed
       * private origins, cross-origin redirects refused); opened per operation. */
      credentialedFetch: () => ConnectorPublicFetchScope;
    } & CommonInput);

const ITEM_ID = new RegExp(WORDPRESS_ID_PATTERN);
const CONTENT_KINDS: ReadonlySet<string> = new Set([
  "type",
  "category",
  "post",
  "page",
]);

function configInvalid(): WordPressError {
  return new WordPressError("CONFIG_INVALID");
}

type ResolvedConfig = {
  /** The validated site base (see `parseSiteUrl`). */
  siteBase: string;
  /** The lower-case site host; every item's `link` must resolve to it. */
  siteHost: string;
  /** The kind-qualified selection (empty means everything). */
  selection: SelectionItem[];
  /** Login connector only; always false for the public connector. */
  includeUnpublished: boolean;
};

/**
 * Parses the non-secret config. The backend validator ignores `minItems`,
 * `maxItems` and uniqueness, so every bound is enforced here, and the `id`
 * prefix is checked against `kind` on every operation. A bad site address is
 * `SITE_URL_INVALID`; anything else malformed is `CONFIG_INVALID`; nothing of
 * the input is echoed. `includeUnpublished` exists on the login flavor only.
 */
function resolveConfig(
  config: Record<string, unknown>,
  login: boolean,
): ResolvedConfig {
  const siteBase = parseSiteUrl(
    typeof config.siteUrl === "string" ? config.siteUrl : "",
  );
  const siteHost = siteHostOf(siteBase);

  const items = config.items ?? [];
  if (!Array.isArray(items) || items.length > MAX_SELECTED_ITEMS) {
    throw configInvalid();
  }
  const selection: SelectionItem[] = [];
  const seen = new Set<string>();
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw configInvalid();
    }
    const { id, kind } = entry as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      !ITEM_ID.test(id) ||
      typeof kind !== "string" ||
      !CONTENT_KINDS.has(kind) ||
      // The kind must be the id's own prefix: a post number is never a category.
      id.slice(0, id.indexOf(":")) !== kind ||
      seen.has(id)
    ) {
      throw configInvalid();
    }
    seen.add(id);
    selection.push({ id, kind });
  }

  let includeUnpublished = false;
  if (login && config.includeUnpublished !== undefined) {
    if (typeof config.includeUnpublished !== "boolean") throw configInvalid();
    includeUnpublished = config.includeUnpublished;
  }
  return { siteBase, siteHost, selection, includeUnpublished };
}

export function createWordPressAdapter(
  input: WordPressAdapterInput,
): ConnectorAdapter {
  const login = input.flavor === "login";
  const openScope =
    input.flavor === "public" ? input.publicFetch : input.credentialedFetch;
  const allowWpcom = input.flavor === "public";
  const connectorId = login ? "wordpress_login" : "wordpress";
  const getManifest = login
    ? toBackendWordPressLoginManifest
    : toBackendWordPressManifest;
  const { logger, now, limits } = input;
  const deadlineMs = limits?.ACTION_DEADLINE_MS ?? ACTION_DEADLINE_MS;

  /** The stored credential as a Basic header, or undefined for the public
   * flavor. A malformed token is a credential failure before any request. */
  function authorizationFor(accessToken: string): string | undefined {
    if (!login) return undefined;
    return basicAuthorization(parseStoredCredential(accessToken));
  }

  function buildClient(
    scope: ConnectorPublicFetchScope,
    siteBase: string,
    authorization: string | undefined,
    signal: AbortSignal | undefined,
  ): WordPressClient {
    return createWordPressClient({
      fetch: scope.fetch,
      siteBase,
      allowWpcom,
      authorization,
      now,
      limits,
      signal,
    });
  }

  type Operation<T> = (context: {
    client: WordPressClient;
    resolved: ResolvedConfig;
  }) => Promise<T>;

  /**
   * Runs `operation` with a fresh client over a fresh fetch scope and closes the
   * scope afterwards, however the operation ends. The client's request ceiling
   * is per instance, so one client never spans two operations. `resolve` runs
   * before the scope opens, so invalid config or a rejected credential never
   * opens one. A `bounded` operation shares one wall-clock budget: aborting makes
   * the client fail with `SITE_UNREACHABLE`. WordPress-layer failures stay
   * {@link WordPressError}s here; callers decide how they cross the boundary.
   */
  async function useClient<T>(
    input2: { config: Record<string, unknown>; accessToken: string },
    operation: Operation<T>,
    options: { bounded?: boolean } = {},
  ): Promise<T> {
    const resolved = resolveConfig(input2.config, login);
    const authorization = authorizationFor(input2.accessToken);
    const scope = openScope();
    const controller = options.bounded ? new AbortController() : undefined;
    const timer =
      controller === undefined
        ? undefined
        : setTimeout(() => controller.abort(), deadlineMs);
    try {
      const client = buildClient(
        scope,
        resolved.siteBase,
        authorization,
        controller?.signal,
      );
      return await operation({ client, resolved });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await scope.close();
    }
  }

  async function withClient<T>(
    input2: { config: Record<string, unknown>; accessToken: string },
    operation: Operation<T>,
    options?: { bounded?: boolean },
  ): Promise<T> {
    try {
      return await useClient(input2, operation, options);
    } catch (error) {
      return mapWordPressError(error);
    }
  }

  async function* pages(
    input2: ConnectorDiscoverInput,
  ): AsyncGenerator<ConnectorDiscoveryPage> {
    let scope: ConnectorPublicFetchScope | undefined;
    try {
      const resolved = resolveConfig(input2.config, login);
      const authorization = authorizationFor(input2.accessToken);
      scope = openScope();
      const client = buildClient(
        scope,
        resolved.siteBase,
        authorization,
        undefined,
      );
      yield await scanSite({
        client,
        items: resolved.selection,
        includeUnpublished: resolved.includeUnpublished,
        siteHost: resolved.siteHost,
        now,
        limits,
        logger,
      });
    } catch (error) {
      mapWordPressError(error);
    } finally {
      await scope?.close();
    }
  }

  const selectionAction = (
    input2: ConnectorActionInput,
    run: (context: SelectionContext) => Promise<unknown>,
  ): Promise<ConnectorActionResult> =>
    withClient(
      input2,
      async ({ client, resolved }) => ({
        result: await run({
          client,
          request: input2.request,
          siteHost: resolved.siteHost,
          includeUnpublished: resolved.includeUnpublished,
        }),
      }),
      { bounded: true },
    ) as Promise<ConnectorActionResult>;

  const adapter: ConnectorAdapter = {
    capabilityId: "sourceweft/wordpress",
    getManifest,

    async checkSyncReadiness(
      input2: ConnectorDiscoverInput,
    ): Promise<ConnectorSyncReadinessResult> {
      try {
        return await useClient(
          input2,
          async ({ client, resolved }) => {
            // Discovery and the `wp/v2` namespace check, then a lightweight
            // published-posts probe (401/403 is a login wall). An empty
            // selection is valid: it means everything.
            await client.getIndex();
            const probe = await client.getJson("/wp/v2/posts", {
              per_page: 1,
              _fields: "id",
            });
            if (isNotFound(probe)) throw new WordPressError("BAD_RESPONSE");
            if (login) {
              const me = await client.getMe();
              if (
                resolved.includeUnpublished &&
                !(
                  me.capabilities.edit_posts ||
                  me.capabilities.read_private_posts
                )
              ) {
                throw new WordPressError("INSUFFICIENT_PERMISSION");
              }
            }
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

    discover(input2: ConnectorDiscoverInput) {
      return (async function* () {
        for await (const page of pages(input2)) {
          for (const item of page.items) yield item;
        }
      })();
    },

    discoverPages(input2: ConnectorDiscoverInput) {
      return pages(input2);
    },

    extract(input2: ConnectorExtractInput): Promise<ConnectorExtractedContent> {
      return withClient(input2, ({ client, resolved }) =>
        extractWordPressItem({
          client,
          externalId: input2.item.externalId,
          includeUnpublished: resolved.includeUnpublished,
          siteHost: resolved.siteHost,
        }),
      );
    },

    async executeAction(
      input2: ConnectorActionInput,
    ): Promise<ConnectorActionResult> {
      switch (input2.actionType) {
        case `${connectorId}.browse`:
          return selectionAction(input2, browseSelection);
        case `${connectorId}.search`:
          return selectionAction(input2, searchSelection);
        case `${connectorId}.describe`:
          return selectionAction(input2, describeSelection);
        default:
          throw unsupportedActionError();
      }
    },
  };

  if (login) {
    adapter.credentialIdentity = (
      config: Record<string, unknown>,
      credential: ConnectorCredentialInput,
    ): string => wordPressCredentialIdentity(config, credential);
  }
  return adapter;
}
