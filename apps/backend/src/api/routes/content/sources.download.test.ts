import { beforeEach, expect, test, vi } from "vitest";
import { Hono } from "hono";
const mocks = vi.hoisted(() => ({ session: vi.fn(), download: vi.fn() }));
vi.mock("../../../modules/sources", () => ({
  contentSourceService: { downloadSource: mocks.download },
  sourceIndexingService: {},
  sourceParsingService: {},
}));
vi.mock("../../middleware/auth-session", () => ({
  requireSession: mocks.session,
  getSessionUserId: () => "user",
}));
import { registerSourceRoutes } from "./sources";
const app = new Hono();
const routes = new Hono();
registerSourceRoutes(routes);
app.route("/v1/workspaces/:workspaceId", routes);
app.onError((error, c) => c.json({ message: error.message }, 401));
beforeEach(() => {
  mocks.session.mockReset().mockResolvedValue({ user: { id: "user" } });
  mocks.download.mockReset();
});
test("proxy download keeps private storage names out of the browser and returns original bytes", async () => {
  mocks.download.mockResolvedValue({
    body: Buffer.from("original"),
    fileName: "sample.html",
    contentType: "text/html",
  });
  const r = await app.request(
    "/v1/workspaces/workspace/sources/source/download?inline=true",
  );
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("original");
  expect(r.headers.get("location")).toBeNull();
  expect(r.headers.get("content-security-policy")).toBe("sandbox");
  expect(r.headers.get("content-disposition")).toContain("inline");
  expect(mocks.download).toHaveBeenCalledWith({
    workspaceId: "workspace",
    sourceId: "source",
    userId: "user",
  });
});
test("direct mode retains its explicit signed redirect", async () => {
  mocks.download.mockResolvedValue({ url: "https://storage.example/signed" });
  const r = await app.request(
    "/v1/workspaces/workspace/sources/source/download",
  );
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("https://storage.example/signed");
});
test("unauthenticated downloads cannot reach storage", async () => {
  mocks.session.mockResolvedValue(null);
  const r = await app.request(
    "/v1/workspaces/workspace/sources/source/download",
  );
  expect(r.status).toBe(401);
  expect(mocks.download).not.toHaveBeenCalled();
});
