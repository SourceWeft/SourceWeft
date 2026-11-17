// JQL builders for the Jira agent tools. The agent never supplies JQL itself:
// every free-text input the agent passes (`text`, `status`, `issueType`,
// account ids) is escaped through `jqlString`, and `text` is additionally
// cleaned through `jqlTextTerm` before being quoted, so user-controlled text
// can only ever land inside one string literal and can never change the
// query's clause structure.

import { invalidRequest } from "./shared";

const PROJECT_ID = /^[0-9]{1,20}$/;

/** Wraps `value` as a double-quoted JQL string literal, escaping backslashes
 * before quotes so the value can never close the literal early. The escaping is
 * fixed; implement exactly this. */
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Strips JQL-significant characters out of a free-text search term before
 * it is wrapped with {@link jqlString} for a `text ~ "..."` clause. The
 * cleaning is fixed; implement exactly this. */
export function jqlTextTerm(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[+\-&|!(){}\[\]^~*?\\:"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type JqlInput = {
  projectIds: string[]; // numeric strings, 1..n, already validated
  text?: string;
  status?: string;
  issueType?: string;
  assignee?: { kind: "me" } | { kind: "accounts"; accountIds: string[] };
  updatedWithinDays?: number;
  orderBy?: "updated" | "created" | "priority";
};

/**
 * Builds a Jira issue-search JQL string. The first clause is always
 * `project in (<ids>)`, so the query is always bounded (Jira's
 * `search/jql` requires a bounded query) and the connector's own project
 * scope can never be dropped by anything the agent passes in. Every other
 * clause is ANDed in afterward, in a fixed order, then `ORDER BY` is
 * appended.
 */
export function buildIssueJql(input: JqlInput): string {
  if (input.projectIds.length === 0) {
    throw invalidRequest("At least one project id is required");
  }
  for (const id of input.projectIds) {
    if (!PROJECT_ID.test(id)) {
      throw invalidRequest("Invalid Jira project id");
    }
  }

  const clauses: string[] = [`project in (${input.projectIds.join(", ")})`];

  if (input.text !== undefined) {
    const term = jqlTextTerm(input.text);
    if (term.length > 0) {
      clauses.push(`text ~ ${jqlString(term)}`);
    }
  }

  if (input.status !== undefined) {
    clauses.push(`status = ${jqlString(input.status)}`);
  }

  if (input.issueType !== undefined) {
    clauses.push(`issuetype = ${jqlString(input.issueType)}`);
  }

  if (input.assignee) {
    if (input.assignee.kind === "me") {
      clauses.push("assignee = currentUser()");
    } else if (input.assignee.accountIds.length === 0) {
      // No site matched the requested assignee: match nothing rather than
      // silently dropping the filter and returning everything.
      clauses.push("assignee is EMPTY AND assignee is not EMPTY");
    } else {
      clauses.push(`assignee in (${input.assignee.accountIds.map(jqlString).join(", ")})`);
    }
  }

  if (input.updatedWithinDays !== undefined) {
    clauses.push(`updated >= -${input.updatedWithinDays}d`);
  }

  const orderBy = input.orderBy ?? "updated";
  return `${clauses.join(" AND ")} ORDER BY ${orderBy} DESC`;
}
