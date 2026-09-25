import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { ContentError } from "../../../modules/content/errors";
import { createWorkspaceRouteTestApp } from "../../../test/hono";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  requireSkillWorkspace: vi.fn(),
  overview: vi.fn(),
  start: vi.fn(),
  remove: vi.fn(),
  restore: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  getSessionUserId: () => "user_1",
  requireSession: mocks.session,
}));
vi.mock("../../../modules/skills/registry/permissions", () => ({
  requireSkillWorkspace: mocks.requireSkillWorkspace,
}));
vi.mock("../../../modules/skills/market/claims", () => ({
  getSkillClaimsOverview: mocks.overview,
  startSkillClaim: mocks.start,
  removeClaimedRepoFromMarket: mocks.remove,
  restoreClaimedRepoToMarket: mocks.restore,
}));

import { registerSkillClaimRoutes } from "./skill-claims";

const createTestApp = () =>
  createWorkspaceRouteTestApp(registerSkillClaimRoutes);

const base = "/v1/workspaces/workspace_1/skills/claims";
const get = (path: string) => createTestApp().request(path);
const post = (path: string, body?: unknown) =>
  createTestApp().request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const claim = {
  id: "claim_1",
  repo: "ada/skills",
  method: "github_account",
  status: "verified",
  createdAt: "2026-09-21T00:00:00.000Z",
  verifiedAt: "2026-09-21T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ user: { id: "user_1" } });
  mocks.requireSkillWorkspace.mockResolvedValue({
    workspace: { id: "workspace_1", organizationId: "team_1" },
  });
  mocks.overview.mockResolvedValue({
    githubLinked: false,
    claims: [],
    suggestions: [],
    repository: null,
  });
});

test("every claim route needs a session and a readable workspace", async () => {
  mocks.session.mockResolvedValue(null);
  assert.equal((await get(base)).status, 401);
  assert.equal(
    (await post(base, { repo: "ada/skills", method: "github_account" })).status,
    401,
  );
  assert.equal(mocks.start.mock.calls.length, 0);

  mocks.session.mockResolvedValue({ user: { id: "user_1" } });
  await get(base);
  assert.deepEqual(mocks.requireSkillWorkspace.mock.calls.at(-1), [
    { workspaceId: "workspace_1", userId: "user_1", permission: "skills.read" },
  ]);
});

test("the overview is the caller's, optionally about one repository", async () => {
  assert.equal((await get(base)).status, 200);
  assert.deepEqual(mocks.overview.mock.calls[0], [
    { userId: "user_1", repo: null, skillId: null },
  ]);

  await get(`${base}?repo=Ada/Skills`);
  assert.deepEqual(mocks.overview.mock.calls[1], [
    { userId: "user_1", repo: { owner: "ada", name: "skills" }, skillId: null },
  ]);

  await get(`${base}?skillId=skill_9`);
  assert.deepEqual(mocks.overview.mock.calls[2], [
    { userId: "user_1", repo: null, skillId: "skill_9" },
  ]);

  const invalid = await get(`${base}?repo=${encodeURIComponent("ada/../x")}`);
  assert.equal(invalid.status, 400);
  assert.equal(mocks.overview.mock.calls.length, 3);
});

test("starting takes a strict body and claims for the session's user only", async () => {
  for (const body of [
    { repo: "ada/skills" },
    { repo: "ada", method: "github_account" },
    { repo: "ada/skills", method: "github_account", userId: "user_2" },
    // The verification file is gone; a grant is only an admin's.
    { repo: "ada/skills", method: "verification_file" },
    { repo: "ada/skills", method: "admin_grant" },
  ]) {
    const response = await post(base, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match(await response.text(), /VALIDATION_ERROR/);
  }
  assert.equal(mocks.start.mock.calls.length, 0);

  mocks.start.mockResolvedValue({ claim });
  const decided = await post(base, {
    repo: " ada/skills ",
    method: "github_account",
  });
  assert.equal(decided.status, 200);
  assert.deepEqual(mocks.start.mock.calls[0], [
    { userId: "user_1", repo: "ada/skills", method: "github_account" },
  ]);
  assert.deepEqual(await decided.json(), { claim });
});

test("the service's refusals reach the author with their codes", async () => {
  for (const [status, code] of [
    [409, "SKILL_REPO_ALREADY_CLAIMED"],
    [403, "SKILL_CLAIM_ACCOUNT_MISMATCH"],
    [409, "SKILL_CLAIM_ORGANIZATION_REPO"],
  ] as const) {
    mocks.start.mockRejectedValueOnce(new ContentError(status, code, code));
    const response = await post(base, {
      repo: "ada/skills",
      method: "github_account",
    });
    assert.equal(response.status, status);
    assert.match(await response.text(), new RegExp(code));
  }
});

test("there is no verify route any more; remove acts on the caller's claim", async () => {
  assert.equal((await post(`${base}/claim_1/verify`)).status, 404);

  mocks.remove.mockResolvedValue({ repo: "ada/skills", skillCount: 2 });
  const removed = await post(`${base}/claim_1/remove-from-market`);
  assert.equal(removed.status, 200);
  assert.deepEqual(mocks.remove.mock.calls[0], [
    { userId: "user_1", claimId: "claim_1" },
  ]);
  assert.deepEqual(await removed.json(), { repo: "ada/skills", skillCount: 2 });
});

test("restore acts on the caller's claim and answers what it released", async () => {
  mocks.session.mockResolvedValue(null);
  assert.equal((await post(`${base}/claim_1/restore-to-market`)).status, 401);
  assert.equal(mocks.restore.mock.calls.length, 0);

  mocks.session.mockResolvedValue({ user: { id: "user_1" } });
  mocks.restore.mockResolvedValue({ repo: "ada/skills", skillCount: 2 });
  const restored = await post(`${base}/claim_1/restore-to-market`);
  assert.equal(restored.status, 200);
  assert.deepEqual(mocks.restore.mock.calls[0], [
    { userId: "user_1", claimId: "claim_1" },
  ]);
  assert.deepEqual(await restored.json(), {
    repo: "ada/skills",
    skillCount: 2,
  });

  mocks.restore.mockRejectedValueOnce(
    new ContentError(409, "SKILL_CLAIM_NOT_VERIFIED", "not verified"),
  );
  const refused = await post(`${base}/claim_1/restore-to-market`);
  assert.equal(refused.status, 409);
  assert.match(await refused.text(), /SKILL_CLAIM_NOT_VERIFIED/);
});
