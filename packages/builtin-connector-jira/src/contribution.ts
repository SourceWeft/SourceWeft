import type { ConnectorContribution } from "@sourceweft/capability-contracts";
import {
  ATLASSIAN_AUTHORIZATION_PARAMS,
  ATLASSIAN_AUTHORIZE_URL,
  ATLASSIAN_TOKEN_URL,
  CLOUD_ID_PATTERN,
} from "@sourceweft/atlassian-client";

/** OAuth scopes requested from Atlassian for Jira (Global Constraints: no
 * attachment scope). */
export const JIRA_SCOPES = [
  "read:jira-work",
  "read:jira-user",
  "read:me",
  "offline_access",
] as const;

/** Server-enforced ceiling on how many Jira projects one connector may
 * select. Published to clients as the manifest's `selection.maxItems`. */
export const JIRA_MAX_SELECTED_ITEMS = 100;

/** Shape of a Jira site id: `site:<cloudId>`, browse-only, never stored in a
 * connector's selection (Global Constraints). */
export const JIRA_SITE_ID_PATTERN = `^site:${CLOUD_ID_PATTERN}$`;

/** Shape of a Jira project id this connector hands out or accepts back:
 * `project:<cloudId>:<numeric project id>` (Global Constraints). Keep in sync
 * with `ids.ts`. */
export const JIRA_PROJECT_ID_PATTERN = `^project:${CLOUD_ID_PATTERN}:[0-9]{1,20}$`;

export const jiraConnectorContribution = {
  id: "jira",
  title: "Jira",
  auth: {
    kind: "oauth2",
    authorizationUrl: ATLASSIAN_AUTHORIZE_URL,
    tokenUrl: ATLASSIAN_TOKEN_URL,
    scopes: [...JIRA_SCOPES],
    authorizationParams: { ...ATLASSIAN_AUTHORIZATION_PARAMS },
    sendScope: true,
  },
  sync: {
    supportsIncremental: false,
    defaultFrequencyMinutes: 360,
    // Tools-only connector (Global Constraints): nothing is indexed. Typed
    // explicitly so `resources.map(...)` in backend-manifest.ts does not
    // collapse to `never[]` under the `as const` on this whole object.
    resources: [] as Array<{
      type: string;
      title: string;
      supportsDeleteDetection: boolean;
    }>,
  },
  actions: [
    {
      id: "jira.browse",
      title: "Browse Jira",
      description:
        "List Jira sites, then the projects within a site, so the user can choose projects for this connector.",
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
            pattern: JIRA_SITE_ID_PATTERN,
          },
          cursor: {
            type: "string",
            maxLength: 4096,
          },
        },
      },
    },
    {
      id: "jira.search",
      title: "Search Jira",
      description:
        "Search Jira project names so the user can choose projects for this connector.",
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
        },
      },
    },
    {
      id: "jira.describe",
      title: "Describe Jira items",
      description: "Return the name and existence of selected Jira projects.",
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
              pattern: JIRA_PROJECT_ID_PATTERN,
            },
          },
        },
      },
    },
    {
      id: "jira.issue.search",
      title: "Search Jira issues",
      agentToolName: "search_jira_issues",
      description:
        "Search Jira issues across the projects chosen in this connector's settings. Results are limited to those projects. Pass `cursor` from a prior result's `nextCursor` to continue. Cite the returned `url` for each issue.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "agent",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", minLength: 1, maxLength: 200 },
          projectKeys: {
            type: "array",
            maxItems: 20,
            items: {
              type: "string",
              pattern: "^[A-Z][A-Z0-9_]{0,31}$",
            },
          },
          status: { type: "string", minLength: 1, maxLength: 100 },
          assignee: { type: "string", minLength: 1, maxLength: 200 },
          issueType: { type: "string", minLength: 1, maxLength: 100 },
          updatedWithinDays: { type: "integer", minimum: 1, maximum: 365 },
          orderBy: {
            type: "string",
            enum: ["updated", "created", "priority"],
          },
          cursor: { type: "string", maxLength: 4096 },
        },
      },
    },
    {
      id: "jira.issue.read",
      title: "Read Jira issue",
      agentToolName: "read_jira_issue",
      description:
        "Read one Jira issue by key, limited to the projects chosen in this connector's settings. Cite the returned `url`.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "agent",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["issueKey"],
        properties: {
          issueKey: { type: "string", minLength: 1, maxLength: 64 },
        },
      },
    },
    {
      id: "jira.project.list",
      title: "List Jira projects",
      agentToolName: "list_jira_projects",
      description:
        "List the Jira projects chosen in this connector's settings.",
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
  // Global Constraints 2.2: the only configuration is the fixed set of Jira
  // project ids the user picked, each tagged with its kind. Capped,
  // deduplicated and shape-checked so the server never has to trust an
  // unbounded or malformed selection from the client.
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        maxItems: JIRA_MAX_SELECTED_ITEMS,
        uniqueItems: true,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind"],
          properties: {
            id: {
              type: "string",
              pattern: JIRA_PROJECT_ID_PATTERN,
            },
            kind: {
              type: "string",
              enum: ["project"],
            },
          },
        },
      },
    },
    default: { items: [] },
  },
  selection: {
    actions: {
      browse: "jira.browse",
      search: "jira.search",
      describe: "jira.describe",
    },
    kinds: ["site", "project"],
    maxItems: JIRA_MAX_SELECTED_ITEMS,
  },
} as const satisfies ConnectorContribution;
