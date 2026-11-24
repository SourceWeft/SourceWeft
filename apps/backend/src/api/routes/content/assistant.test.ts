import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createWorkspaceRouteTestApp, readJson } from "../../../test/hono";
import { AssistantError } from "../../../modules/assistants/errors";

const service = vi.hoisted(() => ({
  get: vi.fn(),
  enable: vi.fn(),
  update: vi.fn(),
  listFeed: vi.fn(),
  postMessage: vi.fn(),
  listTickets: vi.fn(),
  closeTicket: vi.fn(),
  retryTicket: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  requireSession: vi.fn(),
}));
const guards = vi.hoisted(() => ({ requireContentWorkspace: vi.fn() }));

vi.mock("../../middleware/auth-session", () => auth);
vi.mock("../../../modules/workspace/guards", () => guards);
vi.mock("../../../modules/assistants", () => ({ assistantService: service }));

import { registerAssistantRoutes } from "./assistant";

const app = () => createWorkspaceRouteTestApp(registerAssistantRoutes);
const BASE = "/v1/workspaces/ws_1/assistant";
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

const assistantEntity = {
  id: "asst_1",
  workspaceId: "ws_1",
  routerThreadId: "th_router",
  stewardUserId: "user_1",
  status: "active",
  statusReason: null,
  version: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const ticketEntity = {
  id: "ticket_1",
  assistantId: "asst_1",
  workerThreadId: "th_worker",
  title: "Do the thing",
  goal: "Finish the thing",
  payerUserId: "user_1",
  origin: "explicit",
  stage: "queued",
  outcome: null,
  blockedReason: null,
  creditCap: 500,
  consecutiveFailures: 0,
  lastReportSummary: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  endedAt: null,
};

const feedItem = {
  id: "item_1",
  assistantId: "asst_1",
  kind: "member_message",
  authorUserId: "user_1",
  text: "hello",
  ticketId: null,
  replyToItemId: null,
  createdAt: "2026-11-01T00:00:00.000Z",
};

/** Every route, with a body it accepts (for the ones that take one). */
const ROUTES: Array<[string, string, unknown?]> = [
  ["GET", ""],
  ["POST", "", undefined],
  ["PATCH", "", { version: 1, action: "pause" }],
  ["GET", "/feed"],
  ["POST", "/messages", { text: "hi", idempotencyKey: "key-1" }],
  ["GET", "/tickets"],
  ["POST", "/tickets/ticket_1/close", { idempotencyKey: "key-2" }],
  ["POST", "/tickets/ticket_1/retry", { idempotencyKey: "key-3" }],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUserId.mockReturnValue("user_1");
  auth.requireSession.mockResolvedValue({ user: { id: "user_1" } });
  guards.requireContentWorkspace.mockResolvedValue({
    id: "ws_1",
    organizationId: "team_1",
  });
  service.get.mockResolvedValue({ assistant: assistantEntity });
  service.enable.mockResolvedValue(assistantEntity);
  service.update.mockResolvedValue({ assistant: assistantEntity });
  service.listFeed.mockResolvedValue({ items: [feedItem], nextCursor: null });
  service.postMessage.mockResolvedValue({ item: feedItem, created: true });
  service.listTickets.mockResolvedValue({ tickets: [ticketEntity] });
  service.closeTicket.mockResolvedValue({ ticket: ticketEntity });
  service.retryTicket.mockResolvedValue({
    ticket: ticketEntity,
    created: true,
  });
});

test("every route refuses a request without a session and touches nothing", async () => {
  auth.requireSession.mockResolvedValue(null);
  for (const [method, path, requestBody] of ROUTES) {
    assert.equal(
      (await request(method, path, requestBody)).status,
      401,
      `${method} ${path}`,
    );
  }
  for (const mock of Object.values(service))
    assert.equal(mock.mock.calls.length, 0);
  assert.equal(guards.requireContentWorkspace.mock.calls.length, 0);
});

test("every route acts as the signed-in person in the route's workspace", async () => {
  for (const [method, path, requestBody] of ROUTES) {
    const response = await request(method, path, requestBody);
    assert.ok(response.status < 300, `${method} ${path}: ${response.status}`);
  }
  const calls = Object.entries(service).flatMap(([name, mock]) =>
    mock.mock.calls.map((args) => [name, args[0]] as const),
  );
  assert.equal(calls.length, ROUTES.length);
  for (const [name, who] of calls) assert.deepEqual(who, WHO, name);
  assert.equal(service.closeTicket.mock.calls[0]![1], "ticket_1");
  assert.equal(service.retryTicket.mock.calls[0]![1], "ticket_1");
});

test("a request body with an unknown field is rejected as 400", async () => {
  const response = await request("POST", "/messages", {
    text: "hi",
    idempotencyKey: "key-1",
    extra: "nope",
  });
  assert.equal(response.status, 400);
  assert.equal(service.postMessage.mock.calls.length, 0);
});

test("GET /assistant returns the assistantResponse shape", async () => {
  const response = await app().request(BASE);
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { assistant: assistantEntity });
});

test("POST /assistant enables and answers 201 wrapped as assistantResponse", async () => {
  const response = await request("POST", "");
  assert.equal(response.status, 201);
  assert.deepEqual(await readJson(response), { assistant: assistantEntity });
});

test("PATCH /assistant validates the body and forwards it", async () => {
  assert.equal((await request("PATCH", "", {})).status, 400);
  assert.equal(
    (await request("PATCH", "", { version: "x", action: "pause" })).status,
    400,
  );
  const response = await request("PATCH", "", {
    version: 1,
    action: "pause",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(service.update.mock.calls[0]!.slice(1), [
    { version: 1, action: "pause" },
  ]);
});

test("GET /assistant/feed parses before/limit from the query", async () => {
  await app().request(`${BASE}/feed?before=item_5&limit=10`);
  assert.deepEqual(service.listFeed.mock.calls[0]!.slice(1), [
    { before: "item_5", limit: 10 },
  ]);
  assert.equal((await app().request(`${BASE}/feed?limit=0`)).status, 400);
});

test("postMessage answers 201 when new and 200 on replay", async () => {
  service.postMessage.mockResolvedValue({ item: feedItem, created: true });
  const created = await request("POST", "/messages", {
    text: "hi",
    idempotencyKey: "key-1",
  });
  assert.equal(created.status, 201);
  assert.deepEqual(await readJson(created), { item: feedItem });

  service.postMessage.mockResolvedValue({ item: feedItem, created: false });
  const replayed = await request("POST", "/messages", {
    text: "hi",
    idempotencyKey: "key-1",
  });
  assert.equal(replayed.status, 200);
});

test("postMessage requires text and idempotencyKey", async () => {
  assert.equal((await request("POST", "/messages", {})).status, 400);
  assert.equal((await request("POST", "/messages", { text: "" })).status, 400);
  assert.equal(service.postMessage.mock.calls.length, 0);
});

test("GET /assistant/tickets parses an optional stage filter", async () => {
  await app().request(`${BASE}/tickets?stage=queued`);
  assert.deepEqual(service.listTickets.mock.calls[0]!.slice(1), [
    { stage: "queued" },
  ]);
  assert.equal(
    (await app().request(`${BASE}/tickets?stage=not-a-stage`)).status,
    400,
  );
});

test("close and retry require an idempotencyKey and pass the ticket id", async () => {
  assert.equal(
    (await request("POST", "/tickets/ticket_1/close", {})).status,
    400,
  );
  assert.equal(
    (await request("POST", "/tickets/ticket_1/retry", {})).status,
    400,
  );
  await request("POST", "/tickets/ticket_1/close", { idempotencyKey: "k" });
  await request("POST", "/tickets/ticket_1/retry", { idempotencyKey: "k" });
  assert.deepEqual(service.closeTicket.mock.calls[0]!.slice(1), [
    "ticket_1",
    { idempotencyKey: "k" },
  ]);
  assert.deepEqual(service.retryTicket.mock.calls[0]!.slice(1), [
    "ticket_1",
    { idempotencyKey: "k" },
  ]);
  assert.equal(
    (await request("POST", "/tickets/ticket_1/close", { idempotencyKey: "k" }))
      .status,
    200,
  );
});

test("retryTicket answers 201 when a new retry was recorded and 200 on an idempotent replay", async () => {
  service.retryTicket.mockResolvedValue({
    ticket: ticketEntity,
    created: true,
  });
  const created = await request("POST", "/tickets/ticket_1/retry", {
    idempotencyKey: "k",
  });
  assert.equal(created.status, 201);
  assert.deepEqual(await readJson(created), { ticket: ticketEntity });

  service.retryTicket.mockResolvedValue({
    ticket: ticketEntity,
    created: false,
  });
  const replayed = await request("POST", "/tickets/ticket_1/retry", {
    idempotencyKey: "k",
  });
  assert.equal(replayed.status, 200);
  assert.deepEqual(await readJson(replayed), { ticket: ticketEntity });
});

test("AssistantError is mapped to its status code and error code", async () => {
  service.get.mockRejectedValue(
    new AssistantError(404, "ASSISTANT_NOT_FOUND", "Assistant not found"),
  );
  const notFound = await app().request(BASE);
  assert.equal(notFound.status, 404);
  assert.deepEqual(await readJson(notFound), {
    code: "ASSISTANT_NOT_FOUND",
    message: "Assistant not found",
  });

  service.update.mockRejectedValue(
    new AssistantError(409, "ASSISTANT_VERSION_CONFLICT", "Stale version", {
      version: 2,
    }),
  );
  const conflict = await request("PATCH", "", { version: 1, action: "pause" });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await readJson(conflict), {
    code: "ASSISTANT_VERSION_CONFLICT",
    message: "Stale version",
    details: { version: 2 },
  });
});

test("a non-member workspace answers 404 before the service is called", async () => {
  const { ContentError } = await import("../../../modules/content/errors");
  guards.requireContentWorkspace.mockRejectedValue(
    new ContentError(404, "WORKSPACE_NOT_FOUND", "Workspace not found"),
  );
  const response = await app().request(BASE);
  assert.equal(response.status, 404);
  assert.equal(service.get.mock.calls.length, 0);
});
