// @vitest-environment jsdom
import assert from "node:assert/strict";
import { beforeEach, afterEach, test, vi } from "vitest";
const native = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  localHostStatus: vi.fn(),
  authenticateLocalHost: vi.fn(),
  disconnectLocalHost: vi.fn(),
}));
vi.mock("./desktop-bridge", () => ({ desktopBridge: native }));
import {
  ensureLocalHostSession,
  clearLocalHostSession,
  cachedLocalHostHeaders,
  localHostHeaders,
  synchronizeLocalHostScope,
} from "./local-host-session";
beforeEach(() => {
  clearLocalHostSession();
  window.history.replaceState({}, "", "/dashboard/chat");
  native.isAvailable.mockReset().mockReturnValue(true);
  native.localHostStatus
    .mockReset()
    .mockResolvedValue({ platformSupported: true, protocolVersion: 2 });
  native.authenticateLocalHost.mockReset();
  native.disconnectLocalHost.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: "test-ticket", userId: "user" }),
    }),
  );
});
afterEach(() => {
  clearLocalHostSession();
  vi.unstubAllGlobals();
});
test("unsupported desktops keep cloud without enrolling a local host", async () => {
  native.localHostStatus.mockResolvedValue({ platformSupported: false });
  assert.equal(await ensureLocalHostSession("user"), null);
  assert.equal(native.authenticateLocalHost.mock.calls.length, 0);
});

test("the auxiliary Hub never initializes or disconnects the main native host", async () => {
  window.history.replaceState({}, "", "/dashboard/hub-window");
  await synchronizeLocalHostScope("hub-user", "hub-session");
  await synchronizeLocalHostScope();
  assert.equal(native.localHostStatus.mock.calls.length, 0);
  assert.equal(native.authenticateLocalHost.mock.calls.length, 0);
  assert.equal(native.disconnectLocalHost.mock.calls.length, 0);
  assert.equal(vi.mocked(fetch).mock.calls.length, 0);
});
test("cloud conversation streaming does not wait for Keychain", async () => {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({ executionTarget: { kind: "cloud" } }),
  } as Response);
  native.authenticateLocalHost.mockRejectedValue(new Error("KEYCHAIN_DENIED"));
  assert.deepEqual(
    await localHostHeaders({ workspaceId: "w", threadId: "t" }),
    {},
  );
  assert.equal(native.localHostStatus.mock.calls.length, 0);
});
test("normal API calls never bootstrap the host or forward proof outside thread creation", async () => {
  assert.deepEqual(await cachedLocalHostHeaders("/v1/billing"), {});
  assert.equal(native.localHostStatus.mock.calls.length, 0);
  native.authenticateLocalHost.mockResolvedValue({
    deviceId: "device",
    proof: "test-proof",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  await ensureLocalHostSession("user");
  assert.deepEqual(await cachedLocalHostHeaders("/v1/workspaces/w/threads"), {
    "X-Local-Proof": "test-proof",
  });
  assert.deepEqual(
    await cachedLocalHostHeaders("https://external.example/file"),
    {},
  );
  assert.deepEqual(
    await cachedLocalHostHeaders("/v1/workspaces/w/artifacts/file"),
    {},
  );
});
test("a late authentication reply cannot restore a signed-out session", async () => {
  let complete!: (value: unknown) => void;
  native.authenticateLocalHost.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const attempt = ensureLocalHostSession("user");
  await vi.waitFor(() =>
    assert.equal(native.authenticateLocalHost.mock.calls.length, 1),
  );
  clearLocalHostSession();
  complete({
    deviceId: "device",
    proof: "late-proof",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  await assert.rejects(attempt, /The local session has ended/);
  assert.deepEqual(
    await cachedLocalHostHeaders("/v1/workspaces/w/threads"),
    {},
  );
});

test("switching accounts cancels an older pending native authentication", async () => {
  let finishOld!: (value: unknown) => void;
  let tickets = 0;
  const statusResolvers: Array<(value: unknown) => void> = [];
  let checks = 0;
  native.localHostStatus.mockImplementation(() =>
    checks++ < 2
      ? new Promise((resolve) => statusResolvers.push(resolve))
      : Promise.resolve({ platformSupported: true, protocolVersion: 2 }),
  );
  vi.mocked(fetch).mockImplementation(
    async () =>
      ({
        ok: true,
        json: async () => ({
          ticket: "ticket",
          userId: ++tickets === 1 ? "a" : "b",
        }),
      }) as Response,
  );
  native.authenticateLocalHost.mockImplementation(
    (_ticket: string, userId: string) =>
      userId === "a"
        ? new Promise((resolve) => {
            finishOld = resolve;
          })
        : Promise.resolve({
            deviceId: "device-b",
            proof: "proof-b",
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          }),
  );
  const old = ensureLocalHostSession("a");
  const newer = ensureLocalHostSession("b");
  await vi.waitFor(() => assert.equal(statusResolvers.length, 2));
  statusResolvers[0]!({ platformSupported: true, protocolVersion: 2 });
  await vi.waitFor(() =>
    assert.equal(native.authenticateLocalHost.mock.calls.length, 1),
  );
  statusResolvers[1]!({ platformSupported: true, protocolVersion: 2 });
  const fresh = await newer;
  assert.equal(fresh?.userId, "b");
  assert.equal(native.disconnectLocalHost.mock.calls.length, 1);
  finishOld({
    deviceId: "device-a",
    proof: "proof-a",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  await assert.rejects(old, /The local session has ended/);
  assert.deepEqual(await cachedLocalHostHeaders("/v1/workspaces/w/threads"), {
    "X-Local-Proof": "proof-b",
  });
});

test("old native protocol fails explicitly without registering another computer", async () => {
  native.localHostStatus.mockResolvedValue({
    platformSupported: true,
    protocolVersion: 1,
  });
  await assert.rejects(ensureLocalHostSession("user"), /Update the PC app/);
  assert.equal(native.authenticateLocalHost.mock.calls.length, 0);
});

test("a new login session for the same user discards the old native proof", async () => {
  native.authenticateLocalHost.mockResolvedValue({
    deviceId: "device",
    proof: "proof",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  await synchronizeLocalHostScope("user", "session-1");
  await synchronizeLocalHostScope("user", "session-2");
  assert.equal(native.authenticateLocalHost.mock.calls.length, 2);
  assert.equal(native.disconnectLocalHost.mock.calls.length, 1);
  await synchronizeLocalHostScope();
});
