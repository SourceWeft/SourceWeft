import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { Workspace } from "./types";

// Mock workspaceService BEFORE importing the module under test.
// The guard calls workspaceService.resolveWorkspace which normally hits DB.
const mockResolveWorkspace = vi.fn();

vi.mock("./service", () => ({
  workspaceService: {
    resolveWorkspace: (...args: unknown[]) => mockResolveWorkspace(...args),
  },
}));

import { requireContentWorkspace } from "./guards";
import { ContentError } from "../content/errors";

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-test-1",
    organizationId: "org-test-1",
    name: "Test Workspace",
    slug: "test-workspace",
    isDefault: false,
    createdBy: "user-test-1",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("requireContentWorkspace returns workspace when found", async () => {
  const workspace = makeWorkspace();
  mockResolveWorkspace.mockResolvedValueOnce(workspace);

  const result = await requireContentWorkspace({
    workspaceId: "ws-test-1",
    userId: "user-test-1",
  });

  assert.equal(result.id, "ws-test-1");
  assert.equal(result.name, "Test Workspace");
});

test("requireContentWorkspace throws ContentError when workspace not found", async () => {
  mockResolveWorkspace.mockResolvedValueOnce(null);

  await assert.rejects(
    () =>
      requireContentWorkspace({
        workspaceId: "ws-nonexistent",
        userId: "user-test-1",
      }),
    (error: unknown) => {
      assert.ok(error instanceof ContentError);
      assert.equal((error as ContentError).statusCode, 404);
      assert.equal((error as ContentError).code, "WORKSPACE_NOT_FOUND");
      return true;
    },
  );
});
