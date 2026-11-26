import type { ConnectorContribution } from "@sourceweft/capability-contracts";
import { MAX_SELECTED_ITEMS } from "./limits";

/**
 * A WordPress site base URL: https only, a DNS-style host (letters, digits,
 * dots and hyphens, so no userinfo, port, IPv6 literal, query or fragment) and
 * an optional subfolder path. The host's fetch refuses private addresses at
 * request time; this pattern only fixes the shape.
 *
 * The pattern still admits shapes that the site URL parser must reject: IPv4,
 * decimal and hex numeric hosts, `localhost`, empty or malformed labels, `.`
 * and `..` path segments, and `//` inside the path.
 */
export const WORDPRESS_SITE_URL_PATTERN =
  "^https://[A-Za-z0-9.-]{1,253}(/[A-Za-z0-9._~/-]{0,300})?$";

/**
 * A selection id is kind-qualified: `type:post`, `type:page`, `category:<n>`,
 * `post:<n>` or `page:<n>`, because post, page and category numbers collide.
 * `<n>` is a positive decimal of at most 10 digits. An item's separate `kind`
 * must equal the id prefix (the adapter checks that).
 */
export const WORDPRESS_ID_PATTERN =
  "^(type:(post|page)|(category|post|page):[1-9][0-9]{0,9})$";

/** A browse container is always a category. */
export const WORDPRESS_CATEGORY_ID_PATTERN = "^category:[1-9][0-9]{0,9}$";

const itemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind"],
  properties: {
    id: { type: "string", pattern: WORDPRESS_ID_PATTERN },
    kind: { type: "string", enum: ["type", "category", "post", "page"] },
  },
} as const;

/** The `items` property shared by both configuration schemas. `uniqueItems`
 * compares whole objects, and an item holds only `id` and `kind`, so it is
 * exactly uniqueness by id. An empty list is not "nothing": it means every
 * published post and page (see `resolveScope`), and readiness treats it as
 * ready. */
export const wordpressItemsSchema = {
  type: "array",
  default: [],
  maxItems: MAX_SELECTED_ITEMS,
  uniqueItems: true,
  items: itemSchema,
} as const;

export const wordpressSiteUrlSchema = {
  type: "string",
  pattern: WORDPRESS_SITE_URL_PATTERN,
} as const;

/** The three selection actions, identical for both connectors apart from the
 * id prefix and the site wording. */
export function wordpressActions<const Id extends string>(id: Id) {
  return [
    {
      id: `${id}.browse` as const,
      title: "Browse WordPress",
      description:
        "List the content types and categories of a WordPress site, or the posts and pages of one category, so the user can choose what to index.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "internal",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          containerId: {
            type: ["string", "null"],
            pattern: WORDPRESS_CATEGORY_ID_PATTERN,
          },
          cursor: { type: "string", maxLength: 4096 },
        },
      },
    },
    {
      id: `${id}.search` as const,
      title: "Search WordPress",
      description:
        "Search the posts and pages of a WordPress site so the user can choose which to index.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "internal",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 200 },
          cursor: { type: "string", maxLength: 4096 },
        },
      },
    },
    {
      id: `${id}.describe` as const,
      title: "Describe WordPress items",
      description:
        "Return the name, kind and existence of the selected WordPress content types, categories, posts and pages, identified by kind-qualified ids such as type:post, category:3 or post:9.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "internal",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["ids"],
        properties: {
          ids: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: { type: "string", pattern: WORDPRESS_ID_PATTERN },
          },
        },
      },
    },
  ] as const satisfies ConnectorContribution["actions"];
}

export function wordpressSelection<const Id extends string>(id: Id) {
  return {
    actions: {
      browse: `${id}.browse` as const,
      search: `${id}.search` as const,
      describe: `${id}.describe` as const,
    },
    kinds: ["type", "category", "post", "page"],
    maxItems: MAX_SELECTED_ITEMS,
  } as const satisfies NonNullable<ConnectorContribution["selection"]>;
}

// Shared pieces are checked with `as const satisfies` against the contribution
// field types so their arrays stay mutable tuples, as in an inline contribution.
export function wordpressSync() {
  return {
    supportsIncremental: false,
    defaultFrequencyMinutes: 360,
    minFrequencyMinutes: 60,
    resources: [
      {
        type: "wordpress_content",
        title: "Post or page",
        supportsDeleteDetection: true,
      },
    ],
  } as const satisfies ConnectorContribution["sync"];
}

/** A public WordPress site read through the REST API: no credential is stored
 * or sent. */
export const wordpressConnectorContribution = {
  id: "wordpress",
  title: "WordPress site",
  auth: { kind: "none" },
  sync: wordpressSync(),
  actions: wordpressActions("wordpress"),
  // Non-secret configuration only: the site and what to index from it.
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["siteUrl"],
    properties: {
      siteUrl: wordpressSiteUrlSchema,
      items: wordpressItemsSchema,
    },
  },
  selection: wordpressSelection("wordpress"),
} as const satisfies ConnectorContribution;
