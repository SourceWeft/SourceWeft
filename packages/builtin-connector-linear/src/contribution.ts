import type { ConnectorContribution } from "@sourceweft/capability-contracts";

/** OAuth scopes requested from Linear. Read-only: nothing in this connector
 * writes to Linear or revokes access on disconnect. */
export const LINEAR_SCOPES = ["read"] as const;

/** Server-enforced ceiling on how many Linear teams or projects one
 * connector may select. Published to clients as the manifest's
 * `selection.maxItems` and enforced there by the shared web selection helpers
 * (apps/web/.../sources-hub/connectors/selection.ts). */
export const LINEAR_MAX_SELECTED_ITEMS = 100;

/** Shape of every Linear team/project id this connector hands out or accepts
 * back: Linear's UUID identifiers. Keep in sync with the pattern baked into
 * linear.browse's `containerId`, linear.search's result ids and
 * linear.describe's `ids`. */
export const LINEAR_ITEM_ID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

export const linearConnectorContribution = {
  id: "linear",
  title: "Linear",
  auth: {
    kind: "oauth2",
    authorizationUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: [...LINEAR_SCOPES],
    authorizationParams: {
      prompt: "consent",
    },
    sendScope: true,
  },
  sync: {
    supportsIncremental: false,
    defaultFrequencyMinutes: 360,
    // Tools-only connector: nothing is indexed, so there are no sync
    // resources. Explicitly typed (rather than a bare `[]`) so the empty
    // tuple `as const` would otherwise infer does not collapse the element
    // type to `never` for consumers that map over it (backend-manifest.ts).
    resources: [] as Array<{
      type: string;
      title: string;
      supportsDeleteDetection: boolean;
    }>,
  },
  actions: [
    {
      id: "linear.issue.search",
      title: "Search Linear issues",
      agentToolName: "search_linear_issues",
      description:
        "Search issues in the Linear teams and projects selected for this connector. Returns matching issues with state, assignee and link; read one issue for its description and comments.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "agent",
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1, maxLength: 200 },
          state: { type: "string", minLength: 1, maxLength: 100 },
          assignee: { type: "string", minLength: 1, maxLength: 100 },
          updatedWithinDays: { type: "integer", minimum: 1, maximum: 365 },
          cursor: { type: "string", maxLength: 4096 },
        },
      },
    },
    {
      id: "linear.issue.read",
      title: "Read Linear issue",
      agentToolName: "read_linear_issue",
      description:
        "Read one Linear issue by identifier (for example ENG-123), with description, labels, comments and link. Only issues inside the selected teams and projects can be read.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "agent",
      inputSchema: {
        type: "object",
        required: ["id"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64 },
        },
      },
    },
    {
      id: "linear.project.list",
      title: "List Linear projects",
      agentToolName: "list_linear_projects",
      description:
        "List the Linear projects inside the selected teams and projects, with status, lead, progress and link.",
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
    {
      id: "linear.browse",
      title: "Browse Linear",
      description:
        "List Linear teams and projects so the user can choose teams and projects for this connector.",
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
            pattern: LINEAR_ITEM_ID_PATTERN,
          },
          cursor: { type: "string", maxLength: 4096 },
        },
      },
    },
    {
      id: "linear.search",
      title: "Search Linear",
      description:
        "Search Linear team and project names so the user can choose teams and projects for this connector.",
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
        },
      },
    },
    {
      id: "linear.describe",
      title: "Describe Linear items",
      description:
        "Return the name, kind and existence of selected Linear teams and projects.",
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
              pattern: LINEAR_ITEM_ID_PATTERN,
            },
          },
        },
      },
    },
  ],
  // Spec 2.2 / R2: the only configuration is the fixed set of Linear
  // team/project ids the user picked, each tagged with its kind. There is no
  // `liveSearchEnabled` switch: a tools-only connector with live tools off
  // would do nothing, so the user stops the tools by pausing or deleting the
  // connector or by clearing the selection.
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        maxItems: LINEAR_MAX_SELECTED_ITEMS,
        uniqueItems: true,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind"],
          properties: {
            id: {
              type: "string",
              pattern: LINEAR_ITEM_ID_PATTERN,
            },
            kind: {
              type: "string",
              enum: ["team", "project"],
            },
          },
        },
      },
    },
    default: { items: [] },
  },
  selection: {
    actions: {
      browse: "linear.browse",
      search: "linear.search",
      describe: "linear.describe",
    },
    kinds: ["team", "project"],
    maxItems: LINEAR_MAX_SELECTED_ITEMS,
  },
} as const satisfies ConnectorContribution;
