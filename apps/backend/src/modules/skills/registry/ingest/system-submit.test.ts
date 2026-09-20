import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  workspaceRows: [] as Array<{ id: string }>,
}));

vi.mock("./service", () => ({
  createSkillSubmission: mocks.create,
  getSkillSubmission: mocks.get,
}));
vi.mock("@sourceweft/db", () => ({
  workspaces: { id: "id", organizationId: "organization_id" },
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => mocks.workspaceRows }),
      }),
    }),
  },
}));

import {
  assertSystemSubmitScope,
  readSystemSubmissions,
  submitSkillSourcesAsSystem,
  SYSTEM_SUBMITTER_ID,
} from "./system-submit";

const scope = { teamId: "team-1", workspaceId: "workspace-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspaceRows = [{ id: "workspace-1" }];
});

test("platform imports go through the ordinary submission, attributed to the system", async () => {
  mocks.create.mockResolvedValue({
    submission: { id: "s1", status: "queued" },
    created: true,
  });
  const results = await submitSkillSourcesAsSystem(scope, ["acme/skills"]);
  assert.deepEqual(mocks.create.mock.calls[0]![0], {
    ...scope,
    userId: SYSTEM_SUBMITTER_ID,
    source: "acme/skills",
  });
  // No install-on-complete: collecting a skill puts it in nobody's workspace.
  assert.equal("install" in mocks.create.mock.calls[0]![0], false);
  assert.deepEqual(results, [
    {
      source: "acme/skills",
      ok: true,
      created: true,
      submission: { id: "s1", status: "queued" },
    },
  ]);
});

test("a refused source is that source's result; the rest are still submitted", async () => {
  mocks.create
    .mockRejectedValueOnce(
      Object.assign(new Error("Unsupported GitHub source"), {
        code: "REGISTRY_SUBMISSION_INVALID_SOURCE",
      }),
    )
    .mockResolvedValueOnce({ submission: { id: "s2" }, created: false });
  const results = await submitSkillSourcesAsSystem(scope, ["nope", "ok/repo"]);
  assert.deepEqual(results[0], {
    source: "nope",
    ok: false,
    code: "REGISTRY_SUBMISSION_INVALID_SOURCE",
    message: "Unsupported GitHub source",
  });
  assert.equal(results[1]!.ok, true);
});

test("status is read as the system too, so it sees what it submitted", async () => {
  mocks.get.mockResolvedValue({
    submission: { id: "s1", status: "succeeded" },
  });
  const results = await readSystemSubmissions(scope, ["s1"]);
  assert.deepEqual(mocks.get.mock.calls[0]![0], {
    ...scope,
    userId: SYSTEM_SUBMITTER_ID,
    submissionId: "s1",
  });
  assert.equal(results[0]!.ok, true);
});

test("a workspace that is not in the named team is refused before anything is submitted", async () => {
  mocks.workspaceRows = [];
  await assert.rejects(
    assertSystemSubmitScope(scope),
    /does not exist in team 'team-1'/,
  );
});
