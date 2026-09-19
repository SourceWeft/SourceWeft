// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
const session = vi.hoisted(() => ({
  clear: vi.fn(),
  headers: vi.fn(async () => ({ "X-Local-Proof": "expired" })),
}));
vi.mock("./local-host-session", () => ({
  cachedLocalHostHeaders: session.headers,
  clearLocalHostSession: session.clear,
}));
import { localRequest } from "./local-execution";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
test("a status response with an expired native proof invalidates it for the next main/Hub request", async () => {
  const value = {
    executionTarget: { kind: "local", deviceId: "pc" },
    availability: {
      ready: false,
      code: "NATIVE_PROOF_EXPIRED",
      message: "Reconnect",
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => value }),
  );
  await expect(
    localRequest("/v1/workspaces/w/threads/t/local-execution"),
  ).resolves.toEqual(value);
  expect(session.clear).toHaveBeenCalledOnce();
  expect(session.headers).toHaveBeenCalledWith(
    "/v1/workspaces/w/threads/t/local-execution",
  );
});
