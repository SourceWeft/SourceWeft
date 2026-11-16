import type { ConnectorContribution } from "@sourceweft/capability-contracts";

/** OAuth scopes requested from Dropbox. Kept narrow: read-only account,
 * metadata and content access, nothing that can write or share. */
export const DROPBOX_SCOPES = [
  "account_info.read",
  "files.metadata.read",
  "files.content.read",
] as const;

/** Server-enforced ceiling on how many Dropbox files or folders one
 * connector may select. Keep in sync with the client-side selection limit
 * in apps/web/.../dropbox-selection.ts. */
export const DROPBOX_MAX_SELECTED_ITEMS = 500;

/** Discovery cap: past this many unique supported files, a run fails with
 * DROPBOX_SELECTION_TOO_LARGE instead of reconciling a partial selection. */
export const DROPBOX_MAX_FILES = 1000;

/** Shape of every Dropbox item id this connector hands out or accepts back:
 * the `id:` prefix from Dropbox's own file/folder ids. Keep in sync with the
 * pattern baked into dropbox.browse's `folderId`, dropbox.search's result
 * ids and dropbox.describe's `ids`. */
export const DROPBOX_ITEM_ID_PATTERN = "^id:[A-Za-z0-9_-]{1,200}$";

export const dropboxConnectorContribution = {
  id: "dropbox",
  title: "Dropbox",
  auth: {
    kind: "oauth2",
    authorizationUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    scopes: [...DROPBOX_SCOPES],
    authorizationParams: {
      token_access_type: "offline",
    },
    sendScope: true,
  },
  sync: {
    supportsIncremental: false,
    defaultFrequencyMinutes: 360,
    minFrequencyMinutes: 60,
    resources: [
      {
        type: "dropbox_file",
        title: "Dropbox file",
        supportsDeleteDetection: true,
      },
    ],
  },
  actions: [
    {
      id: "dropbox.browse",
      title: "Browse Dropbox",
      description:
        "List a Dropbox folder so the user can choose files and folders for this connector.",
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
            pattern: DROPBOX_ITEM_ID_PATTERN,
          },
          cursor: {
            type: "string",
            maxLength: 4096,
          },
        },
      },
    },
    {
      id: "dropbox.search",
      title: "Search Dropbox",
      description:
        "Search Dropbox file names so the user can choose files and folders for this connector.",
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
      id: "dropbox.describe",
      title: "Describe Dropbox items",
      description:
        "Return the name, path and existence of selected Dropbox items.",
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
              pattern: DROPBOX_ITEM_ID_PATTERN,
            },
          },
        },
      },
    },
  ],
  // Spec 3.4: the only configuration is the fixed set of Dropbox file/folder
  // ids the user picked, each tagged with its kind. Capped, deduplicated and
  // shape-checked so the server never has to trust an unbounded or malformed
  // selection from the client.
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        maxItems: DROPBOX_MAX_SELECTED_ITEMS,
        uniqueItems: true,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind"],
          properties: {
            id: {
              type: "string",
              pattern: DROPBOX_ITEM_ID_PATTERN,
            },
            kind: {
              type: "string",
              enum: ["file", "folder"],
            },
          },
        },
      },
    },
    default: { items: [] },
  },
  selection: {
    actions: {
      browse: "dropbox.browse",
      search: "dropbox.search",
      describe: "dropbox.describe",
    },
    kinds: ["folder", "file"],
    maxItems: DROPBOX_MAX_SELECTED_ITEMS,
  },
} as const satisfies ConnectorContribution;
