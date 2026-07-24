import assert from "node:assert/strict";
import { Hono } from "hono";
import { beforeEach, test, vi } from "vitest";
import { ApiResponse, toApiError } from "../response/api-response";
import { workspaceRoleSatisfies } from "../../modules/workspace/types";

const mockRequireSession = vi.fn();
const mockResolveAccess = vi.fn();

vi.mock("./auth-session", () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
  getActiveOrganizationId: () => null,
}));

// The two predicates are real service logic, not middleware logic — stubbing
// them would make these tests agree with themselves rather than with the model.
vi.mock("../../modules/workspace", () => ({
  workspaceService: {
    resolveAccess: (...args: unknown[]) => mockResolveAccess(...args),
    canAdministerContainer: (access: {
      isContainerAdmin: boolean;
      role: string | null;
    }) =>
      access.isContainerAdmin ||
      (access.role !== null &&
        workspaceRoleSatisfies(
          access.role as "workspace_admin",
          "workspace_admin",
        )),
  },
}));

const { workspaceRoleGuard } = await import("./workspace-role");

const SESSION = {
  user: { id: "user-1" },
  session: { id: "s1", userId: "user-1" },
};

/** Mirrors how app.ts wires the guard: on the app, ahead of every handler. */
function buildApp() {
  const app = new Hono();

  app.use("/v1/workspaces/:workspaceId", workspaceRoleGuard);
  app.use("/v1/workspaces/:workspaceId/*", workspaceRoleGuard);

  const workspaceRoutes = new Hono();
  workspaceRoutes.all("/*", (c) => c.json({ reached: true }));

  app.all("/v1/workspaces/:workspaceId", (c) => c.json({ reached: true }));
  app.route("/v1/workspaces/:workspaceId", workspaceRoutes);
  app.onError((error, c) => ApiResponse.error(c, toApiError(error)));

  return app;
}

async function call(method: string, path: string) {
  return buildApp().request(`/v1/workspaces/ws-1${path}`, { method });
}

function withAccess(input: {
  role: string | null;
  isContainerAdmin?: boolean;
}) {
  mockResolveAccess.mockResolvedValue({
    workspaceId: "ws-1",
    organizationId: "org-1",
    userId: "user-1",
    organizationRole: input.isContainerAdmin ? "owner" : "member",
    role: input.role,
    source: input.role ? "derived" : null,
    isContainerAdmin: input.isContainerAdmin ?? false,
  });
}

beforeEach(() => {
  mockRequireSession.mockReset();
  mockResolveAccess.mockReset();
  mockRequireSession.mockResolvedValue(SESSION);
});

test("reads are never blocked by role", async () => {
  withAccess({ role: "viewer" });
  const response = await call("GET", "/threads");
  assert.equal(response.status, 200);
  // A read must not even cost an access lookup.
  assert.equal(mockResolveAccess.mock.calls.length, 0);
});

test("a viewer cannot write", async () => {
  withAccess({ role: "viewer" });
  const response = await call("DELETE", "/threads/t-1");
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "WORKSPACE_ROLE_REQUIRED");
});

test("an editor can write content", async () => {
  withAccess({ role: "editor" });
  assert.equal((await call("POST", "/threads")).status, 200);
});

test("an editor cannot reach content-plane admin surfaces", async () => {
  withAccess({ role: "editor" });

  for (const path of [
    "/mcp-installs/install-1",
    "/market/mcp/some-server/install",
    "/connectors",
    "/agent-tool-trust-rules/rule-1/revoke",
  ]) {
    assert.equal(
      (await call("POST", path)).status,
      403,
      `expected 403 ${path}`,
    );
  }
});

test("a workspace admin can reach them", async () => {
  withAccess({ role: "workspace_admin" });
  assert.equal((await call("POST", "/connectors")).status, 200);
});

test("renaming the workspace is a container operation", async () => {
  withAccess({ role: "editor" });
  assert.equal((await call("PATCH", "")).status, 403);

  // No content access at all, but organization admin: still allowed.
  withAccess({ role: null, isContainerAdmin: true });
  assert.equal((await call("PATCH", "")).status, 200);
});

test("an organization admin configures provider keys without entering", async () => {
  withAccess({ role: null, isContainerAdmin: true });
  assert.equal(
    (await call("POST", "/model-gateway/byok-credentials")).status,
    200,
  );
});

test("an organization admin graded down here still administers the container", async () => {
  // The whole point of the two planes: the explicit downgrade governs content,
  // the organization role still governs the container.
  withAccess({ role: "viewer", isContainerAdmin: true });

  assert.equal((await call("PATCH", "")).status, 200);
  assert.equal((await call("POST", "/threads")).status, 403);
});

test("container-only standing does not become authoring rights", async () => {
  withAccess({ role: null, isContainerAdmin: true });
  // Falls through to the handler, which resolves no workspace and 404s. The
  // guard must not turn "may administer" into "may write content".
  assert.equal((await call("POST", "/threads")).status, 200);
});

test("read-shaped POSTs and member routes are left to their handlers", async () => {
  withAccess({ role: "viewer" });

  for (const path of [
    "/sources/status",
    "/model-gateway/byok-model-capabilities",
    "/members",
  ]) {
    assert.equal(
      (await call("POST", path)).status,
      200,
      `expected pass ${path}`,
    );
  }
});

test("unauthenticated and unrelated writes fall through to the handler", async () => {
  mockRequireSession.mockResolvedValue(null);
  assert.equal((await call("POST", "/threads")).status, 200);

  mockRequireSession.mockResolvedValue(SESSION);
  mockResolveAccess.mockResolvedValue(null);
  assert.equal((await call("POST", "/threads")).status, 200);
});
