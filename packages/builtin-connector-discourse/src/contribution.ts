import type { ConnectorContribution } from "@sourceweft/capability-contracts";
import { MAX_SELECTED_ITEMS } from "./limits";

/**
 * A public forum base URL: https only, a DNS-style host (letters, digits, dots
 * and hyphens, so no userinfo, port, IPv6 literal, query or fragment) and an
 * optional subfolder path. The host's public fetch refuses private addresses at
 * request time; this pattern only fixes the shape.
 */
export const DISCOURSE_FORUM_URL_PATTERN =
  "^https://[A-Za-z0-9.-]{1,253}(/[A-Za-z0-9._~/-]{0,300})?$";

/** A Discourse category or topic id: a positive decimal of at most 10 digits. */
export const DISCOURSE_ID_PATTERN = "^[1-9][0-9]{0,9}$";

const itemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind"],
  properties: {
    id: { type: "string", pattern: DISCOURSE_ID_PATTERN },
    kind: { type: "string", enum: ["category", "topic"] },
  },
} as const;

export const discourseConnectorContribution = {
  id: "discourse",
  title: "Discourse forum",
  // Public forums only: no credential is stored or sent.
  auth: { kind: "none" },
  sync: {
    supportsIncremental: false,
    defaultFrequencyMinutes: 360,
    minFrequencyMinutes: 60,
    resources: [
      {
        type: "discourse_topic",
        title: "Forum topic",
        supportsDeleteDetection: true,
      },
    ],
  },
  actions: [
    {
      id: "discourse.browse",
      title: "Browse Discourse",
      description:
        "List the categories of a Discourse forum, or the topics of one category, so the user can choose what to index.",
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
            pattern: DISCOURSE_ID_PATTERN,
          },
          cursor: { type: "string", maxLength: 4096 },
        },
      },
    },
    {
      id: "discourse.search",
      title: "Search Discourse",
      description:
        "Search the topics of a Discourse forum so the user can choose which to index.",
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
      id: "discourse.describe",
      title: "Describe Discourse items",
      description:
        "Return the name, kind and existence of the selected Discourse categories and topics.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "internal",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: itemSchema,
          },
        },
      },
    },
  ],
  // Non-secret configuration only: the forum and what to index from it. An
  // empty `items` list indexes every public category. `uniqueItems` compares
  // whole objects, and an item holds only `id` and `kind`, so it is exactly
  // uniqueness by kind and id.
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["forumUrl"],
    properties: {
      forumUrl: { type: "string", pattern: DISCOURSE_FORUM_URL_PATTERN },
      items: {
        type: "array",
        default: [],
        maxItems: MAX_SELECTED_ITEMS,
        uniqueItems: true,
        items: itemSchema,
      },
      refresh: { type: "string", enum: ["light", "deep"], default: "light" },
    },
  },
  selection: {
    actions: {
      browse: "discourse.browse",
      search: "discourse.search",
      describe: "discourse.describe",
    },
    kinds: ["category", "topic"],
    maxItems: MAX_SELECTED_ITEMS,
  },
} as const satisfies ConnectorContribution;
