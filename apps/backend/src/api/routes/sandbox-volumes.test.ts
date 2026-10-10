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
  const refreshControl = vi.fn().mockResolvedValue({
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
  const request = (
    value: unknown = body,
    auth = `Bearer ${token}`,
    attachment = "a",
  ) =>
    app.request(`/v1/sandbox-volumes/${attachment}/control`, {
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
  test("an authenticated burst has bounded in-flight work and recovers after completion", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.refreshControl.mockImplementation(async () => {
      await gate;
      return {
        head: 1,
        confirmedSeq: 1,
        slots: {},
        locators: { chunks: {}, packs: {} },
      };
    });
    const admitted = Array.from({ length: 32 }, (_, i) =>
      f.request(body, `Bearer ${token}`, `actor-${i}`),
    );
    try {
      await vi.waitFor(() =>
        expect(f.refreshControl).toHaveBeenCalledTimes(32),
      );
      const overload = await f.request(
        body,
        `Bearer ${token}`,
        "actor-overload",
      );
      expect(overload.status).toBe(503);
      expect(overload.headers.get("retry-after")).toBe("1");
      expect(f.refreshControl).toHaveBeenCalledTimes(32);
    } finally {
      release();
      await Promise.all(admitted);
    }
    expect(
      (await f.request(body, `Bearer ${token}`, "actor-recovered")).status,
    ).toBe(200);
  });

  test("slow authentication is bounded and rejection releases every capacity slot", async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    const gate = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    f.verifyControlToken.mockImplementation(() => gate);
    const requests = Array.from({ length: 32 }, (_, i) =>
      f.request(body, `Bearer ${token}`, `invalid-${i}`),
    );
    try {
      await vi.waitFor(() =>
        expect(f.verifyControlToken).toHaveBeenCalledTimes(32),
      );
      expect(
        (await f.request(body, `Bearer ${token}`, "overload")).status,
      ).toBe(503);
      expect(f.verifyControlToken).toHaveBeenCalledTimes(32);
    } finally {
      reject(new VolumeControlUnauthorized());
    }
    expect(
      (await Promise.all(requests)).every(
        (response) => response.status === 401,
      ),
    ).toBe(true);
    expect(f.refreshControl).not.toHaveBeenCalled();
    f.verifyControlToken.mockResolvedValue({ id: "next" });
    expect((await f.request(body, `Bearer ${token}`, "next")).status).toBe(200);
  });

  test("ten thousand distinct attachments cannot grow cooldown tracking without a bound", async () => {
    const f = fixture();
    const started = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(started);
    try {
      for (let i = 0; i < 10_000; i++) {
        expect(
          (await f.request(body, `Bearer ${token}`, `burst-${i}`)).status,
        ).toBe(200);
      }
      expect((await f.request(body, `Bearer ${token}`, "extra")).status).toBe(
        503,
      );
      expect(f.refreshControl).toHaveBeenCalledTimes(10_000);
      clock.mockReturnValue(started + 1001);
      expect((await f.request(body, `Bearer ${token}`, "extra")).status).toBe(
        200,
      );
    } finally {
      clock.mockRestore();
    }
  });

  test("wall clock rollback cannot extend a one-second renewal cooldown indefinitely", async () => {
    const f = fixture();
    const wall = Date.now();
    const monotonic = performance.now();
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(wall);
    const steadyClock = vi.spyOn(performance, "now").mockReturnValue(monotonic);
    try {
      expect((await f.request()).status).toBe(200);
      wallClock.mockReturnValue(wall - 86_400_000);
      steadyClock.mockReturnValue(monotonic + 1001);
      expect((await f.request()).status).toBe(200);
    } finally {
      wallClock.mockRestore();
      steadyClock.mockRestore();
    }
  });
});
