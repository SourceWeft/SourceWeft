import type { ConnectorContribution } from "@sourceweft/capability-contracts";

/** GitHub's GraphQL node id for a repository. Covers legacy base64 ids
 * (e.g. `MDEwOlJlcG9zaXRvcnkx…`) and new-format ids (e.g. `R_kgDO…`). This is
 * the id every selected config item and every `github.describe` id uses. */
export const GITHUB_NODE_ID_PATTERN = "^[A-Za-z0-9_+/=-]{4,128}$";

/** Shape of a `github.browse` `containerId`: a GitHub App installation,
 * browsed to list the repositories it grants access to. */
export const GITHUB_INSTALLATION_CONTAINER_PATTERN = "^installation:[0-9]{1,20}$";

/** Server-enforced ceiling on how many repositories one connector may
 * select. Published to clients as the manifest's `selection.maxItems` and
 * also the cap on the `items` config array. */
export const GITHUB_MAX_SELECTED_REPOSITORIES = 20;

/** Shape of a repository's `owner/name` full name, as used in
 * `github.items.search`'s and `github.item.read`'s `repository` input. */
export const GITHUB_REPOSITORY_NAME_PATTERN =
  "^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$";

export const githubConnectorContribution = {
  id: "github",
  title: "GitHub",
  auth: {
    kind: "oauth2",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: [],
    authorizationParams: {},
    sendScope: false,
  },
  sync: {
    supportsIncremental: false,
    defaultFrequencyMinutes: 360,
    resources: [],
  },
  actions: [
    {
      id: "github.browse",
      title: "Browse GitHub",
      description:
        "List the GitHub App installations and their repositories so the user can choose repositories for this connector.",
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
            pattern: GITHUB_INSTALLATION_CONTAINER_PATTERN,
          },
          cursor: {
            type: "string",
            maxLength: 4096,
          },
        },
      },
    },
    {
      id: "github.search",
      title: "Search GitHub repositories",
      description:
        "Search the repositories across all of the user's GitHub App installations by name so the user can choose repositories for this connector.",
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
      id: "github.describe",
      title: "Describe GitHub repositories",
      description:
        "Return the name and existence of selected GitHub repositories.",
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
              pattern: GITHUB_NODE_ID_PATTERN,
            },
          },
        },
      },
    },
    {
      id: "github.items.search",
      title: "Search GitHub issues, pull requests and discussions",
      agentToolName: "search_github",
      description:
        "Search issues, pull requests or discussions (one type per call, issue by default) in the repositories chosen in the connector settings. Results cover only the repositories chosen in this connector's settings. `repository`, if given, must be one of those chosen repositories. Do not put `repo:`, `org:`, or `user:` qualifiers in `query` — results are already scoped to the chosen repositories. Returns metadata and links; read a selected item with `read_github_item` for its full body.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "agent",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description:
              "Words to search for. GitHub search qualifiers such as label:bug, in:title or author:name are allowed; repo:, org:, user: and owner: are not.",
            minLength: 1,
            maxLength: 120,
          },
          type: {
            type: "string",
            description:
              "What to search: issue (default), pull_request or discussion. One call searches one type.",
            enum: ["issue", "pull_request", "discussion"],
          },
          repository: {
            type: "string",
            description:
              "Limit the search to one of the selected repositories, as owner/name. Use it to reach repositories listed in skippedRepositories.",
            pattern: GITHUB_REPOSITORY_NAME_PATTERN,
          },
          state: {
            type: "string",
            description: "open or closed. Only for issue and pull_request.",
            enum: ["open", "closed"],
          },
          cursor: {
            type: "string",
            description:
              "Pass the previous result's nextCursor with the same other parameters to get the next page.",
            maxLength: 4096,
          },
        },
      },
    },
    {
      id: "github.item.read",
      title: "Read GitHub item",
      agentToolName: "read_github_item",
      description:
        "Read one issue, pull request, or discussion by repository, number, and type. `repository` must be one of the repositories chosen in this connector's settings. Returns the body and other details with a source link.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      visibility: "agent",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["repository", "number", "type"],
        properties: {
          repository: {
            type: "string",
            description: "One of the selected repositories, as owner/name.",
            pattern: GITHUB_REPOSITORY_NAME_PATTERN,
          },
          number: {
            type: "integer",
            description: "The issue, pull request or discussion number.",
            minimum: 1,
          },
          type: {
            type: "string",
            description:
              "issue, pull_request or discussion. issue and pull_request are interchangeable: the result says what the item is.",
            enum: ["issue", "pull_request", "discussion"],
          },
        },
      },
    },
    {
      id: "github.repositories.list",
      title: "List GitHub repositories",
      agentToolName: "list_github_repositories",
      description:
        "List the repositories chosen in this connector's settings.",
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
  // The only configuration is the fixed set of repository node ids the user
  // picked. Each is tagged "repository"; an "account" is only a browse
  // container to expand, never a selectable entry or a config item. Capped,
  // deduplicated and shape-checked so the server never has to trust an
  // unbounded or malformed selection from the client.
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        maxItems: GITHUB_MAX_SELECTED_REPOSITORIES,
        uniqueItems: true,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind"],
          properties: {
            id: {
              type: "string",
              pattern: GITHUB_NODE_ID_PATTERN,
            },
            kind: {
              type: "string",
              enum: ["repository"],
            },
          },
        },
      },
    },
    default: { items: [] },
  },
  selection: {
    actions: {
      browse: "github.browse",
      search: "github.search",
      describe: "github.describe",
    },
    kinds: ["account", "repository"],
    maxItems: GITHUB_MAX_SELECTED_REPOSITORIES,
  },
} as const satisfies ConnectorContribution;
