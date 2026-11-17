// Jira REST client on top of `@sourceweft/atlassian-client`'s product-scoped
// request wrapper. Every endpoint, parameter name and response shape here
// was checked against Atlassian's own Jira Cloud platform REST API v3
// reference before this file was written (see the task report's "Endpoint
// verification" section).

import {
  atlassianRequest,
  AtlassianApiError,
  type AtlassianClientConfig,
} from "@sourceweft/atlassian-client";

export type JiraProject = {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string | null;
  leadName: string | null;
};

export type JiraIssueSummary = {
  id: string;
  key: string;
  projectId: string | null;
  projectKey: string | null;
  projectName: string | null;
  summary: string;
  status: string | null;
  issueType: string | null;
  priority: string | null;
  assignee: string | null;
  updated: string | null;
};

export type JiraIssueDetail = JiraIssueSummary & {
  reporter: string | null;
  labels: string[];
  created: string | null;
  description: unknown;
};

export type JiraComment = {
  author: string | null;
  created: string | null;
  body: unknown;
};

/** `fields` sent to `POST /rest/api/3/search/jql` (verified: by default this
 * endpoint returns only `id`, unlike `GET issue`, so the fields a summary
 * needs must be requested explicitly). */
const ISSUE_SEARCH_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "updated",
  "project",
] as const;

/** `fields` sent to `GET /rest/api/3/issue/{issueIdOrKey}`. */
const ISSUE_GET_FIELDS =
  "summary,status,issuetype,priority,assignee,reporter,labels,created,updated,description,project";

/** `GET /rest/api/3/project/search` accepts at most 50 repeated `id`
 * parameters per request (verified against the documented limit). */
const PROJECT_ID_CHUNK_SIZE = 50;

/** Like Gmail's `safeString`: truncates a string, or returns `null` for
 * anything that is not a string (a provider response that drops or
 * reshapes a field never throws here). */
function safeString(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function safeStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const str = safeString(item, max);
    if (str !== null) result.push(str);
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

function toProject(raw: unknown): JiraProject {
  const value = asRecord(raw);
  const lead = asRecord(value.lead);
  return {
    id: safeString(value.id, 64) ?? "",
    key: safeString(value.key, 64) ?? "",
    name: safeString(value.name, 512) ?? "",
    projectTypeKey: safeString(value.projectTypeKey, 64),
    leadName: safeString(lead.displayName, 512),
  };
}

function toIssueSummary(raw: unknown): JiraIssueSummary {
  const value = asRecord(raw);
  const fields = asRecord(value.fields);
  const project = asRecord(fields.project);
  const status = asRecord(fields.status);
  const issueType = asRecord(fields.issuetype);
  const priority = asRecord(fields.priority);
  const assignee = asRecord(fields.assignee);
  return {
    id: safeString(value.id, 64) ?? "",
    key: safeString(value.key, 64) ?? "",
    projectId: safeString(project.id, 64),
    projectKey: safeString(project.key, 64),
    projectName: safeString(project.name, 512),
    summary: safeString(fields.summary, 2000) ?? "",
    status: safeString(status.name, 200),
    issueType: safeString(issueType.name, 200),
    priority: safeString(priority.name, 200),
    assignee: safeString(assignee.displayName, 512),
    updated: safeString(fields.updated, 64),
  };
}

function toIssueDetail(raw: unknown): JiraIssueDetail {
  const summary = toIssueSummary(raw);
  const fields = asRecord(asRecord(raw).fields);
  const reporter = asRecord(fields.reporter);
  return {
    ...summary,
    reporter: safeString(reporter.displayName, 512),
    labels: safeStringArray(fields.labels, 200),
    created: safeString(fields.created, 64),
    description: fields.description ?? null,
  };
}

function toComment(raw: unknown): JiraComment {
  const value = asRecord(raw);
  const author = asRecord(value.author);
  return {
    author: safeString(author.displayName, 512),
    created: safeString(value.created, 64),
    body: value.body ?? null,
  };
}

export function createJiraClient(config: AtlassianClientConfig) {
  return {
    /** `GET /rest/api/3/project/search`, ordered by name, with the lead
     * expanded so `leadName` can be filled in from one request. */
    async listProjects(
      token: string,
      cloudId: string,
      input: { query?: string; startAt?: number; maxResults: number },
    ): Promise<{ projects: JiraProject[]; isLast: boolean; nextStartAt: number }> {
      const response = await atlassianRequest<{
        values?: unknown[];
        isLast?: boolean;
        startAt?: number;
      }>(config, {
        accessToken: token,
        product: "jira",
        cloudId,
        path: "/rest/api/3/project/search",
        query: {
          query: input.query,
          startAt: input.startAt,
          maxResults: input.maxResults,
          orderBy: "name",
          expand: "lead",
        },
      });
      const values = response.values ?? [];
      const startAt = response.startAt ?? input.startAt ?? 0;
      return {
        projects: values.map(toProject),
        isLast: response.isLast ?? true,
        nextStartAt: startAt + values.length,
      };
    },

    /** `GET /rest/api/3/project/search` filtered by repeated `id`
     * parameters, chunked to the documented limit of 50 ids per request. */
    async getProjectsByIds(
      token: string,
      cloudId: string,
      projectIds: string[],
    ): Promise<JiraProject[]> {
      const projects: JiraProject[] = [];
      for (const batch of chunk(projectIds, PROJECT_ID_CHUNK_SIZE)) {
        const response = await atlassianRequest<{ values?: unknown[] }>(config, {
          accessToken: token,
          product: "jira",
          cloudId,
          path: "/rest/api/3/project/search",
          query: { id: batch, maxResults: PROJECT_ID_CHUNK_SIZE, expand: "lead" },
        });
        for (const value of response.values ?? []) projects.push(toProject(value));
      }
      return projects;
    },

    /** `POST /rest/api/3/search/jql`. The documentation requires a bounded
     * JQL (a search restriction); `buildIssueJql` always starts with
     * `project in (...)`, so that requirement is met by construction. An
     * absent `nextPageToken` in the response means the last page. */
    async searchIssues(
      token: string,
      cloudId: string,
      input: { jql: string; nextPageToken?: string; maxResults: number },
    ): Promise<{ issues: JiraIssueSummary[]; nextPageToken: string | null }> {
      const response = await atlassianRequest<{
        issues?: unknown[];
        nextPageToken?: string | null;
      }>(config, {
        accessToken: token,
        product: "jira",
        cloudId,
        path: "/rest/api/3/search/jql",
        method: "POST",
        body: {
          jql: input.jql,
          maxResults: input.maxResults,
          nextPageToken: input.nextPageToken,
          fields: ISSUE_SEARCH_FIELDS,
        },
      });
      return {
        issues: (response.issues ?? []).map(toIssueSummary),
        nextPageToken: response.nextPageToken ?? null,
      };
    },

    /** `GET /rest/api/3/issue/{issueIdOrKey}`. Returns `null` on a
     * `JIRA_NOT_FOUND` error (403 or 404 from Jira); every other error
     * propagates. */
    async getIssue(
      token: string,
      cloudId: string,
      issueKey: string,
    ): Promise<JiraIssueDetail | null> {
      try {
        const response = await atlassianRequest<unknown>(config, {
          accessToken: token,
          product: "jira",
          cloudId,
          path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
          query: { fields: ISSUE_GET_FIELDS },
        });
        return toIssueDetail(response);
      } catch (error) {
        if (error instanceof AtlassianApiError && error.code === "JIRA_NOT_FOUND") {
          return null;
        }
        throw error;
      }
    },

    /** `GET /rest/api/3/issue/{issueIdOrKey}/comment`, ordered by creation
     * date (`orderBy=created`, verified against the documented allowed
     * value). */
    async listComments(
      token: string,
      cloudId: string,
      issueKey: string,
      maxResults: number,
    ): Promise<{ comments: JiraComment[]; total: number }> {
      const response = await atlassianRequest<{ comments?: unknown[]; total?: number }>(
        config,
        {
          accessToken: token,
          product: "jira",
          cloudId,
          path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
          query: { maxResults, orderBy: "created" },
        },
      );
      return {
        comments: (response.comments ?? []).map(toComment),
        total: response.total ?? 0,
      };
    },

    /** `GET /rest/api/3/user/search`, permitted under `read:jira-user`
     * (verified against the documented OAuth 2.0 scope for this
     * operation). */
    async findAccountIds(
      token: string,
      cloudId: string,
      name: string,
      limit: number,
    ): Promise<string[]> {
      const response = await atlassianRequest<unknown[]>(config, {
        accessToken: token,
        product: "jira",
        cloudId,
        path: "/rest/api/3/user/search",
        query: { query: name, maxResults: limit },
      });
      const ids: string[] = [];
      for (const value of response ?? []) {
        const accountId = safeString(asRecord(value).accountId, 128);
        if (accountId) ids.push(accountId);
      }
      return ids;
    },
  };
}
