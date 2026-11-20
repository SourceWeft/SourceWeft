import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestTableArtifact: vi.fn(),
  listSourceRecordsByIds: vi.fn(),
}));

vi.mock("../../../tables/requests", () => ({
  requestTableArtifact: mocks.requestTableArtifact,
}));
vi.mock("../../../sources/repository", () => ({
  listSourceRecordsByIds: mocks.listSourceRecordsByIds,
}));

import { createGroundedArtifactServices } from "./grounded-artifact-services";

const COLUMNS = [{ name: "Price", type: "number" as const }];

function prepared(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    workspace: { id: "workspace-1", organizationId: "team-1" },
    thread: { id: "thread-1" },
    sourceIds: ["s-selected-1", "s-selected-2", "dir-1"],
    effectiveMentionedSourceIds: [] as string[],
    ...overrides,
  };
}

beforeEach(() => {
  mocks.requestTableArtifact.mockReset().mockResolvedValue({
    artifactId: "artifact-1",
    versionNo: 1,
    status: "pending",
    visibility: "workspace",
    reused: false,
  });
  mocks.listSourceRecordsByIds.mockReset().mockImplementation(
    async (input: { sourceIds: string[] }) =>
      // Out of order on purpose: the turn's order is kept.
      [...input.sourceIds].reverse().map((id) => ({
        id,
        sourceType: id.startsWith("dir-") ? "directory" : "file",
      })),
  );
});

test("a table request goes to requestTableArtifact with the turn's workspace, thread and actor", async () => {
  const services = createGroundedArtifactServices({ prepared: prepared() });
  const receipt = await services.requestGeneration({
    artifactType: "table",
    request: {
      sourceIds: ["s-selected-1"],
      columns: COLUMNS,
      instruction: "Compare prices",
      // A thread the model made up never wins over the turn's.
      threadId: "someone-elses-thread",
    },
    uiLocale: "zh-CN",
  });

  assert.equal(mocks.requestTableArtifact.mock.calls.length, 1);
  const [call] = mocks.requestTableArtifact.mock.calls[0]!;
  assert.equal(call.workspaceId, "workspace-1");
  assert.equal(call.userId, "user-1");
  assert.equal(call.uiLocale, "zh-CN");
  assert.deepEqual(call.request, {
    threadId: "thread-1",
    sourceIds: ["s-selected-1"],
    columns: COLUMNS,
    instruction: "Compare prices",
  });
  // The receipt is the narrow contract shape; visibility stays host-side.
  assert.deepEqual(receipt, {
    artifactId: "artifact-1",
    versionNo: 1,
    status: "pending",
    reused: false,
  });
});

test("a request that breaks the table contract is refused before anything is opened", async () => {
  const services = createGroundedArtifactServices({ prepared: prepared() });
  await assert.rejects(
    services.requestGeneration({
      artifactType: "table",
      request: { sourceIds: [], columns: COLUMNS },
      uiLocale: "en",
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "VALIDATION_ERROR",
  );
  assert.equal(mocks.requestTableArtifact.mock.calls.length, 0);
});

test("an artifact type with no grounded generation is refused, not guessed at", async () => {
  const services = createGroundedArtifactServices({ prepared: prepared() });
  await assert.rejects(
    services.requestGeneration({
      artifactType: "podcast",
      request: { sourceIds: ["s-selected-1"] },
      uiLocale: "en",
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "UNSUPPORTED_ARTIFACT_TYPE",
  );
  assert.equal(mocks.requestTableArtifact.mock.calls.length, 0);
});

test("a cancelled turn starts no job", async () => {
  const cancelled = new Error("cancelled");
  const services = createGroundedArtifactServices({
    prepared: prepared(),
    runCancellation: {
      throwIfCancelled: async () => {
        throw cancelled;
      },
    },
  });
  await assert.rejects(
    services.requestGeneration({
      artifactType: "table",
      request: { sourceIds: ["s-selected-1"], columns: COLUMNS },
      uiLocale: "en",
    }),
    (error: unknown) => error === cancelled,
  );
  assert.equal(mocks.requestTableArtifact.mock.calls.length, 0);
});

test("the turn's sources are its selection, documents only, in order", async () => {
  const services = createGroundedArtifactServices({ prepared: prepared() });
  assert.deepEqual(await services.listTurnSourceIds(), [
    "s-selected-1",
    "s-selected-2",
  ]);
  assert.deepEqual(mocks.listSourceRecordsByIds.mock.calls[0]![0], {
    teamId: "team-1",
    workspaceId: "workspace-1",
    sourceIds: ["s-selected-1", "s-selected-2", "dir-1"],
  });
});

test("@mentioned sources take precedence over the selection", async () => {
  const services = createGroundedArtifactServices({
    prepared: prepared({ effectiveMentionedSourceIds: ["s-selected-2"] }),
  });
  assert.deepEqual(await services.listTurnSourceIds(), ["s-selected-2"]);
});

test("a turn with no sources has none to offer", async () => {
  const services = createGroundedArtifactServices({
    prepared: prepared({ sourceIds: [] }),
  });
  assert.deepEqual(await services.listTurnSourceIds(), []);
  assert.equal(mocks.listSourceRecordsByIds.mock.calls.length, 0);
});
