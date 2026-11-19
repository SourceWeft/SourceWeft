/**
 * Constant Linear GraphQL documents. Every value a caller supplies travels
 * only as a GraphQL variable; nothing is ever interpolated into these
 * strings.
 *
 * Field and filter names were checked against Linear's published GraphQL
 * schema (`packages/sdk/src/schema.graphql` in the `linear/linear`
 * repository, main branch) on 2026-11-18. Three facts that are easy to get
 * wrong:
 * - the full-text field is `searchIssues` (not the deprecated `issueSearch`),
 *   and its text argument is named `term`;
 * - `assignee.isMe` takes `{ eq: true }`, not a bare boolean;
 * - Linear connections expose no total count, so "has more" is read from
 *   `pageInfo.hasNextPage`.
 */

export const IDENTITY_QUERY = `query { viewer { id email } organization { id name } }`;

export const TEAMS_QUERY = `query($after: String, $filter: TeamFilter) {
  teams(first: 50, after: $after, filter: $filter) {
    nodes { id name key } pageInfo { hasNextPage endCursor } } }`;

export const TEAM_PROJECTS_QUERY = `query($id: String!, $after: String) {
  team(id: $id) { id name key
    projects(first: 50, after: $after) {
      nodes { id name status { name } } pageInfo { hasNextPage endCursor } } } }`;

export const PROJECTS_QUERY = `query($first: Int!, $filter: ProjectFilter) {
  projects(first: $first, filter: $filter) {
    nodes { id name url progress targetDate status { name } lead { name }
      teams { nodes { id name key } } }
    pageInfo { hasNextPage } } }`;

/** Lean project lookup for selection search and describe: only the fields
 * those actions render (`id`, `name`, `status.name`). The heavier
 * `PROJECTS_QUERY` carries the extra fields the `list_linear_projects` tool
 * returns. */
export const PROJECTS_LOOKUP_QUERY = `query($first: Int!, $filter: ProjectFilter) {
  projects(first: $first, filter: $filter) {
    nodes { id name status { name } } pageInfo { hasNextPage } } }`;

export const SEARCH_ISSUES_QUERY = `query($term: String!, $after: String, $filter: IssueFilter) {
  searchIssues(term: $term, first: 20, after: $after, filter: $filter) {
    nodes { id identifier title url priorityLabel updatedAt
      state { name type } assignee { name } team { id key name } project { id name } }
    pageInfo { hasNextPage endCursor } } }`;

export const ISSUE_QUERY = `query($id: String!) {
  issue(id: $id) { id identifier title description url priorityLabel createdAt updatedAt
    state { name type } assignee { name } team { id key name } project { id name }
    labels(first: 50) { nodes { name } }
    comments(first: 20, orderBy: createdAt) {
      nodes { body createdAt user { name } } pageInfo { hasNextPage } } } }`;
