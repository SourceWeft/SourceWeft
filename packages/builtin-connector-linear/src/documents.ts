/**
 * Constant Linear GraphQL documents (Task 2, step 1: schema verification).
 *
 * Checked against the live SDL on 2026-11-18 via
 * https://cdn.jsdelivr.net/gh/linear/linear/packages/sdk/src/schema.graphql
 * (a mirror of `packages/sdk/src/schema.graphql` in the public `linear/linear`
 * GitHub repo; last updated 2026-11-11 by that repo's own release bot, so it
 * is the current schema, not a stale snapshot) plus
 * https://linear.app/developers/graphql and
 * https://linear.app/developers/rate-limiting for the two HTTP-level
 * (verify) items that are not part of the GraphQL SDL. Every marked
 * **(verify)** item in the brief resolved as follows, and every document
 * below reflects the resolution:
 *
 * - `TeamFilter`, `ProjectFilter`, `IssueFilter` **do not exist anywhere in
 *   the schema**, and no query field (`teams`, `projects`, `issueSearch`,
 *   `Team.projects`) accepts a `filter` argument. There are no comparator
 *   input types at all (`eqIgnoreCase`, `containsIgnoreCase`, `in`, `gte`
 *   do not exist), so `ProjectFilter.accessibleTeams` and
 *   `IssueFilter.assignee.isMe` are moot: neither type exists. All `filter`
 *   variables/arguments are removed from TEAMS_QUERY, PROJECTS_QUERY and
 *   SEARCH_ISSUES_QUERY. Team/project/assignee scoping (R3) must happen
 *   client-side in the adapter (Task 4) by filtering the plain list
 *   results, not via a server-side filter argument.
 * - `searchIssues` **does not exist**; the real field is `issueSearch`,
 *   defined as `issueSearch(query: String!, first: Int, after: String,
 *   before: String, last: Int, includeArchived: Boolean, orderBy:
 *   PaginationOrderBy): IssueConnection!` (no `filter`). SEARCH_ISSUES_QUERY
 *   below calls `issueSearch`, passing the `$term` variable to its `query:`
 *   argument; the external variable name stays `term` so Task 3/4 can keep
 *   calling `query(token, SEARCH_ISSUES_QUERY, { term, after })` unchanged.
 * - No Connection type exposes a `totalCount` field (the only `totalCount`
 *   in the whole schema belongs to the unrelated `ArchiveResponse` type),
 *   confirming R4: issue comments carry `commentsTruncated` from
 *   `pageInfo.hasNextPage`, not a total.
 * - `Project.status { name }` **does not exist**. `Project` has only a
 *   plain `state: String!` field (no nested object). PROJECTS_QUERY and
 *   TEAM_PROJECTS_QUERY select `state` instead of `status { name }`.
 * - Beyond the marked items: `Project.url` and `Project.progress` **also do
 *   not exist** on the real `Project` type (its full field list is
 *   archivedAt, canceledAt, color, completedAt, completedIssueCountHistory,
 *   completedScopeHistory, createdAt, creator, description, icon, id,
 *   issueCountHistory, issues, lead, links, members, milestone, name,
 *   scopeHistory, slackIssueComments, slackIssueStatuses, slackNewIssue,
 *   slugId, sortOrder, startedAt, state, targetDate, teams, updatedAt).
 *   Both fields are removed from PROJECTS_QUERY; selecting them would fail
 *   GraphQL validation at request time.
 * - `issue(id:)` **does** accept either a UUID or a human-readable
 *   identifier: Linear's own docs example queries `issue(id: "BLA-123")`
 *   and state the id "can either be the uuid returned by the creation
 *   query, or the shorthand id like `BLA-123`". ISSUE_QUERY is unchanged.
 * - `comments(orderBy:)` **does** exist, typed `PaginationOrderBy`, an enum
 *   with exactly two values, `createdAt` and `updatedAt` (no separate
 *   direction argument). `orderBy: createdAt` in ISSUE_QUERY is a valid
 *   enum literal.
 * - `X-RateLimit-Requests-Reset` **is** epoch milliseconds per Linear's own
 *   rate-limiting docs ("the time at which the current rate limit window
 *   resets in UTC epoch milliseconds"), confirming the brief's fallback
 *   order (`Retry-After` seconds, else that header converted to seconds
 *   from now, else 60).
 * - The literal error-message prefix `"Entity not found"` for a missing or
 *   inaccessible entity could not be confirmed against a live Linear
 *   primary-source errors page (every guessed `linear.app/developers/errors*`
 *   URL 404s), only against third-party documentation aggregators that
 *   independently agree on the exact text and an `extensions.type` of
 *   `"not_found"`. Implemented as given, flagged here as lower-confidence
 *   than the schema-derived facts above.
 *
 * Every value a caller supplies travels only as a GraphQL variable; nothing
 * is ever interpolated into these strings (global constraint).
 */

export const IDENTITY_QUERY = `query { viewer { id name email } organization { id name urlKey } }`;

// No `filter: TeamFilter` — TeamFilter does not exist and `teams` accepts no
// filter argument (see header comment).
export const TEAMS_QUERY = `query($after: String) {
  teams(first: 50, after: $after) {
    nodes { id name key } pageInfo { hasNextPage endCursor } } }`;

// `status { name }` -> `state`: Project has no `status` field (see header
// comment).
export const TEAM_PROJECTS_QUERY = `query($id: String!, $after: String) {
  team(id: $id) { id name key
    projects(first: 50, after: $after) {
      nodes { id name state } pageInfo { hasNextPage endCursor } } } }`;

// No `filter: ProjectFilter` (does not exist); no `url`/`progress` (do not
// exist on Project); `status { name }` -> `state` (see header comment).
export const PROJECTS_QUERY = `query($first: Int!) {
  projects(first: $first) {
    nodes { id name targetDate state lead { name }
      teams { nodes { id name key } } }
    pageInfo { hasNextPage } } }`;

// `searchIssues` -> `issueSearch`; its string argument is named `query`, not
// `term` (the external variable name here stays `term`); no `filter:
// IssueFilter` (does not exist) (see header comment).
export const SEARCH_ISSUES_QUERY = `query($term: String!, $after: String) {
  issueSearch(query: $term, first: 20, after: $after) {
    nodes { id identifier title url priorityLabel updatedAt
      state { name type } assignee { name } team { id key name } project { id name } }
    pageInfo { hasNextPage endCursor } } }`;

export const ISSUE_QUERY = `query($id: String!) {
  issue(id: $id) { id identifier title description url priorityLabel createdAt updatedAt
    state { name type } assignee { name } team { id key name } project { id name }
    labels(first: 50) { nodes { name } }
    comments(first: 20, orderBy: createdAt) {
      nodes { body createdAt user { name } } pageInfo { hasNextPage } } } }`;
