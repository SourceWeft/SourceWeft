import type { ConnectorContribution } from "@sourceweft/capability-contracts";
import { MAX_ROOTS } from "./limits";

/** Shape of a decoded WebDAV path the selection actions accept: absolute, no
 * control characters. `..` and `//` are normalized or refused by the adapter. */
export const WEBDAV_PATH_PATTERN = "^/[^\\u0000-\\u001F]{0,511}$";

/** Shape of the endpoint: http(s), no userinfo, query or fragment. https is
 * required unless the deployment allowlists the origin; the fetch scope, not
 * this pattern, enforces that. */
export const WEBDAV_ENDPOINT_PATTERN =
  "^https?://[^/?#@\\s]{1,253}(/[^?#\\s]{0,1790})?$";

export const webDavConnectorContribution = {
  id: "webdav",
  title: "WebDAV",
  // A username and an app password the member enters; stored encrypted as a
  // connector account and never part of the configuration below.
  auth: { kind: "credential", scheme: "basic" },
  sync: {
    supportsIncremental: false,
    defaultFrequencyMinutes: 360,
    minFrequencyMinutes: 60,
    resources: [
      {
        type: "webdav_file",
        title: "WebDAV file",
        supportsDeleteDetection: true,
      },
    ],
  },
  actions: [
    {
      id: "webdav.browse",
      title: "Browse WebDAV",
      description:
        "List the folders of a WebDAV collection so the user can choose root folders for this connector.",
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
            pattern: WEBDAV_PATH_PATTERN,
          },
        },
      },
    },
    {
      id: "webdav.describe",
      title: "Describe WebDAV folders",
      description:
        "Return the display name and existence of the selected WebDAV folders.",
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
            maxItems: MAX_ROOTS,
            items: {
              type: "string",
              pattern: WEBDAV_PATH_PATTERN,
            },
          },
        },
      },
    },
  ],
  // Non-secret configuration only: the base URL and the collections to index.
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["endpoint", "roots"],
    properties: {
      endpoint: {
        type: "string",
        pattern: WEBDAV_ENDPOINT_PATTERN,
      },
      roots: {
        type: "array",
        minItems: 1,
        maxItems: MAX_ROOTS,
        uniqueItems: true,
        items: {
          type: "string",
          pattern: WEBDAV_PATH_PATTERN,
        },
      },
    },
  },
  selection: {
    actions: {
      browse: "webdav.browse",
      describe: "webdav.describe",
    },
    kinds: ["folder"],
    maxItems: MAX_ROOTS,
  },
} as const satisfies ConnectorContribution;
