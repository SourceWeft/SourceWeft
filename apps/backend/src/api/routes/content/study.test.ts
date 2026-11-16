import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createWorkspaceRouteTestApp, readJson } from "../../../test/hono";
import { ContentError } from "../../../modules/content/errors";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  requireSession: vi.fn(),
  requestStudyArtifact: vi.fn(),
  requestStudyRegeneration: vi.fn(),
  estimateStudy: vi.fn(),
  getStudyFreshness: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  getSessionUserId: mocks.getSessionUserId,
  requireSession: mocks.requireSession,
}));

vi.mock("../../../modules/study/requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../modules/study/requests")>()),
  requestStudyArtifact: mocks.requestStudyArtifact,
  requestStudyRegeneration: mocks.requestStudyRegeneration,
  estimateStudy: mocks.estimateStudy,
  getStudyFreshness: mocks.getStudyFreshness,
}));

import { registerStudyRoutes } from "./study";

const app = () => createWorkspaceRouteTestApp(registerStudyRoutes);

function signedIn() {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockReturnValue("user_1");
  mocks.requireSession.mockResolvedValue({
    user: { id: "user_1", email: "u@example.com", name: "U" },
    session: { id: "s", userId: "user_1" },
  });
}

const body = {
  threadId: "thread_1",
  artifactType: "flashcards",
  sourceIds: ["src_1"],
  options: { size: "more", focus: "dates" },
};

function post(path: string, payload: unknown, headers: Record<string, string> = {}) {
  return app().request(`/v1/workspaces/workspace_1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

test("study routes require a session", async () => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue(null);
  assert.equal((await post("/study/artifacts", body)).status, 401);
  assert.equal(
    (await app().request("/v1/workspaces/workspace_1/study/artifacts/a/freshness")).status,
    401,
  );
  assert.equal(mocks.requestStudyArtifact.mock.calls.length, 0);
});

test("POST /study/artifacts validates, passes the UI locale and answers 202", async () => {
  signedIn();
  mocks.requestStudyArtifact.mockResolvedValue({
    artifactId: "art_1",
    versionNo: 1,
    status: "pending",
    visibility: "private",
    reused: false,
  });
  const response = await post("/study/artifacts", body, { "accept-language": "zh-CN,zh;q=0.9" });
  assert.equal(response.status, 202);
  const json = (await readJson(response)) as { data?: unknown };
  assert.deepEqual(json.data ?? json, {
    artifactId: "art_1",
    versionNo: 1,
    status: "pending",
    visibility: "private",
    reused: false,
  });
  const [input] = mocks.requestStudyArtifact.mock.calls[0]!;
  assert.equal(input.workspaceId, "workspace_1");
  assert.equal(input.userId, "user_1");
  assert.equal(input.uiLocale, "zh-CN");
  assert.deepEqual(input.request.sourceIds, ["src_1"]);
});

test("invalid study requests are rejected before any work", async () => {
  signedIn();
  for (const bad of [
    { ...body, sourceIds: [] },
    { ...body, sourceIds: Array.from({ length: 51 }, (_, i) => `s${i}`) },
    { ...body, options: { count: 61 } },
    { ...body, options: { focus: "x".repeat(201) } },
    { ...body, options: { size: "huge" } },
  ]) {
    assert.equal((await post("/study/artifacts", bad)).status, 400);
  }
  assert.equal(mocks.requestStudyArtifact.mock.calls.length, 0);
});

test("study errors keep their code and status", async () => {
  signedIn();
  mocks.requestStudyArtifact.mockRejectedValue(
    new ContentError(404, "SOURCE_NOT_READABLE", "nope"),
  );
  const response = await post("/study/artifacts", body);
  assert.equal(response.status, 404);
  assert.match(JSON.stringify(await readJson(response)), /SOURCE_NOT_READABLE/);

  mocks.requestStudyArtifact.mockRejectedValue(
    new ContentError(429, "STUDY_TOO_MANY_RUNNING", "busy"),
  );
  assert.equal((await post("/study/artifacts", body)).status, 429);
});

test("estimate, regenerate and freshness reach their services", async () => {
  signedIn();
  mocks.estimateStudy.mockResolvedValue({ mode: "single", inputTokensEstimate: 10, groups: 1, maxItems: 40, exceedsLimit: false });
  mocks.requestStudyRegeneration.mockResolvedValue({ artifactId: "art_1", versionNo: 2, status: "pending" });
  mocks.getStudyFreshness.mockResolvedValue({ state: "fresh", changedSourceIds: [], deletedSourceIds: [] });

  assert.equal((await post("/study/estimate", body)).status, 200);
  const regen = await post("/study/artifacts/art_1/regenerate", { focus: "events" });
  assert.equal(regen.status, 202);
  assert.equal(mocks.requestStudyRegeneration.mock.calls[0]![0].artifactId, "art_1");
  assert.deepEqual(mocks.requestStudyRegeneration.mock.calls[0]![0].body, { focus: "events" });
  const fresh = await app().request("/v1/workspaces/workspace_1/study/artifacts/art_1/freshness");
  assert.equal(fresh.status, 200);
});
