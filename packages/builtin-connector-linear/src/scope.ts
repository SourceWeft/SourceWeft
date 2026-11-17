/**
 * Scope: the one source of truth for which Linear issues and projects the
 * selection lets the agent tools (Task 4) reach. Scope is enforced twice —
 * once as the GraphQL `filter` variable sent to Linear (so the server does the
 * narrowing), and again on every record that comes back (so a record Linear
 * returns outside the selection is still dropped). These functions are pure:
 * no network, no clock, no I/O.
 *
 * R3 (the scope rule): an issue is in scope when its team id is a selected
 * team OR its project id is a selected project; a project is in scope when its
 * id is selected OR one of its teams is selected.
 *
 * The filter shapes were verified against Linear's current published schema in
 * Task 2 (see `documents.ts`'s header comment and the task-2 report):
 * `IssueFilter.team/project` take `{ id: { in: [...] } }`; `IssueFilter.or`
 * takes an array of `IssueFilter`; `ProjectFilter.id` takes `{ in: [...] }`
 * and `ProjectFilter.accessibleTeams` takes `{ some: { id: { in: [...] } } }`.
 * A side of the scope with no selected ids contributes no branch, so an empty
 * `in: []` (which Linear would read as "match nothing") is never emitted.
 */

export type LinearScope = { teamIds: string[]; projectIds: string[] };

/** Combines one or two branches: a single branch is returned on its own; two
 * branches are OR-ed (R3). An empty scope yields `{ or: [] }`, but the tools
 * reject an empty selection (LINEAR_NOTHING_SELECTED) before building a
 * filter, so that shape is never actually sent. */
function combine(branches: Array<Record<string, unknown>>): Record<string, unknown> {
  if (branches.length === 1) return branches[0]!;
  return { or: branches };
}

/** The `IssueFilter` that narrows a search to the selection. Team-only →
 * `{ team: { id: { in } } }`; project-only → `{ project: { id: { in } } }`;
 * both → `{ or: [team branch, project branch] }`. Never emits an empty
 * `in`. */
export function issueScopeFilter(scope: LinearScope): Record<string, unknown> {
  const branches: Array<Record<string, unknown>> = [];
  if (scope.teamIds.length > 0) branches.push({ team: { id: { in: scope.teamIds } } });
  if (scope.projectIds.length > 0) branches.push({ project: { id: { in: scope.projectIds } } });
  return combine(branches);
}

/** The `ProjectFilter` that narrows a project listing to the selection.
 * Project-only → `{ id: { in } }`; team-only →
 * `{ accessibleTeams: { some: { id: { in } } } }`; both → OR of the two.
 * Never emits an empty `in`. */
export function projectScopeFilter(scope: LinearScope): Record<string, unknown> {
  const branches: Array<Record<string, unknown>> = [];
  if (scope.projectIds.length > 0) branches.push({ id: { in: scope.projectIds } });
  if (scope.teamIds.length > 0) {
    branches.push({ accessibleTeams: { some: { id: { in: scope.teamIds } } } });
  }
  return combine(branches);
}

/** R3: in scope when the issue's team is selected OR its project is selected.
 * A record whose team and project fields are both missing or malformed matches
 * neither side and is therefore out of scope (dropped), never let through. */
export function issueInScope(
  issue: { team: { id: string }; project: { id: string } | null },
  scope: LinearScope,
): boolean {
  const teamId = (issue.team as { id?: unknown } | null | undefined)?.id;
  const projectId = (issue.project as { id?: unknown } | null | undefined)?.id;
  if (typeof teamId === "string" && scope.teamIds.includes(teamId)) return true;
  if (typeof projectId === "string" && scope.projectIds.includes(projectId)) return true;
  return false;
}

/** R3: in scope when the project's id is selected OR one of its teams is
 * selected. A record with missing or malformed id/teams matches neither and is
 * out of scope (dropped). */
export function projectInScope(
  project: { id: string; teams: { nodes: Array<{ id: string }> } },
  scope: LinearScope,
): boolean {
  const id = (project as { id?: unknown }).id;
  if (typeof id === "string" && scope.projectIds.includes(id)) return true;
  const nodes = (project as { teams?: { nodes?: unknown } }).teams?.nodes;
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      const teamId = (node as { id?: unknown } | null | undefined)?.id;
      if (typeof teamId === "string" && scope.teamIds.includes(teamId)) return true;
    }
  }
  return false;
}
