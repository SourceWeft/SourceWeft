import type { ConnectorContribution } from "@sourceweft/capability-contracts";
import { WEBDAV_ENDPOINT_PATTERN, WEBDAV_PATH_PATTERN } from "../contribution";
import { MAX_ROOTS } from "../limits";

/** Shape of a Nextcloud files user id carried in the non-secret config: no
 * control characters, 1..255 characters. It is informational for the shared
 * WebDAV code (which addresses the server through `endpoint`); the backend
 * uses it to rebuild the endpoint and to reject a reconnect that points at a
 * different files user. The login name and app password are never part of this
 * configuration. */
export const NEXTCLOUD_USER_ID_PATTERN = "^[^\\u0000-\\u001F]{1,255}$";

export const nextcloudConnectorContribution = {
  id: "nextcloud",
  title: "Nextcloud",
  // The login name and the app password Nextcloud issues through Login Flow v2;
  // stored encrypted as a connector account and never part of the configuration
  // below. The scheme is the same HTTP Basic the shared WebDAV client sends.
  auth: { kind: "credential", scheme: "basic" },
  sync: {
    supportsIncremental: false,
    defaultFrequencyMinutes: 360,
    minFrequencyMinutes: 60,
    resources: [
      {
        type: "nextcloud_file",
        title: "Nextcloud file",
        supportsDeleteDetection: true,
      },
    ],
  },
  actions: [
    {
      id: "nextcloud.browse",
      title: "Browse Nextcloud",
      description:
        "List the folders of a Nextcloud account so the user can choose root folders for this connector.",
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
      id: "nextcloud.describe",
      title: "Describe Nextcloud folders",
      description:
        "Return the display name and existence of the selected Nextcloud folders.",
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
  // Non-secret configuration only. `endpoint` is the per-user DAV base the
  // shared WebDAV code uses (origin-locked on update, as for WebDAV); `server`
  // is the Nextcloud base URL used only for canonical file links; `userId` is
  // the resolved files user id; `roots` are the collections to index.
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["server", "endpoint", "userId", "roots"],
    properties: {
      server: {
        type: "string",
        pattern: WEBDAV_ENDPOINT_PATTERN,
      },
      endpoint: {
        type: "string",
        pattern: WEBDAV_ENDPOINT_PATTERN,
      },
      userId: {
        type: "string",
        pattern: NEXTCLOUD_USER_ID_PATTERN,
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
      browse: "nextcloud.browse",
      describe: "nextcloud.describe",
    },
    kinds: ["folder"],
    maxItems: MAX_ROOTS,
  },
} as const satisfies ConnectorContribution;
