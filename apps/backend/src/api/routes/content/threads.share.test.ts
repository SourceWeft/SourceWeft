import { beforeEach, expect, test, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  getThreadShare: vi.fn(),
  shareThread: vi.fn(),
  updateThreadShare: vi.fn(),
  revokeThreadShare: vi.fn(),
}));

vi.mock("../../../modules/auth", () => ({
  auth: {},
  getSession: async () => null,
}));
vi.mock("../../middleware/auth-session", () => ({
  requireSession: mocks.session,
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
}));
vi.mock("../../../modules/threads/share/service", () => ({
  threadShareService: {
    getThreadShare: mocks.getThreadShare,
    shareThread: mocks.shareThread,
    updateThreadShare: mocks.updateThreadShare,
    revokeThreadShare: mocks.revokeThreadShare,
  },
}));

import { ApiResponse, toApiError } from "../../response/api-response";
import { registerThreadRoutes } from "./threads";

const app = new Hono();
const routes = new Hono();
registerThreadRoutes(routes);
app.route("/v1/workspaces/:workspaceId", routes);
app.onError((error, c) => ApiResponse.error(c, toApiError(error)));

const SHARE = {
  token: "tok-1",
  url: "https://example.test/s/tok-1",
  targetType: "thread",
  targetId: "t-1",
  isPublic: true,
  noindex: true,
  accessLevel: "viewer",
  viewCount: 0,
  expiresAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  publicRecordCollections: [],
  snapshotTakenAt: "2026-01-01T00:00:00.000Z",
};

function shareRequest(method: string, body?: unknown) {
  return app.request("/v1/workspaces/ws-1/threads/t-1/share", {
    method,
    ...(body !== undefined
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
}

beforeEach(() => {
  mocks.session.mockReset().mockResolvedValue({ user: { id: "user-1" } });
  mocks.getThreadShare.mockReset();
  mocks.shareThread.mockReset();
  mocks.updateThreadShare.mockReset();
  mocks.revokeThreadShare.mockReset();
});

test("GET returns the chat's current share", async () => {
  mocks.getThreadShare.mockResolvedValue({ ok: true, value: SHARE });

  const response = await shareRequest("GET");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ share: SHARE });
  expect(mocks.getThreadShare).toHaveBeenCalledWith({
    workspaceId: "ws-1",
    threadId: "t-1",
    userId: "user-1",
  });
});

test("GET reports an unshared chat as null", async () => {
  mocks.getThreadShare.mockResolvedValue({ ok: true, value: null });

  const response = await shareRequest("GET");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ share: null });
});

test("POST shares the chat and passes noindex through", async () => {
  mocks.shareThread.mockResolvedValue({ ok: true, value: SHARE });

  const response = await shareRequest("POST", { noindex: false });

  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ share: SHARE });
  expect(mocks.shareThread).toHaveBeenCalledWith({
    workspaceId: "ws-1",
    threadId: "t-1",
    userId: "user-1",
    noindex: false,
  });
});

test("POST with no body still shares (noindex left to the service default)", async () => {
  mocks.shareThread.mockResolvedValue({ ok: true, value: SHARE });

  const response = await shareRequest("POST");

  expect(response.status).toBe(201);
  expect(mocks.shareThread).toHaveBeenCalledWith({
    workspaceId: "ws-1",
    threadId: "t-1",
    userId: "user-1",
    noindex: undefined,
  });
});

test("PATCH updates noindex", async () => {
  mocks.updateThreadShare.mockResolvedValue({ ok: true, value: SHARE });

  const response = await shareRequest("PATCH", { noindex: true });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ share: SHARE });
  expect(mocks.updateThreadShare).toHaveBeenCalledWith({
    workspaceId: "ws-1",
    threadId: "t-1",
    userId: "user-1",
    noindex: true,
  });
});

test("PATCH requires noindex in the body", async () => {
  const response = await shareRequest("PATCH", {});

  expect(response.status).toBe(400);
  expect((await response.json()).code).toBe("VALIDATION_ERROR");
  expect(mocks.updateThreadShare).not.toHaveBeenCalled();
});

test("DELETE revokes the share", async () => {
  mocks.revokeThreadShare.mockResolvedValue({ ok: true, value: true });

  const response = await shareRequest("DELETE");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ revoked: true });
  expect(mocks.revokeThreadShare).toHaveBeenCalledWith({
    workspaceId: "ws-1",
    threadId: "t-1",
    userId: "user-1",
  });
});

test("forbidden maps to 403 with the chat sharing message", async () => {
  mocks.getThreadShare.mockResolvedValue({ ok: false, reason: "forbidden" });

  const response = await shareRequest("GET");

  expect(response.status).toBe(403);
  const body = await response.json();
  expect(body.code).toBe("SHARE_FORBIDDEN");
  expect(body.message).toBe(
    "Only the chat's creator or a workspace admin can share it.",
  );
});

test("not_found maps to 404 THREAD_NOT_FOUND on every verb", async () => {
  mocks.getThreadShare.mockResolvedValue({ ok: false, reason: "not_found" });
  mocks.shareThread.mockResolvedValue({ ok: false, reason: "not_found" });
  mocks.updateThreadShare.mockResolvedValue({
    ok: false,
    reason: "not_found",
  });
  mocks.revokeThreadShare.mockResolvedValue({
    ok: false,
    reason: "not_found",
  });

  for (const [method, body] of [
    ["GET", undefined],
    ["POST", {}],
    ["PATCH", { noindex: true }],
    ["DELETE", undefined],
  ] as const) {
    const response = await shareRequest(method, body);
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("THREAD_NOT_FOUND");
  }
});

test("share routes need a session", async () => {
  mocks.session.mockResolvedValue(null);

  const response = await shareRequest("GET");

  expect(response.status).toBe(401);
});
