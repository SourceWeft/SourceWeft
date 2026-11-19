import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createWorkspaceRouteTestApp, readJson } from "../../../test/hono";
import { AgentTaskError } from "../../../modules/agent-tasks/errors";

const service = vi.hoisted(() => ({
  listTasks: vi.fn(),
  createTask: vi.fn(),
  previewSchedule: vi.fn(),
  getTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  pauseTask: vi.fn(),
  resumeTask: vi.fn(),
  activateTask: vi.fn(),
  runTaskNow: vi.fn(),
  listTaskRuns: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  requireSession: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => auth);
vi.mock("../../../modules/agent-tasks", () => ({ agentTaskService: service }));

import { registerAgentTaskRoutes } from "./agent-tasks";

const app = () => createWorkspaceRouteTestApp(registerAgentTaskRoutes);
const BASE = "/v1/workspaces/ws_1/agent-tasks";
const WHO = { workspaceId: "ws_1", userId: "user_1" };

const request = (method: string, path: string, body?: unknown) =>
  app().request(`${BASE}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

const createBody = {
  name: "Morning digest",
  prompt: "Summarize what is new",
  request: {},
  rule: { kind: "daily", time: "08:00" },
  timezone: "Asia/Shanghai",
};

/** Every route, with a body it accepts. */
const ROUTES: Array<[string, string, unknown?]> = [
  ["GET", ""],
  ["POST", "", createBody],
  ["POST", "/preview-schedule", { rule: createBody.rule, timezone: "UTC" }],
  ["GET", "/task_1"],
  ["PATCH", "/task_1", { version: 1, name: "Digest" }],
  ["DELETE", "/task_1"],
  ["POST", "/task_1/pause"],
  ["POST", "/task_1/resume"],
  ["POST", "/task_1/activate"],
  ["POST", "/task_1/run-now", { idempotencyKey: "click-1" }],
  ["GET", "/task_1/runs"],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUserId.mockReturnValue("user_1");
  auth.requireSession.mockResolvedValue({
    user: { id: "user_1" },
    session: { id: "s", userId: "user_1" },
  });
  for (const mock of Object.values(service)) mock.mockResolvedValue({});
  service.runTaskNow.mockResolvedValue({ run: { id: "run_1" }, created: true });
});

test("every route refuses a request without a session and touches nothing", async () => {
  auth.requireSession.mockResolvedValue(null);
  for (const [method, path, body] of ROUTES) {
    assert.equal(
      (await request(method, path, body)).status,
      401,
      `${method} ${path}`,
    );
  }
  for (const mock of Object.values(service))
    assert.equal(mock.mock.calls.length, 0);
});

test("every route acts as the signed-in person in the route's workspace, whatever the request says", async () => {
  for (const [method, path, body] of ROUTES) {
    // An owner, team or workspace smuggled into the body or the query.
    const spoofed =
      body === undefined
        ? undefined
        : {
            ...(body as object),
            ownerUserId: "victim",
            userId: "victim",
            teamId: "t_x",
            workspaceId: "ws_x",
          };
    const response = await request(
      method,
      `${path}${method === "GET" ? "?userId=victim&workspaceId=ws_x" : ""}`,
      body,
    );
    assert.ok(response.status < 300, `${method} ${path}: ${response.status}`);
    if (spoofed) {
      // The schemas are strict: a body naming an owner is refused outright.
      assert.equal(
        (await request(method, path, spoofed)).status,
        400,
        `${method} ${path}`,
      );
    }
  }
  const calls = Object.entries(service).flatMap(([name, mock]) =>
    mock.mock.calls.map((args) => [name, args[0]] as const),
  );
  assert.equal(calls.length, ROUTES.length);
  for (const [name, who] of calls) assert.deepEqual(who, WHO, name);
  // Item routes pass the id from the path.
  for (const name of [
    "getTask",
    "updateTask",
    "deleteTask",
    "pauseTask",
    "resumeTask",
    "activateTask",
    "runTaskNow",
    "listTaskRuns",
  ] as const) {
    assert.equal(service[name].mock.calls[0]![1], "task_1", name);
  }
});

test("create validates the body, applies defaults and answers 201", async () => {
  service.createTask.mockResolvedValue({ task: { id: "task_1" } });
  const response = await request("POST", "", createBody);
  assert.equal(response.status, 201);
  assert.deepEqual(await readJson(response), { task: { id: "task_1" } });
  assert.deepEqual(service.createTask.mock.calls[0]![1], {
    ...createBody,
    request: {
      sourceIds: [],
      skillIds: [],
      mcp: { installIds: [] },
      webAccess: false,
    },
    activate: false,
  });

  for (const bad of [
    { ...createBody, name: "" },
    { ...createBody, timezone: "+08:00" },
    { ...createBody, rule: { kind: "daily", time: "8am" } },
    { ...createBody, request: { tools: { execute: { enabled: true } } } },
    null,
  ]) {
    assert.equal((await request("POST", "", bad)).status, 400);
  }
  assert.equal(service.createTask.mock.calls.length, 1);
});

test("an edit needs the version it was made against and at least one change", async () => {
  assert.equal((await request("PATCH", "/task_1", { name: "x" })).status, 400);
  assert.equal((await request("PATCH", "/task_1", { version: 2 })).status, 400);
  assert.equal(service.updateTask.mock.calls.length, 0);
  assert.equal(
    (await request("PATCH", "/task_1", { version: 2, prompt: "p" })).status,
    200,
  );
  assert.deepEqual(service.updateTask.mock.calls[0]!.slice(1), [
    "task_1",
    { version: 2, prompt: "p" },
  ]);
});

test("run now needs a key, answers 201 for a new run and 200 for a repeated click", async () => {
  assert.equal((await request("POST", "/task_1/run-now", {})).status, 400);
  const created = await request("POST", "/task_1/run-now", {
    idempotencyKey: "click-1",
  });
  assert.equal(created.status, 201);
  assert.deepEqual(await readJson(created), { run: { id: "run_1" } });
  service.runTaskNow.mockResolvedValue({
    run: { id: "run_1" },
    created: false,
  });
  assert.equal(
    (await request("POST", "/task_1/run-now", { idempotencyKey: "click-1" }))
      .status,
    200,
  );
});

test("a refusal from the service keeps its status and code", async () => {
  service.runTaskNow.mockRejectedValue(
    new AgentTaskError(429, "AGENT_TASK_RUN_RATE_LIMITED", "Too many runs", {
      retryAfterSeconds: 120,
    }),
  );
  const limited = await request("POST", "/task_1/run-now", {
    idempotencyKey: "k",
  });
  assert.equal(limited.status, 429);
  assert.deepEqual(await readJson(limited), {
    code: "AGENT_TASK_RUN_RATE_LIMITED",
    message: "Too many runs",
    details: { retryAfterSeconds: 120 },
  });
  service.getTask.mockRejectedValue(
    new AgentTaskError(404, "AGENT_TASK_NOT_FOUND", "Task not found"),
  );
  assert.equal((await request("GET", "/someone-elses")).status, 404);
});

test("the run history reads its page from the query", async () => {
  await request("GET", "/task_1/runs?limit=5&cursor=abc");
  assert.deepEqual(service.listTaskRuns.mock.calls[0]!.slice(1), [
    "task_1",
    { limit: 5, cursor: "abc" },
  ]);
  assert.equal((await request("GET", "/task_1/runs?limit=500")).status, 400);
});
