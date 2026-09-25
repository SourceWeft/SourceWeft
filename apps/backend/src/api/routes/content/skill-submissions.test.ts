import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { ContentError } from "../../../modules/content/errors";
import { createWorkspaceRouteTestApp } from "../../../test/hono";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  requireSkillWorkspace: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  retry: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  getSessionUserId: () => "user_1",
  requireSession: mocks.session,
}));
vi.mock("../../../modules/skills/registry/permissions", () => ({
  requireSkillWorkspace: mocks.requireSkillWorkspace,
}));
vi.mock("../../../modules/skills/registry/ingest/service", () => ({
  SKILL_SUBMISSION_PAGE_LIMITS: { default: 20, max: 100 },
  decodeSkillSubmissionCursor: (cursor: string) =>
    cursor === "good" ? { createdAt: new Date(0), id: "x" } : null,
  createSkillSubmission: mocks.create,
  listSkillSubmissions: mocks.list,
  getSkillSubmission: mocks.get,
  retrySkillSubmission: mocks.retry,
}));

import { registerSkillSubmissionRoutes } from "./skill-submissions";

const createTestApp = () =>
  createWorkspaceRouteTestApp(registerSkillSubmissionRoutes);

const viewer = {
  teamId: "team_1",
  workspaceId: "workspace_1",
  userId: "user_1",
};
const base = "/v1/workspaces/workspace_1/skills/registry/submissions";
const post = (path: string, body?: unknown) =>
  createTestApp().request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ user: { id: "user_1" } });
  mocks.requireSkillWorkspace.mockResolvedValue({
    workspace: { id: "workspace_1", organizationId: "team_1" },
  });
  mocks.create.mockResolvedValue({
    submission: { id: "sub_1" },
    created: true,
  });
  mocks.list.mockResolvedValue({ items: [], nextCursor: null });
  mocks.get.mockResolvedValue({ submission: { id: "sub_1" } });
  mocks.retry.mockResolvedValue({ submission: { id: "sub_1" } });
});

test("creating answers 202 for a new import and 200 for the one already in flight", async () => {
  const created = await post(base, {
    source: " acme/skills ",
    install: { skill: "pdf" },
  });
  assert.equal(created.status, 202);
  assert.deepEqual(await created.json(), { submission: { id: "sub_1" } });
  assert.deepEqual(mocks.create.mock.calls[0], [
    { ...viewer, source: "acme/skills", install: { skill: "pdf" } },
  ]);

  mocks.create.mockResolvedValue({
    submission: { id: "sub_1" },
    created: false,
  });
  assert.equal((await post(base, { source: "acme/skills" })).status, 200);
  assert.deepEqual(mocks.create.mock.calls[1], [
    { ...viewer, source: "acme/skills" },
  ]);
});

test("a malformed create body is a validation error and nothing is created", async () => {
  for (const body of [
    {},
    { source: "" },
    { source: "   " },
    { source: 5 },
    { source: "acme/skills", target: "team" },
    { source: "acme/skills", install: { installedVia: "agent" } },
    { source: "acme/skills", install: { skill: "" } },
  ]) {
    const response = await post(base, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(
      ((await response.json()) as { code?: string }).code,
      "VALIDATION_ERROR",
    );
  }
  assert.equal(mocks.create.mock.calls.length, 0);
});

test("a source the service refuses surfaces as its 422", async () => {
  mocks.create.mockRejectedValue(
    new ContentError(
      422,
      "REGISTRY_SUBMISSION_INVALID_SOURCE",
      "Only github.com",
    ),
  );
  const response = await post(base, { source: "https://gitlab.com/a/b" });
  assert.equal(response.status, 422);
  assert.equal(
    ((await response.json()) as { code?: string }).code,
    "REGISTRY_SUBMISSION_INVALID_SOURCE",
  );
});

test("writes need skills.submit, reads need skills.read, and a refusal stops the request", async () => {
  await post(base, { source: "acme/skills" });
  await post(`${base}/sub_1/retry`);
  await createTestApp().request(base);
  await createTestApp().request(`${base}/sub_1`);
  assert.deepEqual(
    mocks.requireSkillWorkspace.mock.calls.map((call) => call[0]),
    ["skills.submit", "skills.submit", "skills.read", "skills.read"].map(
      (permission) => ({
        workspaceId: "workspace_1",
        userId: "user_1",
        permission,
      }),
    ),
  );

  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ user: { id: "user_1" } });
  mocks.requireSkillWorkspace.mockRejectedValue(
    new ContentError(403, "SKILLS_FORBIDDEN", "no"),
  );
  assert.equal((await post(base, { source: "acme/skills" })).status, 403);
  assert.equal((await post(`${base}/sub_1/retry`)).status, 403);
  assert.equal(mocks.create.mock.calls.length, 0);
  assert.equal(mocks.retry.mock.calls.length, 0);
});

test("no session is a 401 before any workspace lookup", async () => {
  mocks.session.mockResolvedValue(null);
  assert.equal((await post(base, { source: "acme/skills" })).status, 401);
  assert.equal((await createTestApp().request(base)).status, 401);
  assert.equal(mocks.requireSkillWorkspace.mock.calls.length, 0);
});

test("listing defaults to 20 and validates paging input", async () => {
  assert.equal((await createTestApp().request(base)).status, 200);
  assert.deepEqual(mocks.list.mock.calls[0], [
    { ...viewer, limit: 20, cursor: undefined },
  ]);
  await createTestApp().request(`${base}?limit=100&cursor=good`);
  assert.deepEqual(mocks.list.mock.calls[1], [
    { ...viewer, limit: 100, cursor: { createdAt: new Date(0), id: "x" } },
  ]);

  for (const query of [
    "limit=0",
    "limit=101",
    "limit=abc",
    "cursor=bad",
    "cursor=",
  ]) {
    const response = await createTestApp().request(`${base}?${query}`);
    assert.equal(response.status, 400, query);
  }
  assert.equal(mocks.list.mock.calls.length, 2);
});

test("get and retry pass the submission id through; retry answers 202", async () => {
  const got = await createTestApp().request(`${base}/sub%2F1`);
  assert.equal(got.status, 200);
  assert.deepEqual(mocks.get.mock.calls[0], [
    { ...viewer, submissionId: "sub/1" },
  ]);

  const retried = await post(`${base}/sub_1/retry`);
  assert.equal(retried.status, 202);
  assert.deepEqual(mocks.retry.mock.calls[0], [
    { ...viewer, submissionId: "sub_1" },
  ]);

  mocks.retry.mockRejectedValue(
    new ContentError(
      409,
      "SKILL_SUBMISSION_NOT_RETRYABLE",
      "Only a failed import",
    ),
  );
  assert.equal((await post(`${base}/sub_1/retry`)).status, 409);
  mocks.get.mockRejectedValue(
    new ContentError(404, "SKILL_SUBMISSION_NOT_FOUND", "nope"),
  );
  assert.equal((await createTestApp().request(`${base}/other`)).status, 404);
});
