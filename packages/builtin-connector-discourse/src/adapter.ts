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
import { DiscourseAdapterError, toAdapterError } from "./adapter-error";
import { toBackendDiscourseManifest } from "./backend-manifest";
import {
  createDiscourseClient,
  type ClientLimits,
  type DiscourseClient,
} from "./client";
import { DISCOURSE_ID_PATTERN } from "./contribution";
import { DiscourseError, type DiscourseErrorCode } from "./errors";
import { extractDiscourseTopic } from "./extract";
import { parseForumUrl } from "./forum-url";
import { ACTION_DEADLINE_MS, MAX_SELECTED_ITEMS } from "./limits";
import { buildCategoryTree, type RefreshMode } from "./model";
import { scanForum, type ScanLimits, type ScanSelection } from "./scan";
import { browseForum, describeForum, searchForum } from "./selection";

export { DiscourseAdapterError } from "./adapter-error";

export type DiscourseAdapterInput = {
  /** A public-internet-only fetch scope. Opened per operation and closed
   * when the operation finishes. */
  publicFetch: () => ConnectorPublicFetchScope;
  logger?: { warn?(message: string, meta?: Record<string, unknown>): void };
  /** Test seams. */
  limits?: Partial<ScanLimits & ClientLimits & { ACTION_DEADLINE_MS: number }>;
  now?: () => number;
};

const ITEM_ID = new RegExp(DISCOURSE_ID_PATTERN);

type ResolvedConfig = {
  /** The validated forum base (see `parseForumUrl`). */
  base: string;
  selection: ScanSelection;
  refresh: RefreshMode;
};

const configInvalid = (): DiscourseError =>
  new DiscourseError("DISCOURSE_CONFIG_INVALID");

/** The forum address alone: what the selection actions need. */
function resolveForumBase(config: Record<string, unknown>): string {
  const parsed = parseForumUrl(config.forumUrl);
  if (parsed === null) throw configInvalid();
  return parsed.base;
}

/**
 * Parses the non-secret config. The backend validator ignores `minItems`,
 * `maxItems` and string lengths, so every bound is enforced here. Anything
 * malformed is `DISCOURSE_CONFIG_INVALID`; nothing of the input is echoed.
 */
function resolveConfig(config: Record<string, unknown>): ResolvedConfig {
  const base = resolveForumBase(config);
  const items = config.items ?? [];
  if (!Array.isArray(items) || items.length > MAX_SELECTED_ITEMS) {
    throw configInvalid();
  }
  const selection: ScanSelection = [];
  const seen = new Set<string>();
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw configInvalid();
    }
    const { id, kind } = entry as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      !ITEM_ID.test(id) ||
      (kind !== "category" && kind !== "topic") ||
      // The kind must be the id's own prefix: a topic number is never a
      // category number.
      !id.startsWith(`${kind}:`) ||
      seen.has(id)
    ) {
      throw configInvalid();
    }
    seen.add(id);
    selection.push({ id: Number(id.slice(kind.length + 1)), kind });
  }
  const refresh = config.refresh ?? "light";
  if (refresh !== "light" && refresh !== "deep") throw configInvalid();
  return { base, selection, refresh };
}

const READINESS_REASONS: Record<DiscourseErrorCode, string> = {
  DISCOURSE_LOGIN_REQUIRED: "login_required",
  DISCOURSE_NOT_A_DISCOURSE_SITE: "not_a_discourse_site",
  DISCOURSE_FORUM_UNREACHABLE: "forum_unreachable",
  DISCOURSE_BLOCKED_ENDPOINT: "blocked_endpoint",
  DISCOURSE_RATE_LIMITED: "rate_limited",
  DISCOURSE_BAD_RESPONSE: "forum_unreachable",
  DISCOURSE_TOO_LARGE: "forum_unreachable",
  DISCOURSE_FORUM_URL_INVALID: "config_invalid",
  DISCOURSE_CONFIG_INVALID: "config_invalid",
  DISCOURSE_SELECTION_REQUIRED: "selection_required",
};

/** A not-ready readiness result for a Discourse-layer error, or null when the
 * error is not one this adapter can explain (it then bubbles up). */
function readinessFailure(error: unknown): ConnectorSyncReadinessResult | null {
  if (!(error instanceof DiscourseError)) return null;
  return {
    ready: false,
    reason: READINESS_REASONS[error.code],
    message: error.message,
  };
}

export function createDiscourseAdapter(
  adapterInput: DiscourseAdapterInput,
): ConnectorAdapter {
  const { publicFetch, logger, limits, now } = adapterInput;

  /**
   * Runs `operation` with a fresh client over a fresh public-fetch scope and
   * closes the scope afterwards, however the operation ends. The client's
   * request ceiling is per instance, so one client never spans more than one
   * discovery, extraction, readiness check or action. `resolve` runs before
   * the scope opens, so invalid input never opens one. Failures stay
   * {@link DiscourseError}s here; the callers decide how they cross the
   * boundary.
   */
  async function useClient<C, T>(
    resolve: () => C,
    base: (resolved: C) => string,
    operation: (context: {
      client: DiscourseClient;
      resolved: C;
    }) => Promise<T>,
    options: { bounded?: boolean } = {},
  ): Promise<T> {
    const resolved = resolve();
    const scope = publicFetch();
    // A selection action or readiness check ends within one wall-clock
    // budget, however many requests it makes; aborting makes the client fail
    // with DISCOURSE_FORUM_UNREACHABLE.
    const controller = options.bounded ? new AbortController() : undefined;
    const timer =
      controller === undefined
        ? undefined
        : setTimeout(
            () => controller.abort(),
            limits?.ACTION_DEADLINE_MS ?? ACTION_DEADLINE_MS,
          );
    try {
      const client = createDiscourseClient({
        fetch: scope.fetch,
        base: base(resolved),
        limits,
        signal: controller?.signal,
      });
      return await operation({ client, resolved });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await scope.close();
    }
  }

  async function withClient<C, T>(
    resolve: () => C,
    base: (resolved: C) => string,
    operation: (context: {
      client: DiscourseClient;
      resolved: C;
    }) => Promise<T>,
    options?: { bounded?: boolean },
  ): Promise<T> {
    try {
      return await useClient(resolve, base, operation, options);
    } catch (error) {
      return toAdapterError(error);
    }
  }

  async function* pages(
    input: ConnectorDiscoverInput,
  ): AsyncGenerator<ConnectorDiscoveryPage> {
    let scope: ConnectorPublicFetchScope | undefined;
    try {
      const resolved = resolveConfig(input.config);
      scope = publicFetch();
      const client = createDiscourseClient({
        fetch: scope.fetch,
        base: resolved.base,
        limits,
      });
      yield* scanForum({
        client,
        base: resolved.base,
        selection: resolved.selection,
        refresh: resolved.refresh,
        now,
        limits,
        logger,
      });
    } catch (error) {
      toAdapterError(error);
    } finally {
      await scope?.close();
    }
  }

  const forumAction = (
    input: ConnectorActionInput,
    run: (context: {
      client: DiscourseClient;
      request: Record<string, unknown>;
    }) => Promise<unknown>,
  ): Promise<ConnectorActionResult> =>
    withClient(
      () => resolveForumBase(input.config),
      (base) => base,
      async ({ client }) => ({
        result: await run({ client, request: input.request }),
      }),
      { bounded: true },
    ) as Promise<ConnectorActionResult>;

  return {
    capabilityId: "sourceweft/discourse",
    getManifest: toBackendDiscourseManifest,

    async checkSyncReadiness(
      input: ConnectorDiscoverInput,
    ): Promise<ConnectorSyncReadinessResult> {
      try {
        return await useClient(
          () => resolveConfig(input.config),
          (resolved) => resolved.base,
          async ({ client, resolved }) => {
            // The forum is checked first: an empty selection is valid config,
            // and only a reachable Discourse forum can ask for a selection.
            const { categories } = await client.site();
            const tree = buildCategoryTree(categories);
            const categoryCount = new Set(
              categories
                .filter((category) => !tree.isRestricted(category.id))
                .map((category) => category.id),
            ).size;
            if (resolved.selection.length === 0) {
              return {
                ready: false,
                reason: "selection_required",
                message: new DiscourseError("DISCOURSE_SELECTION_REQUIRED")
                  .message,
                metadata: { categoryCount },
              };
            }
            return { ready: true, metadata: { categoryCount } };
          },
          { bounded: true },
        );
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
      return withClient(
        () => resolveConfig(input.config),
        (config) => config.base,
        ({ client, resolved }) =>
          extractDiscourseTopic({
            client,
            base: resolved.base,
            item: input.item,
            refresh: resolved.refresh,
          }),
      );
    },

    async executeAction(
      input: ConnectorActionInput,
    ): Promise<ConnectorActionResult> {
      switch (input.actionType) {
        case "discourse.browse":
          return forumAction(input, browseForum);
        case "discourse.search":
          return forumAction(input, searchForum);
        case "discourse.describe":
          return forumAction(input, describeForum);
        default:
          throw new DiscourseAdapterError(
            400,
            "DISCOURSE_UNSUPPORTED_ACTION",
            "Unsupported Discourse action",
          );
      }
    },
  };
}
