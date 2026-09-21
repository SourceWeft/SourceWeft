import assert from "node:assert/strict";
import { Hono } from "hono";
import { beforeEach, test, vi } from "vitest";
import { ContentError } from "../../../modules/content/errors";
import { ApiError, ApiResponse, toApiError } from "../../response/api-response";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  requireSkillWorkspace: vi.fn(),
  overview: vi.fn(),
  start: vi.fn(),
  verify: vi.fn(),
  remove: vi.fn(),
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
  verifySkillClaim: mocks.verify,
  removeClaimedRepoFromMarket: mocks.remove,
}));

import { registerSkillClaimRoutes } from "./skill-claims";

function createTestApp() {
  const app = new Hono();
  const workspaceRoutes = new Hono();
  registerSkillClaimRoutes(workspaceRoutes);
  app.route("/v1/workspaces/:workspaceId", workspaceRoutes);
  app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));
  app.onError((error, c) => ApiResponse.error(c, toApiError(error)));
  return app;
}

const base = "/v1/workspaces/workspace_1/skills/claims";
const get = (path: string) => createTestApp().request(path);
const post = (path: string, body?: unknown) =>
  createTestApp().request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const claim = (status: string) => ({
  id: "claim_1",
  repo: "ada/skills",
  method: status === "pending" ? "verification_file" : "github_account",
  status,
  createdAt: "2026-09-21T00:00:00.000Z",
  verifiedAt: null,
  expiresAt: null,
});

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
  ]) {
    assert.equal((await post(base, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(mocks.start.mock.calls.length, 0);

  mocks.start.mockResolvedValue({ claim: claim("verified"), verification: null });
  const decided = await post(base, { repo: " ada/skills ", method: "github_account" });
  assert.equal(decided.status, 200);
  assert.deepEqual(mocks.start.mock.calls[0], [
    { userId: "user_1", repo: "ada/skills", method: "github_account" },
  ]);

  mocks.start.mockResolvedValue({
    claim: claim("pending"),
    verification: { token: "t", path: ".sourceweft/claim", branch: "main" },
  });
  const pending = await post(base, {
    repo: "ada/skills",
    method: "verification_file",
  });
  assert.equal(pending.status, 201);
  assert.equal(
    ((await pending.json()) as { verification: { token: string } }).verification
      .token,
    "t",
  );
});

test("the service's refusals reach the author with their codes", async () => {
  mocks.start.mockRejectedValue(
    new ContentError(409, "SKILL_REPO_ALREADY_CLAIMED", "Already claimed"),
  );
  const response = await post(base, {
    repo: "ada/skills",
    method: "verification_file",
  });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /SKILL_REPO_ALREADY_CLAIMED/);
});

test("verify and remove act on the caller's claim", async () => {
  mocks.verify.mockResolvedValue(claim("verified"));
  const verified = await post(`${base}/claim_1/verify`);
  assert.equal(verified.status, 200);
  assert.deepEqual(mocks.verify.mock.calls[0], [
    { userId: "user_1", claimId: "claim_1" },
  ]);
  assert.deepEqual(await verified.json(), { claim: claim("verified") });

  mocks.remove.mockResolvedValue({ repo: "ada/skills", skillCount: 2 });
  const removed = await post(`${base}/claim_1/remove-from-market`);
  assert.equal(removed.status, 200);
  assert.deepEqual(mocks.remove.mock.calls[0], [
    { userId: "user_1", claimId: "claim_1" },
  ]);
  assert.deepEqual(await removed.json(), { repo: "ada/skills", skillCount: 2 });
});
