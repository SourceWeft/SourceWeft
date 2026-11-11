import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { HttpClientError } from "@sourceweft/sdk";

const getChatBootstrap = vi.fn();
const stored = new Map<string, string>();

vi.mock("./sdk", () => ({
  dashboardClient: {
    getChatBootstrap: (...args: unknown[]) => getChatBootstrap(...args),
  },
  workspaceClient: {},
}));

vi.mock("./dashboard-workspace-context", () => ({
  getStoredDashboardWorkspaceId: (organizationId?: string | null) =>
    organizationId ? (stored.get(organizationId) ?? null) : null,
  setStoredDashboardWorkspaceId: vi.fn(),
}));

const { loadDashboardChatBootstrap } =
  await import("./dashboard-workspace-bootstrap");

function bootstrapResult(organizationId: string, workspaceId: string) {
  return {
    activeOrganizationId: organizationId,
    activeWorkspace: { id: workspaceId, name: workspaceId },
  };
}

function httpError(status: number, code: string) {
  return new HttpClientError({
    message: code,
    status,
    statusText: "Error",
    code,
  });
}

function requestedWorkspaceIds() {
  return getChatBootstrap.mock.calls.map(
    ([input]) => (input as { workspaceId?: string }).workspaceId,
  );
}

beforeEach(() => {
  getChatBootstrap.mockReset();
  stored.clear();
});

test("a full load requests the workspace remembered for the known organization", async () => {
  stored.set("org-1", "workspace-2");
  getChatBootstrap.mockResolvedValue(bootstrapResult("org-1", "workspace-2"));

  const result = await loadDashboardChatBootstrap({
    organizationIdHint: "org-1",
  });

  assert.equal(result.activeWorkspace.id, "workspace-2");
  assert.deepEqual(getChatBootstrap.mock.calls, [
    [{ includeModelCatalog: false, workspaceId: "workspace-2" }],
  ]);
});

test("nothing remembered loads the default workspace in one request", async () => {
  getChatBootstrap.mockResolvedValue(bootstrapResult("org-1", "workspace-1"));

  const result = await loadDashboardChatBootstrap({
    organizationIdHint: "org-1",
  });

  assert.equal(result.activeWorkspace.id, "workspace-1");
  assert.deepEqual(getChatBootstrap.mock.calls, [
    [{ includeModelCatalog: false }],
  ]);
});

test("a remembered workspace that no longer exists falls back to the default", async () => {
  stored.set("org-1", "workspace-gone");
  getChatBootstrap
    .mockRejectedValueOnce(httpError(404, "WORKSPACE_NOT_FOUND"))
    .mockResolvedValueOnce(bootstrapResult("org-1", "workspace-1"));

  const result = await loadDashboardChatBootstrap({
    organizationIdHint: "org-1",
  });

  assert.equal(result.activeWorkspace.id, "workspace-1");
  assert.deepEqual(requestedWorkspaceIds(), ["workspace-gone", undefined]);
});

test("a remembered workspace the caller may no longer open falls back to the default", async () => {
  stored.set("org-1", "workspace-other-org");
  getChatBootstrap
    .mockRejectedValueOnce(httpError(403, "FORBIDDEN"))
    .mockResolvedValueOnce(bootstrapResult("org-1", "workspace-1"));

  const result = await loadDashboardChatBootstrap({
    organizationIdHint: "org-1",
  });

  assert.equal(result.activeWorkspace.id, "workspace-1");
  assert.deepEqual(requestedWorkspaceIds(), ["workspace-other-org", undefined]);
});

test("other failures are reported without a second request", async () => {
  stored.set("org-1", "workspace-2");
  getChatBootstrap.mockRejectedValue(httpError(500, "INTERNAL_ERROR"));

  await assert.rejects(
    loadDashboardChatBootstrap({ organizationIdHint: "org-1" }),
    (error: unknown) =>
      error instanceof HttpClientError && error.status === 500,
  );
  assert.equal(getChatBootstrap.mock.calls.length, 1);
});

test("an unknown organization is resolved first, then its remembered workspace is loaded", async () => {
  stored.set("org-1", "workspace-2");
  getChatBootstrap
    .mockResolvedValueOnce(bootstrapResult("org-1", "workspace-1"))
    .mockResolvedValueOnce(bootstrapResult("org-1", "workspace-2"));

  const result = await loadDashboardChatBootstrap({ organizationIdHint: null });

  assert.equal(result.activeWorkspace.id, "workspace-2");
  assert.deepEqual(requestedWorkspaceIds(), [undefined, "workspace-2"]);
});

test("a hint for another organization still ends in the session organization's remembered workspace", async () => {
  stored.set("org-stale", "workspace-9");
  stored.set("org-1", "workspace-2");
  getChatBootstrap
    .mockRejectedValueOnce(httpError(403, "FORBIDDEN"))
    .mockResolvedValueOnce(bootstrapResult("org-1", "workspace-1"))
    .mockResolvedValueOnce(bootstrapResult("org-1", "workspace-2"));

  const result = await loadDashboardChatBootstrap({
    organizationIdHint: "org-stale",
  });

  assert.equal(result.activeWorkspace.id, "workspace-2");
  assert.deepEqual(requestedWorkspaceIds(), [
    "workspace-9",
    undefined,
    "workspace-2",
  ]);
});

test("the default result is kept when the remembered workspace cannot be loaded afterwards", async () => {
  stored.set("org-1", "workspace-gone");
  getChatBootstrap
    .mockResolvedValueOnce(bootstrapResult("org-1", "workspace-1"))
    .mockRejectedValueOnce(httpError(404, "WORKSPACE_NOT_FOUND"));

  const result = await loadDashboardChatBootstrap({ organizationIdHint: null });

  assert.equal(result.activeWorkspace.id, "workspace-1");
  assert.equal(getChatBootstrap.mock.calls.length, 2);
});

test("a superseded load does not start the follow-up request", async () => {
  stored.set("org-1", "workspace-2");
  getChatBootstrap.mockResolvedValue(bootstrapResult("org-1", "workspace-1"));

  const result = await loadDashboardChatBootstrap({
    organizationIdHint: null,
    isSuperseded: () => true,
  });

  assert.equal(result.activeWorkspace.id, "workspace-1");
  assert.equal(getChatBootstrap.mock.calls.length, 1);
});
