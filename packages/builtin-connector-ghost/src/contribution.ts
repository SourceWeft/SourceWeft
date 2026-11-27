import type { ConnectorContribution } from "@sourceweft/capability-contracts";
import { MAX_SELECTED_ITEMS } from "./limits";

/**
 * A Ghost site base URL: https only, a DNS-style host (letters, digits, dots
 * and hyphens, so no userinfo, port, IPv6 literal, query or fragment) and an
 * optional subfolder path. The host's fetch refuses private addresses at
 * request time; this pattern only fixes the shape.
 *
 * The pattern still admits shapes that the site URL parser must reject: IPv4,
 * decimal numeric hosts, `localhost`, empty or malformed labels, `.` and `..`
 * path segments, and `//` inside the path.
 */
export const GHOST_SITE_URL_PATTERN =
  "^https://[A-Za-z0-9.-]{1,253}(/[A-Za-z0-9._~/-]{0,300})?$";

/**
 * A selection id is kind-qualified: `type:post`, `type:page`, `tag:<id>`,
 * `post:<id>` or `page:<id>`, because post, page and tag ids collide in
 * meaning. `<id>` is a Ghost object id: 24 lower-case hex characters. An
 * item's separate `kind` must equal the id prefix (the adapter checks that).
 */
export const GHOST_ID_PATTERN =
  "^(type:(post|page)|tag:[0-9a-f]{24}|(post|page):[0-9a-f]{24})$";

export const ghostConnectorContribution = {
  id: "ghost",
  title: "Ghost",
  // A Ghost Content API key the member enters; stored encrypted as a connector
  // account and never part of the configuration below.
  auth: { kind: "credential", scheme: "api_key" },
  sync: {
    supportsIncremental: false,
    defaultFrequencyMinutes: 360,
    minFrequencyMinutes: 60,
    resources: [
      {
        type: "ghost_content",
        title: "Post or page",
        supportsDeleteDetection: true,
      },
    ],
  },
  actions: [
    {
      id: "ghost.browse",
      title: "Browse Ghost",
      description:
        "List the content types and tags of a Ghost site so the user can choose what to index.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "internal",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          // Tags are flat below the root: there is no container to open.
          containerId: { type: "null" },
          cursor: { type: "string", maxLength: 4096 },
        },
      },
    },
    {
      id: "ghost.search",
      title: "Search Ghost",
      description:
        "Search the posts and pages of a Ghost site by title so the user can choose which to index.",
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
      id: "ghost.describe",
      title: "Describe Ghost items",
      description:
        "Return the name, kind and existence of the selected Ghost content types, tags, posts and pages, identified by kind-qualified ids such as type:post or tag:<id>.",
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
            items: { type: "string", pattern: GHOST_ID_PATTERN },
          },
        },
      },
    },
  ],
  // Non-secret configuration only: the site and what to index from it. An
  // empty `items` list indexes every published post and page.
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["siteUrl"],
    properties: {
      siteUrl: { type: "string", pattern: GHOST_SITE_URL_PATTERN },
      items: {
        type: "array",
        default: [],
        maxItems: MAX_SELECTED_ITEMS,
        uniqueItems: true,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind"],
          properties: {
            id: { type: "string", pattern: GHOST_ID_PATTERN },
            kind: { type: "string", enum: ["type", "tag", "post", "page"] },
          },
        },
      },
    },
  },
  selection: {
    actions: {
      browse: "ghost.browse",
      search: "ghost.search",
      describe: "ghost.describe",
    },
    kinds: ["type", "tag", "post", "page"],
    maxItems: MAX_SELECTED_ITEMS,
  },
} as const satisfies ConnectorContribution;
