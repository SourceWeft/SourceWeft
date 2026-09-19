import { Hono } from "hono";
import { beforeEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({
  session: true,
  online: true,
  content: Buffer.from("disk content"),
  owned: vi.fn(),
  folderCall: vi.fn(),
}));
vi.mock("../middleware/auth-session", () => ({
  requireSession: async () =>
    state.session
      ? { user: { id: "owner" }, session: { id: "session" } }
      : null,
}));
vi.mock("../../modules/threads/service", () => ({ contentThreadService: {} }));
vi.mock("../../modules/devices/access", () => ({
  resolveLocalCaller: vi.fn(async () => ({ sessionId: "session" })),
  connectRemote: vi.fn(),
  revokeFolderAccess: vi.fn(),
  createNativeAccess: vi.fn(),
  setRemotePolicy: vi.fn(),
  requireDeviceAccess: vi.fn(),
}));
vi.mock("../../modules/devices/service", () => ({
  localCall: async (input: unknown) => {
    state.folderCall(input);
    return {
      content: state.content.toString("base64"),
      root: "/project",
      path: "/project",
      files: [],
    };
  },
  ownedThread: async (...args: unknown[]) => {
    state.owned(...args);
    return {
      id: "t",
      workspaceId: "w",
      teamId: "team",
      executionTargetJson: { kind: "local", deviceId: "pc" },
    };
  },
  isOnline: () => state.online,
  claimEnrollment: vi.fn(),
  createEnrollment: vi.fn(),
}));
vi.mock("../../modules/devices/provider", () => ({
  localProviderForTurn: async () => {
    if (!state.online)
      throw Object.assign(new Error("PC offline"), {
        statusCode: 409,
        code: "DEVICE_OFFLINE",
      });
    return {
      createProvider: () => ({
        pathPolicy: { workspaceRoot: "/Users/test/Local task" },
        getSandbox: async () => ({ id: "native" }),
        listFiles: async () => [
          {
            path: "/Users/test/Local task/report.txt",
            size: state.content.length,
          },
        ],
        downloadFile: async () => state.content,
      }),
    };
  },
}));
import { registerLocalDeviceRoutes } from "./local-devices";
function app() {
  const app = new Hono();
  app.onError((error, c) =>
    c.json(
      { code: (error as { code?: string }).code, message: error.message },
      ((error as { statusCode?: number }).statusCode as 409) ?? 500,
    ),
  );
  registerLocalDeviceRoutes(app);
  return app;
}
const route = "/v1/workspaces/w/threads/t/local-files";
beforeEach(() => {
  state.session = true;
  state.online = true;
  state.content = Buffer.from("disk content");
  vi.clearAllMocks();
});
test("directory list and preview are authenticated live reads with no HTTP caching", async () => {
  const server = app();
  const list = await server.request(route);
  expect(list.status).toBe(200);
  expect(list.headers.get("cache-control")).toBe("no-store");
  expect((await list.json()).root).toBe("/Users/test/Local task");
  expect(state.owned).toHaveBeenCalledWith("owner", "w", "t");
  state.content = Buffer.from("external edit");
  expect(
    (
      await (
        await server.request(
          `${route}?content=true&path=${encodeURIComponent("/Users/test/Local task/report.txt")}`,
        )
      ).json()
    ).content,
  ).toBe("external edit");
  state.online = false;
  expect((await server.request(route)).status).toBe(409);
  state.session = false;
  expect((await server.request(route)).status).toBe(401);
});
test("binary download preserves bytes while text preview rejects binary content", async () => {
  const server = app();
  state.content = Buffer.from([0, 255, 1]);
  const result = await server.request(
    `${route}?download=true&path=${encodeURIComponent("/Users/test/Local task/a.bin")}`,
  );
  expect(Buffer.from(await result.arrayBuffer())).toEqual(state.content);
  expect(result.headers.get("content-disposition")).toContain("a.bin");
  expect((await server.request(`${route}?content=true`)).status).toBe(415);
});

test("draft folder listing and download use a folder scope without creating a conversation", async () => {
  const server = app();
  const list = await server.request("/v1/local-devices/pc/folders/grant/files");
  expect(list.status).toBe(200);
  expect(list.headers.get("cache-control")).toBe("no-store");
  expect(state.folderCall).toHaveBeenCalledWith(
    expect.objectContaining({
      threadId: null,
      deviceId: "pc",
      userId: "owner",
      action: "folder.list",
      payload: { folderId: "grant", path: "" },
    }),
  );
  expect(state.owned).not.toHaveBeenCalled();
  const binary = await server.request(
    "/v1/local-devices/pc/folders/grant/files?path=hello.txt&download=true",
  );
  expect(Buffer.from(await binary.arrayBuffer())).toEqual(state.content);
  state.session = false;
  expect(
    (await server.request("/v1/local-devices/pc/folders/grant/files")).status,
  ).toBe(401);
});
