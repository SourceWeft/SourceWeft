import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createWorkspaceRouteTestApp } from "../../../test/hono";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  reportNavigation: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  requireSession: mocks.requireSession,
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
}));

vi.mock("../../../modules/artifact-records", async () => {
  const { ContentError } = await import("../../../modules/content/errors");
  return {
    artifactRecordsService: { reportNavigation: mocks.reportNavigation },
    artifactRecordError: (code: string, message: string) =>
      new ContentError(
        code === "forbidden" ? 403 : 400,
        `ARTIFACT_RECORD_${code.toUpperCase()}`,
        message,
      ),
  };
});

import { registerArtifactNavigationRoutes } from "./artifact-navigation";

const path = "/v1/workspaces/ws-1/artifacts/a/versions/v/records/navigation";
const app = () => createWorkspaceRouteTestApp(registerArtifactNavigationRoutes);

function post(body: string, headers: Record<string, string> = {}) {
  return app().request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({
    user: { id: "user-1" },
    session: { id: "s", userId: "user-1" },
  });
  mocks.reportNavigation.mockResolvedValue({ accepted: true });
});

test("the report reaches the service bound to the session and version only", async () => {
  // Whatever a page-shaped body says is discarded.
  const response = await post(JSON.stringify({ url: "https://evil.example" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(mocks.reportNavigation.mock.calls[0]![0], {
    workspaceId: "ws-1",
    artifactId: "a",
    versionId: "v",
    userId: "user-1",
  });
});

test("opaque origins, non-JSON bodies and anonymous callers never reach the service", async () => {
  assert.equal((await post("{}", { origin: "null" })).status, 403);
  assert.equal(
    (await post("{}", { "content-type": "text/plain" })).status,
    400,
  );
  assert.equal((await post("{not json")).status, 400);
  mocks.requireSession.mockResolvedValue(null);
  assert.equal((await post("{}")).status, 401);
  assert.equal(mocks.reportNavigation.mock.calls.length, 0);
});
