import { Hono } from "hono";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
}));
vi.mock("../middleware/auth-session", () => ({
  requireSession: async () => ({
    user: { id: "owner" },
    session: { id: "session" },
  }),
}));
vi.mock("../../modules/threads/service", () => ({ contentThreadService: {} }));
vi.mock("../../modules/devices/access", () => ({
  resolveLocalCaller: vi.fn(async () => ({ sessionId: "session" })),
  connectRemote: vi.fn(),
  revokeFolderAccess: vi.fn(),
  createNativeAccess: vi.fn(),
  setRemotePolicy: vi.fn(),
  requireDeviceAccess: vi.fn(async () => ({ native: true })),
}));
vi.mock("../../modules/devices/service", () => ({
  isOnline: () => true,
  localCall: vi.fn(),
  ownedThread: vi.fn(),
  claimEnrollment: vi.fn(),
  createEnrollment: vi.fn(),
}));
vi.mock("../../modules/devices/provider", () => ({
  localProviderForTurn: vi.fn(),
}));
vi.mock("@sourceweft/db", () => ({
  db: { select: () => ({ from: () => ({ where: async () => state.rows }) }) },
  localDevices: {},
  localThreadBindings: {},
  localFolderGrants: {},
  localCreationContexts: {},
}));
import { registerLocalDeviceRoutes } from "./local-devices";

const none = {
  platform: null,
  arch: null,
  shell: null,
  sandboxState: null,
  sandboxCode: null,
  sandboxReason: null,
  sandboxRemedy: null,
  capabilities: null,
  statusReportedAt: null,
};
const base = {
  userId: "owner",
  tokenHash: "secret-hash",
  connectionId: "secret-connection",
};

beforeEach(() => {
  state.rows = [];
});

async function list() {
  const app = new Hono();
  registerLocalDeviceRoutes(app);
  const response = await app.request("/v1/local-devices");
  expect(response.status).toBe(200);
  return (await response.json()).devices as Record<string, unknown>[];
}

test("list exposes platform, shell and sandbox readiness; null before the host reports", async () => {
  state.rows = [
    {
      ...base,
      ...none,
      id: "old",
      name: "Old host",
      remoteEnabled: false,
    },
    {
      ...base,
      ...none,
      id: "linux",
      name: "Linux box",
      remoteEnabled: true,
      platform: "linux",
      arch: "x64",
      shell: "bash",
      sandboxState: "needsSetup",
      sandboxCode: "bwrapMissing",
      sandboxReason: "bubblewrap is not installed",
      sandboxRemedy: "privilegedSetup",
      capabilities: ["sandbox"],
    },
    {
      ...base,
      ...none,
      id: "mac",
      name: "Mac",
      remoteEnabled: false,
      platform: "macos",
      arch: "arm64",
      shell: "zsh",
      sandboxState: "ready",
    },
  ];
  const devices = await list();
  expect(devices).toEqual([
    {
      id: "old",
      name: "Old host",
      online: true,
      remoteEnabled: false,
      connected: true,
      platform: null,
      arch: null,
      shell: null,
      sandbox: null,
    },
    {
      id: "linux",
      name: "Linux box",
      online: true,
      remoteEnabled: true,
      connected: true,
      platform: "linux",
      arch: "x64",
      shell: "bash",
      sandbox: {
        state: "needsSetup",
        code: "bwrapMissing",
        reason: "bubblewrap is not installed",
        remedy: "privilegedSetup",
      },
    },
    {
      id: "mac",
      name: "Mac",
      online: true,
      remoteEnabled: false,
      connected: true,
      platform: "macos",
      arch: "arm64",
      shell: "zsh",
      sandbox: { state: "ready" },
    },
  ]);
});
