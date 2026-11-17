/**
 * Constant Linear GraphQL documents (Task 2, step 1: schema verification).
 *
 * FIX ROUND 1 (2026-11-18): the first pass of this verification used
 * `https://cdn.jsdelivr.net/gh/linear/linear/packages/sdk/src/schema.graphql`
 * without a version pin, which jsdelivr resolves to the repository's `1.3.1`
 * release tag — a ~175 KB file that is years old — not the current schema.
 * Every document was wrongly "corrected" against that stale file. This
 * revision re-verifies every item against the real, current file:
 * `https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql`
 * (streamed with `curl | grep`/`curl | sed`, never saved to disk; confirmed
 * current — 1.58 MB / 46,122 lines, matching the controller's figures).
 * Below, each item states the plan's assumption, what the current schema
 * says (with the line read), and the document as written. Every document
 * is the brief's original text: nothing needed to change.
 *
 * - **`ProjectFilter.accessibleTeams`** — assumption: exists, used by
 *   Task 4. Schema (line 29047, `input ProjectFilter { accessibleTeams:
 *   TeamCollectionFilter ... }`): **exists**, typed `TeamCollectionFilter`
 *   (line 40513: `{ some: TeamFilter, every: TeamFilter, id: IDComparator,
 *   length: NumberComparator, and/or: [TeamCollectionFilter!], ... }`).
 *   `NullableProjectFilter` (line 24995, used by `IssueFilter.project`) has
 *   the same field. No document selects this field directly (it is a
 *   `projects(filter:)`/`IssueFilter.project` input, not an output
 *   selection); unchanged.
 * - **Comparators `eqIgnoreCase`, `containsIgnoreCase`, `in`, `gte`** —
 *   assumption: exist. Schema: `input StringComparator` (line 39148) has
 *   `eq, eqIgnoreCase, contains, containsIgnoreCase, containsIgnoreCaseAndAccent,
 *   startsWith, endsWith, in, neq, nin, ...`; `input DateComparator` (line
 *   6416) has `eq, gt, gte, in, lt, lte, neq, nin`. **All four exist.**
 *   Not used by any document (they're filter-input leaves Task 4 builds for
 *   `query()`'s `variables.filter`, not part of these constant strings).
 * - **`IssueFilter.assignee` → `isMe`** — assumption: exists. Schema:
 *   `IssueFilter.assignee: NullableUserFilter` (line ~15033); `input
 *   NullableUserFilter` (line 25509) has `isMe: BooleanComparator` ("Use
 *   `{ eq: true }` for the authenticated user ... The value is a
 *   BooleanComparator, not a bare boolean."). **Exists**, as described.
 * - **`searchIssues` accepting `filter`, `first`, `after`** — assumption:
 *   yes. Schema (line 35105): `searchIssues(after: String, before: String,
 *   filter: IssueFilter, first: Int, includeArchived: Boolean,
 *   includeComments: Boolean, last: Int, orderBy: PaginationOrderBy,
 *   teamId: String, term: String!): IssueSearchPayload!`. **All three
 *   (`filter`, `first`, `after`) exist, and the text argument is named
 *   `term`**, exactly as the brief's `SEARCH_ISSUES_QUERY` has it. Its
 *   return type is `IssueSearchPayload`, not a plain `IssueConnection`, but
 *   `IssueSearchPayload` still has `nodes: [IssueSearchResult!]!` and
 *   `pageInfo: PageInfo!` (plus a `totalCount: Float!` the document doesn't
 *   select), and `IssueSearchResult implements Node` carries every field
 *   the document selects (`id, identifier, title, url, priorityLabel,
 *   updatedAt, state, assignee, team, project` all present, checked line by
 *   line at line 16703). **`SEARCH_ISSUES_QUERY` is unchanged.** Note:
 *   there is also a field literally named `issueSearch` (line 34142), but
 *   it is marked `[DEPRECATED] ... use searchIssues instead` — the brief's
 *   choice of `searchIssues` is the correct, non-deprecated one.
 * - **Connections exposing a total count** — assumption: no. Schema:
 *   `CommentConnection` (line 2955) and `IssueConnection` (line 14770) each
 *   have only `edges, nodes, pageInfo` — **no `totalCount`**, confirming
 *   R4's `commentsTruncated`-from-`pageInfo.hasNextPage` design for
 *   `ISSUE_QUERY`'s `comments`. (The one exception found: `searchIssues`'s
 *   `IssueSearchPayload`, not a plain Connection, does carry a `totalCount:
 *   Float!` described as "Number of candidates retrieved before filtering
 *   and pagination... not an exact count of all matching issues" — not
 *   selected here, and not relevant to R4, which is about issue comments.)
 * - **`Project.status { name }` vs. a plain `state` string** — assumption:
 *   `status { name }`. Schema (`type Project`, line 27865): has **both**
 *   `state: String! @deprecated(reason: "Use project.status instead")` and
 *   `status: ProjectStatus!`; `type ProjectStatus` (line 31350) has `name:
 *   String!`. So `status { name }` is the correct, non-deprecated
 *   selection — exactly the brief's text. **Unchanged** in both
 *   `PROJECTS_QUERY` and `TEAM_PROJECTS_QUERY`.
 * - **`Project.url`, `Project.progress`** (flagged in the first pass, not
 *   a brief (verify) item) — both **exist** on the current `Project` type
 *   (`url: String!`, `progress: Float!`, read directly from the type body
 *   at line 27865). The first pass's claim that they didn't exist was
 *   wrong (stale-schema artifact). **Unchanged.**
 * - **`issue(id:)` accepting an identifier such as `ENG-123`** —
 *   confirmed directly in the schema's own field description (`type
 *   Query`, `issue` field): "Finds an issue by UUID or a human-readable
 *   identifier such as ENG-123. ... The query fails if the issue does not
 *   exist or you cannot access it." **Unchanged.**
 * - **`comments(orderBy:)` and its direction** — `Issue.comments` accepts
 *   `orderBy: PaginationOrderBy`, an enum with exactly `createdAt` and
 *   `updatedAt` (no separate direction argument) — confirmed again on the
 *   current schema. `orderBy: createdAt` in `ISSUE_QUERY` is a valid
 *   literal. One nuance for the controller/Task 4: the connection-argument
 *   doc text (repeated verbatim on nearly every paginated field in this
 *   schema, so it reads as generic boilerplate rather than a
 *   comments-specific contract) says "Results are newest first with
 *   `first` and oldest first with `last`". That is in tension with R4's
 *   "comments are returned oldest first" assumption. I could not confirm
 *   from the SDL alone whether this generic wording is accurate for
 *   `comments` specifically or is a copy-pasted description that doesn't
 *   hold for every field it's attached to (it is attached, word for word,
 *   to unrelated fields like `teams`/`projects` too). Flagging this for
 *   the controller rather than silently keeping or discarding R4's
 *   ordering assumption; the document itself is unchanged either way (the
 *   query doesn't encode a sort direction beyond `orderBy: createdAt`).
 * - **`TeamFilter`, `ProjectFilter`, `IssueFilter` type names** — all
 *   three **exist** (`input IssueFilter` line 14991, `input ProjectFilter`
 *   line 29047, `input TeamFilter` line 40729), and `Query.teams`,
 *   `Query.projects`, `Team.projects` and `searchIssues` all accept a
 *   `filter:` argument of the matching type. The first pass's claim that
 *   none of these existed was entirely a stale-schema artifact.
 *   `TEAMS_QUERY` and `PROJECTS_QUERY` are restored to the brief's
 *   original `$filter` variables, **unchanged** from the brief.
 *
 * Every value a caller supplies travels only as a GraphQL variable; nothing
 * is ever interpolated into these strings (global constraint).
 */

export const IDENTITY_QUERY = `query { viewer { id name email } organization { id name urlKey } }`;

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
