import type { ConnectorContribution } from "@sourceweft/capability-contracts";
import {
  ATLASSIAN_AUTHORIZATION_PARAMS,
  ATLASSIAN_AUTHORIZE_URL,
  ATLASSIAN_TOKEN_URL,
  CLOUD_ID_PATTERN,
} from "@sourceweft/atlassian-client";

/** OAuth scopes requested from Atlassian for Confluence: read access to
 * spaces, pages and the page search, with no attachment or write scope. */
export const CONFLUENCE_SCOPES = [
  "read:space:confluence",
  "read:page:confluence",
  "read:content-details:confluence",
  "read:me",
  "offline_access",
] as const;

/** Server-enforced ceiling on how many Confluence spaces and pages one
 * connector may select. Published to clients as the manifest's
 * `selection.maxItems`. */
export const CONFLUENCE_MAX_SELECTED_ITEMS = 100;

/** Shape of a Confluence site id: `site:<cloudId>`, browse-only, never stored
 * in a connector's selection. */
export const CONFLUENCE_SITE_ID_PATTERN = `^site:${CLOUD_ID_PATTERN}$`;

/** Shape of a Confluence space id this connector hands out or accepts back:
 * `space:<cloudId>:<numeric space id>`. Keep in sync with `ids.ts`. */
export const CONFLUENCE_SPACE_ID_PATTERN = `^space:${CLOUD_ID_PATTERN}:[0-9]{1,20}$`;

/** Shape of a Confluence page id this connector hands out or accepts back:
 * `page:<cloudId>:<numeric page id>`. Keep in sync with `ids.ts`. */
export const CONFLUENCE_PAGE_ID_PATTERN = `^page:${CLOUD_ID_PATTERN}:[0-9]{1,20}$`;

/** Either selectable item id: a stored selection holds spaces and pages. */
const CONFLUENCE_ITEM_ID_PATTERN = `^(space|page):${CLOUD_ID_PATTERN}:[0-9]{1,20}$`;

export const confluenceConnectorContribution = {
  id: "confluence",
  title: "Confluence",
  auth: {
    kind: "oauth2",
    authorizationUrl: ATLASSIAN_AUTHORIZE_URL,
    tokenUrl: ATLASSIAN_TOKEN_URL,
    scopes: [...CONFLUENCE_SCOPES],
    authorizationParams: { ...ATLASSIAN_AUTHORIZATION_PARAMS },
    sendScope: true,
  },
  sync: {
    supportsIncremental: false,
    defaultFrequencyMinutes: 360,
    // Tools-only connector: nothing is indexed. Typed explicitly so
    // `resources.map(...)` in backend-manifest.ts does not collapse to
    // `never[]` under the `as const` on this whole object.
    resources: [] as Array<{
      type: string;
      title: string;
      supportsDeleteDetection: boolean;
    }>,
  },
  actions: [
    {
      id: "confluence.browse",
      title: "Browse Confluence",
      description:
        "List Confluence sites, then the spaces within a site and the pages within a space or page, so the user can choose spaces and pages for this connector.",
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
            pattern: `${CONFLUENCE_SITE_ID_PATTERN}|${CONFLUENCE_SPACE_ID_PATTERN}|${CONFLUENCE_PAGE_ID_PATTERN}`,
          },
          cursor: {
            type: "string",
            maxLength: 4096,
          },
        },
      },
    },
    {
      id: "confluence.search",
      title: "Search Confluence",
      description:
        "Search Confluence space names and page titles so the user can choose spaces and pages for this connector.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "internal",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: 200,
          },
          cursor: {
            type: "string",
            maxLength: 4096,
          },
        },
      },
    },
    {
      id: "confluence.describe",
      title: "Describe Confluence items",
      description:
        "Return the name and existence of selected Confluence spaces and pages.",
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
            items: {
              type: "string",
              pattern: CONFLUENCE_ITEM_ID_PATTERN,
            },
          },
        },
      },
    },
    {
      id: "confluence.content.search",
      title: "Search Confluence pages",
      agentToolName: "search_confluence",
      description:
        "Search Confluence pages across the spaces and pages chosen in this connector's settings. Results are limited to that choice. Pass `cursor` from a prior result's `nextCursor` to continue. Cite the returned `url` for each page.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "agent",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "Words to search for in page titles and bodies.",
          },
          spaceKeys: {
            type: "array",
            maxItems: 20,
            items: {
              type: "string",
              pattern: "^[A-Za-z0-9_~.-]{1,255}$",
            },
            description:
              'Limit the search to these space keys (for example ["ENG"]). Use keys from list_confluence_spaces; a key that is not selected matches nothing.',
          },
          updatedWithinDays: {
            type: "integer",
            minimum: 1,
            maximum: 365,
            description: "Only pages updated in the last N days (1 to 365).",
          },
          cursor: {
            type: "string",
            maxLength: 4096,
            description:
              "Pass the previous result's nextCursor with the same other parameters to get the next page.",
          },
        },
      },
    },
    {
      id: "confluence.page.read",
      title: "Read Confluence page",
      agentToolName: "read_confluence_page",
      description:
        "Read one Confluence page by id, limited to the spaces and pages chosen in this connector's settings. Cite the returned `url`.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "agent",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["pageId"],
        properties: {
          pageId: {
            type: "string",
            pattern: `^(${CLOUD_ID_PATTERN}:)?[0-9]{1,20}$`,
            description:
              'The page id from a search result, for example "<cloudId>:123456", or a bare numeric page id.',
          },
        },
      },
    },
    {
      id: "confluence.space.list",
      title: "List Confluence spaces",
      agentToolName: "list_confluence_spaces",
      description:
        "List the Confluence spaces chosen in this connector's settings, and the spaces that hold the chosen pages.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "agent",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
  ],
  // The only configuration is the fixed set of Confluence space and page ids
  // the user picked, each tagged with its kind. Capped, deduplicated and
  // shape-checked so the server never has to trust an unbounded or malformed
  // selection from the client.
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        maxItems: CONFLUENCE_MAX_SELECTED_ITEMS,
        uniqueItems: true,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind"],
          properties: {
            id: {
              type: "string",
              pattern: CONFLUENCE_ITEM_ID_PATTERN,
            },
            kind: {
              type: "string",
              enum: ["space", "page"],
            },
          },
        },
      },
    },
    default: { items: [] },
  },
  selection: {
    actions: {
      browse: "confluence.browse",
      search: "confluence.search",
      describe: "confluence.describe",
    },
    kinds: ["site", "space", "page"],
    maxItems: CONFLUENCE_MAX_SELECTED_ITEMS,
  },
} as const satisfies ConnectorContribution;
