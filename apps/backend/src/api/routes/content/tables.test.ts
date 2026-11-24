import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createWorkspaceRouteTestApp, readJson } from "../../../test/hono";
import { ContentError } from "../../../modules/content/errors";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  requireSession: vi.fn(),
  requestTableColumnSuggestions: vi.fn(),
  estimateTable: vi.fn(),
  requestTableArtifact: vi.fn(),
  requestTableRegeneration: vi.fn(),
  getTableFreshness: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  getSessionUserId: mocks.getSessionUserId,
  requireSession: mocks.requireSession,
}));
vi.mock("../../../billing-host/bindings", () => ({ billingRuntime: { marker: "billing" } }));
vi.mock("../../../modules/tables/requests", () => ({
  requestTableColumnSuggestions: mocks.requestTableColumnSuggestions,
  estimateTable: mocks.estimateTable,
  requestTableArtifact: mocks.requestTableArtifact,
  requestTableRegeneration: mocks.requestTableRegeneration,
  getTableFreshness: mocks.getTableFreshness,
}));

import { registerTableRoutes } from "./tables";

const app = () => createWorkspaceRouteTestApp(registerTableRoutes);
const base = "/v1/workspaces/workspace_1";

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
  sourceIds: ["src_1", "src_2"],
  columns: [
    { name: "Design", description: "How it was run", type: "text" },
    { name: "Participants", type: "number" },
  ],
  instruction: "focus on trials",
};

function post(path: string, payload: unknown, headers: Record<string, string> = {}) {
  return app().request(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

const ROUTES: [string, unknown][] = [
  ["/tables/columns/suggest", { sourceIds: ["src_1"] }],
  ["/tables/estimate", body],
  ["/tables/artifacts", body],
  ["/tables/artifacts/art_1/regenerate", {}],
];

test("each route returns 401 without a session and 422 for an invalid body", async () => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue(null);
  for (const [path, payload] of ROUTES) {
    assert.equal((await post(path, payload)).status, 401, path);
  }
  assert.equal((await app().request(`${base}/tables/artifacts/art_1/freshness`)).status, 401);

  signedIn();
  const invalid: [string, unknown][] = [
    ["/tables/columns/suggest", { sourceIds: [] }],
    ["/tables/columns/suggest", { sourceIds: ["a"], instruction: "x".repeat(301) }],
    ["/tables/estimate", { ...body, columns: [] }],
    ["/tables/artifacts", { ...body, sourceIds: [] }],
    ["/tables/artifacts", { ...body, sourceIds: Array.from({ length: 51 }, (_, i) => `s${i}`) }],
    ["/tables/artifacts", { ...body, columns: [{ name: "", type: "text" }] }],
    ["/tables/artifacts", { ...body, columns: [{ name: "A", type: "money" }] }],
    ["/tables/artifacts", { ...body, threadId: undefined }],
    // 50 sources × 9 columns is 450 cells.
    [
      "/tables/artifacts",
      {
        ...body,
        sourceIds: Array.from({ length: 50 }, (_, i) => `s${i}`),
        columns: Array.from({ length: 9 }, (_, i) => ({ name: `C${i}`, type: "text" })),
      },
    ],
    ["/tables/artifacts/art_1/regenerate", { columns: [] }],
    ["/tables/artifacts/art_1/regenerate", { instruction: "x".repeat(301) }],
  ];
  for (const [path, payload] of invalid) {
    const response = await post(path, payload);
    assert.equal(response.status, 422, `${path} ${JSON.stringify(payload).slice(0, 80)}`);
    assert.match(JSON.stringify(await readJson(response)), /VALIDATION_ERROR/);
  }
  const unreadable = await app().request(`${base}/tables/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(unreadable.status, 422);
  for (const mock of [
    mocks.requestTableColumnSuggestions,
    mocks.estimateTable,
    mocks.requestTableArtifact,
    mocks.requestTableRegeneration,
  ]) {
    assert.equal(mock.mock.calls.length, 0);
  }
});

test("POST /tables/artifacts passes the user, locale and request through and answers 202", async () => {
  signedIn();
  const result = {
    artifactId: "art_1",
    versionNo: 1,
    status: "pending",
    visibility: "private",
    reused: false,
  };
  mocks.requestTableArtifact.mockResolvedValue(result);
  const response = await post("/tables/artifacts", body, { "accept-language": "zh-CN,zh;q=0.9" });
  assert.equal(response.status, 202);
  const json = (await readJson(response)) as { data?: unknown };
  assert.deepEqual(json.data ?? json, result);
  const [input] = mocks.requestTableArtifact.mock.calls[0]!;
  assert.equal(input.workspaceId, "workspace_1");
  assert.equal(input.userId, "user_1");
  assert.equal(input.uiLocale, "zh-CN");
  assert.deepEqual(input.request.sourceIds, ["src_1", "src_2"]);
  assert.equal(input.request.columns[0].name, "Design");
});

test("suggest and estimate answer 200; suggest bills the requester through the billing runtime", async () => {
  signedIn();
  mocks.requestTableColumnSuggestions.mockResolvedValue({
    columns: [{ name: "Design", type: "text" }],
  });
  mocks.estimateTable.mockResolvedValue({ calls: 2, exceedsLimit: false });
  const suggested = await post(
    "/tables/columns/suggest",
    { sourceIds: ["src_1"], instruction: "trials", language: "en" },
    { "accept-language": "en-GB" },
  );
  assert.equal(suggested.status, 200);
  const [input] = mocks.requestTableColumnSuggestions.mock.calls[0]!;
  assert.equal(input.userId, "user_1");
  assert.equal(input.uiLocale, "en-GB");
  assert.deepEqual(input.billing, { marker: "billing" });
  assert.deepEqual(input.request, { sourceIds: ["src_1"], instruction: "trials", language: "en" });
  assert.equal((await post("/tables/estimate", body)).status, 200);
  assert.equal(mocks.estimateTable.mock.calls[0]![0].workspaceId, "workspace_1");
});

test("regenerate answers 202 and freshness 200", async () => {
  signedIn();
  mocks.requestTableRegeneration.mockResolvedValue({ artifactId: "art_1", versionNo: 2, status: "pending" });
  mocks.getTableFreshness.mockResolvedValue({ state: "fresh", changedSourceIds: [], deletedSourceIds: [] });
  const regenerated = await post("/tables/artifacts/art_1/regenerate", { instruction: "events" });
  assert.equal(regenerated.status, 202);
  const [input] = mocks.requestTableRegeneration.mock.calls[0]!;
  assert.equal(input.artifactId, "art_1");
  assert.deepEqual(input.body, { instruction: "events" });
  // An empty object and no body at all both keep the recipe.
  assert.equal((await post("/tables/artifacts/art_1/regenerate", {})).status, 202);
  const bare = await app().request(`${base}/tables/artifacts/art_1/regenerate`, { method: "POST" });
  assert.equal(bare.status, 202);
  assert.deepEqual(mocks.requestTableRegeneration.mock.calls.at(-1)![0].body, {});
  const fresh = await app().request(`${base}/tables/artifacts/art_1/freshness`);
  assert.equal(fresh.status, 200);
  assert.equal(mocks.getTableFreshness.mock.calls[0]![0].artifactId, "art_1");
});

test("table errors keep their code and status", async () => {
  signedIn();
  mocks.requestTableArtifact.mockRejectedValue(new ContentError(404, "SOURCE_NOT_READABLE", "nope"));
  const response = await post("/tables/artifacts", body);
  assert.equal(response.status, 404);
  assert.match(JSON.stringify(await readJson(response)), /SOURCE_NOT_READABLE/);
  mocks.requestTableArtifact.mockRejectedValue(new ContentError(429, "TABLE_TOO_MANY_RUNNING", "busy"));
  assert.equal((await post("/tables/artifacts", body)).status, 429);
});
