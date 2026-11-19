import assert from "node:assert/strict";
import test from "node:test";
import {
  issueInScope,
  issueScopeFilter,
  projectInScope,
  projectScopeFilter,
  type LinearScope,
} from "../src/scope";

const TEAM_A = "11111111-1111-1111-1111-111111111111";
const TEAM_B = "22222222-2222-2222-2222-222222222222";
const PROJECT_A = "33333333-3333-3333-3333-333333333333";
const PROJECT_B = "44444444-4444-4444-4444-444444444444";

test("filter omits the empty side", () => {
  const teamsOnly: LinearScope = { teamIds: [TEAM_A, TEAM_B], projectIds: [] };
  const teamFilter = issueScopeFilter(teamsOnly);
  assert.deepEqual(teamFilter, { team: { id: { in: [TEAM_A, TEAM_B] } } });
  assert.equal("or" in teamFilter, false);
  assert.equal("project" in teamFilter, false);

  const projectsOnly: LinearScope = { teamIds: [], projectIds: [PROJECT_A] };
  const projectFilter = issueScopeFilter(projectsOnly);
  assert.deepEqual(projectFilter, { project: { id: { in: [PROJECT_A] } } });
  assert.equal("or" in projectFilter, false);
  assert.equal("team" in projectFilter, false);

  const both: LinearScope = { teamIds: [TEAM_A], projectIds: [PROJECT_A] };
  assert.deepEqual(issueScopeFilter(both), {
    or: [{ team: { id: { in: [TEAM_A] } } }, { project: { id: { in: [PROJECT_A] } } }],
  });

  // No empty `in` is ever emitted, by either filter, for any of the shapes.
  for (const scope of [teamsOnly, projectsOnly, both]) {
    const serialized = JSON.stringify([issueScopeFilter(scope), projectScopeFilter(scope)]);
    assert.equal(serialized.includes('"in":[]'), false);
  }
});

test("project filter combines id and accessibleTeams branches", () => {
  assert.deepEqual(projectScopeFilter({ teamIds: [], projectIds: [PROJECT_A] }), {
    id: { in: [PROJECT_A] },
  });
  assert.deepEqual(projectScopeFilter({ teamIds: [TEAM_A], projectIds: [] }), {
    accessibleTeams: { some: { id: { in: [TEAM_A] } } },
  });
  assert.deepEqual(projectScopeFilter({ teamIds: [TEAM_A], projectIds: [PROJECT_A] }), {
    or: [
      { id: { in: [PROJECT_A] } },
      { accessibleTeams: { some: { id: { in: [TEAM_A] } } } },
    ],
  });
});

test("issue in a selected project of an unselected team is in scope", () => {
  const scope: LinearScope = { teamIds: [TEAM_A], projectIds: [PROJECT_A] };
  assert.equal(
    issueInScope({ team: { id: TEAM_B }, project: { id: PROJECT_A } }, scope),
    true,
  );
});

test("issue with no project in an unselected team is out of scope", () => {
  const scope: LinearScope = { teamIds: [TEAM_A], projectIds: [PROJECT_A] };
  assert.equal(issueInScope({ team: { id: TEAM_B }, project: null }, scope), false);
});

test("an issue with missing team and project fields is out of scope", () => {
  const scope: LinearScope = { teamIds: [TEAM_A], projectIds: [PROJECT_A] };
  const malformed = { team: null, project: null } as unknown as Parameters<
    typeof issueInScope
  >[0];
  assert.equal(issueInScope(malformed, scope), false);
});

test("project is in scope through one of its teams", () => {
  const scope: LinearScope = { teamIds: [TEAM_A], projectIds: [] };
  assert.equal(
    projectInScope(
      { id: PROJECT_B, teams: { nodes: [{ id: TEAM_B }, { id: TEAM_A }] } },
      scope,
    ),
    true,
  );
  assert.equal(
    projectInScope({ id: PROJECT_B, teams: { nodes: [{ id: TEAM_B }] } }, scope),
    false,
  );
});
