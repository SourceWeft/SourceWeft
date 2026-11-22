import { beforeEach, expect, test, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  exportThread: vi.fn(),
}));

vi.mock("../../../modules/auth", () => ({
  auth: {},
  getSession: async () => null,
}));
vi.mock("../../middleware/auth-session", () => ({
  requireSession: mocks.session,
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
}));
vi.mock("../../../modules/threads/export/service", () => ({
  exportThread: mocks.exportThread,
}));

import { ContentError } from "../../../modules/content/errors";
import { ApiResponse, toApiError } from "../../response/api-response";
import { registerThreadRoutes } from "./threads";

const app = new Hono();
const routes = new Hono();
registerThreadRoutes(routes);
app.route("/v1/workspaces/:workspaceId", routes);
app.onError((error, c) => ApiResponse.error(c, toApiError(error)));

function exportRequest(query = "") {
  return app.request(`/v1/workspaces/ws-1/threads/t-1/export${query}`);
}

beforeEach(() => {
  mocks.session.mockReset().mockResolvedValue({ user: { id: "user-1" } });
  mocks.exportThread.mockReset();
});

test("a text chat downloads as Markdown", async () => {
  mocks.exportThread.mockResolvedValue({
    kind: "markdown",
    fileName: "预算.md",
    text: "# 预算\n",
  });

  const response = await exportRequest("?locale=zh-CN&timeZone=Asia/Shanghai");

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(
    "text/markdown; charset=utf-8",
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-disposition")).toBe(
    "attachment; filename=\"__.md\"; filename*=UTF-8''%E9%A2%84%E7%AE%97.md",
  );
  expect(await response.text()).toBe("# 预算\n");
  expect(mocks.exportThread).toHaveBeenCalledWith({
    workspaceId: "ws-1",
    threadId: "t-1",
    userId: "user-1",
    locale: "zh-CN",
    timeZone: "Asia/Shanghai",
  });
});

test("a chat with images downloads as a zip", async () => {
  mocks.exportThread.mockResolvedValue({
    kind: "zip",
    fileName: "Charts.zip",
    stream: new Response("PK").body,
  });

  const response = await exportRequest();

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/zip");
  expect(await response.text()).toBe("PK");
  expect(mocks.exportThread).toHaveBeenCalledWith(
    expect.objectContaining({ locale: "en", timeZone: "UTC" }),
  );
});

test("an unknown time zone is a validation error", async () => {
  const response = await exportRequest("?timeZone=Mars/Base");

  expect(response.status).toBe(400);
  expect((await response.json()).code).toBe("VALIDATION_ERROR");
  expect(mocks.exportThread).not.toHaveBeenCalled();
});

test("a chat the member cannot see is not found", async () => {
  mocks.exportThread.mockRejectedValue(
    new ContentError(404, "THREAD_NOT_FOUND", "Thread not found"),
  );

  const response = await exportRequest();

  expect(response.status).toBe(404);
  expect((await response.json()).code).toBe("THREAD_NOT_FOUND");
});

test("export needs a session", async () => {
  mocks.session.mockResolvedValue(null);

  const response = await exportRequest();

  expect(response.status).toBe(401);
});
