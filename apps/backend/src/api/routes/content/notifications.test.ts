import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createWorkspaceRouteTestApp, readJson } from "../../../test/hono";

const inbox = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  unreadCount: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  requireSession: vi.fn(),
}));
const guards = vi.hoisted(() => ({ requireContentWorkspace: vi.fn() }));

vi.mock("../../middleware/auth-session", () => auth);
vi.mock("../../../modules/workspace/guards", () => guards);
vi.mock("../../../modules/notifications", async () => {
  const kinds = await vi.importActual<
    typeof import("../../../modules/notifications/kinds")
  >("../../../modules/notifications/kinds");
  return { ...inbox, notificationPath: kinds.notificationPath };
});

import { registerNotificationRoutes } from "./notifications";

const app = () => createWorkspaceRouteTestApp(registerNotificationRoutes);
const BASE = "/v1/workspaces/ws_1/notifications";
const WHO = { userId: "user_1", teamId: "team_1" };

const row = {
  id: "n_1",
  kind: "task_run_succeeded",
  ref: { kind: "agent_task", id: "task_1" },
  payload: { taskName: "Digest", threadId: "th_1" },
  occurrenceCount: 1,
  readAt: null,
  createdAt: new Date("2026-11-19T08:00:00Z"),
  lastOccurredAt: new Date("2026-11-19T08:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUserId.mockReturnValue("user_1");
  auth.requireSession.mockResolvedValue({ user: { id: "user_1" } });
  guards.requireContentWorkspace.mockResolvedValue({
    id: "ws_1",
    organizationId: "team_1",
  });
  inbox.listNotifications.mockResolvedValue({ items: [row], nextCursor: null });
  inbox.unreadCount.mockResolvedValue(3);
  inbox.markRead.mockResolvedValue(true);
  inbox.markAllRead.mockResolvedValue(2);
});

test("every route needs a session", async () => {
  auth.requireSession.mockResolvedValue(null);
  for (const [method, path] of [
    ["GET", ""],
    ["GET", "/unread-count"],
    ["POST", "/read-all"],
    ["POST", "/n_1/read"],
  ]) {
    const response = await app().request(`${BASE}${path}`, { method });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  assert.equal(guards.requireContentWorkspace.mock.calls.length, 0);
});

test("the inbox is the signed-in person's in the workspace's team, whatever the query says", async () => {
  await app().request(`${BASE}?userId=victim&teamId=team_x&limit=5`);
  await app().request(`${BASE}/unread-count?userId=victim`);
  await app().request(`${BASE}/read-all`, { method: "POST" });
  await app().request(`${BASE}/n_1/read`, { method: "POST" });
  assert.deepEqual(inbox.listNotifications.mock.calls[0]![0], {
    ...WHO,
    limit: 5,
  });
  assert.deepEqual(inbox.unreadCount.mock.calls[0]![0], WHO);
  assert.deepEqual(inbox.markAllRead.mock.calls[0]![0], WHO);
  assert.deepEqual(inbox.markRead.mock.calls[0]![0], { ...WHO, id: "n_1" });
});

test("a list row carries ISO dates and the path it leads to", async () => {
  const response = await app().request(BASE);
  const data = (await readJson(response)) as {
    notifications: Array<Record<string, unknown>>;
    nextCursor: string | null;
  };
  assert.equal(data.notifications[0]!.createdAt, "2026-11-19T08:00:00.000Z");
  assert.equal(data.notifications[0]!.readAt, null);
  assert.equal(data.notifications[0]!.path, "/dashboard/chat/th_1");
  assert.equal(data.nextCursor, null);
});

test("filters and the page size are validated", async () => {
  await app().request(`${BASE}?unreadOnly=true`);
  assert.equal(inbox.listNotifications.mock.calls[0]![0].unreadOnly, true);
  assert.equal((await app().request(`${BASE}?limit=0`)).status, 400);
  assert.equal((await app().request(`${BASE}?unreadOnly=maybe`)).status, 400);
});

test("a bad cursor answers 400, not 500", async () => {
  inbox.listNotifications.mockRejectedValue(
    new Error("Invalid notifications cursor"),
  );
  assert.equal((await app().request(`${BASE}?cursor=zzz`)).status, 400);
});

test("reading somebody else's notification answers 404", async () => {
  inbox.markRead.mockResolvedValue(false);
  const response = await app().request(`${BASE}/n_other/read`, {
    method: "POST",
  });
  assert.equal(response.status, 404);
});
