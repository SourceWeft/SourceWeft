import type { ConnectorContribution } from "@sourceweft/capability-contracts";

export const GOOGLE_DRIVE_FILE_SCOPE =
  "https://www.googleapis.com/auth/drive.file";

/** Server-enforced ceiling on how many Drive files one connector may select.
 * Keep in sync with GOOGLE_DRIVE_MAX_FILES in
 * apps/web/app/dashboard/chat/_components/sources-hub/connectors/google-drive-selection.ts. */
export const GOOGLE_DRIVE_MAX_FILES = 500;

export const googleDriveConnectorContribution = {
  id: "google_drive",
  title: "Google Drive",
  auth: {
    kind: "oauth2",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [GOOGLE_DRIVE_FILE_SCOPE],
    authorizationParams: {
      access_type: "offline",
      prompt: "consent",
    },
    sendScope: true,
  },
  sync: {
    supportsIncremental: false,
    defaultFrequencyMinutes: 360,
    minFrequencyMinutes: 60,
    resources: [
      {
        type: "google_drive_file",
        title: "Google Drive file",
        supportsDeleteDetection: true,
      },
    ],
  },
  actions: [
    {
      id: "google_drive.picker.config",
      title: "Google Drive picker configuration",
      description:
        "Return the configuration the Google Drive file picker needs so the user can select files for this connector.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "internal",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
  ],
  // Spec 3.3: the only configuration is the fixed set of Drive file IDs the
  // user picked. Capped, deduplicated, and shape-checked so the server never
  // has to trust an unbounded or malformed selection from the client.
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      fileIds: {
        type: "array",
        maxItems: GOOGLE_DRIVE_MAX_FILES,
        uniqueItems: true,
        items: {
          type: "string",
          // Keep in sync with FILE_ID in drive-client.ts.
          pattern: "^[A-Za-z0-9_-]{10,200}$",
        },
      },
    },
    default: { fileIds: [] },
  },
} as const satisfies ConnectorContribution;
