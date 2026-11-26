import type { ConnectorContribution } from "@sourceweft/capability-contracts";
import { MAX_SELECTED_COLLECTIONS } from "./limits";

/** A Zotero library id: a positive decimal number of at most 12 digits. */
export const ZOTERO_LIBRARY_ID_PATTERN = "^[1-9][0-9]{0,11}$";

/** A Zotero collection or item key: eight characters of A-Z and 0-9. */
export const ZOTERO_KEY_PATTERN = "^[A-Z0-9]{8}$";

export const zoteroConnectorContribution = {
  id: "zotero",
  title: "Zotero",
  // A Zotero API key the member enters; stored encrypted as a connector
  // account and never part of the configuration below.
  auth: { kind: "credential", scheme: "api_key" },
  sync: {
    supportsIncremental: false,
    defaultFrequencyMinutes: 360,
    minFrequencyMinutes: 60,
    resources: [
      {
        type: "zotero_item",
        title: "Zotero item",
        supportsDeleteDetection: true,
      },
    ],
  },
  actions: [
    {
      id: "zotero.browse",
      title: "Browse Zotero",
      description:
        "List the collections of a Zotero library so the user can choose which to index.",
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
            pattern: ZOTERO_KEY_PATTERN,
          },
          cursor: { type: "string", maxLength: 4096 },
        },
      },
    },
    {
      id: "zotero.describe",
      title: "Describe Zotero collections",
      description:
        "Return the display name and existence of the selected Zotero collections.",
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
            maxItems: MAX_SELECTED_COLLECTIONS,
            items: {
              type: "string",
              pattern: ZOTERO_KEY_PATTERN,
            },
          },
        },
      },
    },
  ],
  // Non-secret configuration only: the library and the collections to index.
  // An empty `items` list indexes the whole library.
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["libraryType", "libraryId"],
    properties: {
      libraryType: { type: "string", enum: ["user", "group"] },
      libraryId: { type: "string", pattern: ZOTERO_LIBRARY_ID_PATTERN },
      items: {
        type: "array",
        default: [],
        maxItems: MAX_SELECTED_COLLECTIONS,
        uniqueItems: true,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind"],
          properties: {
            id: { type: "string", pattern: ZOTERO_KEY_PATTERN },
            kind: { type: "string", enum: ["collection"] },
          },
        },
      },
    },
  },
  selection: {
    actions: {
      browse: "zotero.browse",
      describe: "zotero.describe",
    },
    kinds: ["collection"],
    maxItems: MAX_SELECTED_COLLECTIONS,
  },
} as const satisfies ConnectorContribution;
