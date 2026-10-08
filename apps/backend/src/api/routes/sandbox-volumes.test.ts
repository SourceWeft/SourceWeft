import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import { VolumeControlUnauthorized } from "@sourceweft/sandbox-volume";
vi.mock("../../modules/threads/agent/sandbox-service/volume", () => ({
  sandboxVolumeService: () => null,
}));
vi.mock("../../shared/logger", () => ({ logger: { warn: vi.fn() } }));
import { registerSandboxVolumeRoutes } from "./sandbox-volumes";

const token = `svctl_${"a".repeat(43)}`;
const body = { bootId: "boot", epoch: 0, seq: 1, nextPack: 2 };
function fixture() {
  const refreshControl = vi
    .fn()
    .mockResolvedValue({
      head: 1,
      confirmedSeq: 1,
      slots: {},
      locators: { chunks: {}, packs: {} },
    });
  const verifyControlToken = vi.fn().mockResolvedValue({ id: "a" });
  const log = vi.fn();
  const app = new Hono();
  registerSandboxVolumeRoutes(app, {
    service: () => ({ refreshControl, verifyControlToken }),
    log,
  });
  const request = (value: unknown = body, auth = `Bearer ${token}`) =>
    app.request("/v1/sandbox-volumes/a/control", {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  return { request, refreshControl, verifyControlToken, log };
}
describe("attachment control endpoint", () => {
  test("requires the scoped capability; cookies and malformed credentials do not suffice", async () => {
    const f = fixture();
    expect((await f.request(body, "")).status).toBe(401);
    f.verifyControlToken.mockRejectedValue(new VolumeControlUnauthorized());
    expect((await f.request()).status).toBe(401);
    expect(f.refreshControl).not.toHaveBeenCalled();
  });
  test("rejects mutation/drain fields and unbounded locator lists", async () => {
    const f = fixture();
    for (const value of [
      { ...body, drainId: "forged" },
      { ...body, seq: -1 },
      { ...body, locatorChunkIds: Array(257).fill("a".repeat(64)) },
    ])
      expect((await f.request(value)).status).toBe(400);
    expect(f.refreshControl).not.toHaveBeenCalled();
  });
  test("refreshes a matching attachment without cacheable credentials", async () => {
    const f = fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.refreshControl).toHaveBeenCalledWith("a", token, body);
    expect((await f.request()).status).toBe(429);
  });
  test("rejects oversized bodies before refreshing any data", async () => {
    const f = fixture();
    expect((await f.request({ padding: "x".repeat(40_000) })).status).toBe(413);
    expect(f.refreshControl).not.toHaveBeenCalled();
  });
  test("contains infrastructure failures without leaking tokens or signed URLs", async () => {
    const f = fixture();
    f.refreshControl.mockRejectedValue(
      new Error(
        `secret ${token} https://bucket.invalid/x?X-Amz-Signature=private`,
      ),
    );
    const response = await f.request();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("Signature");
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(token);
  });
});
