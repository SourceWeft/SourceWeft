import assert from "node:assert/strict";
import { GroundedGenerationError } from "@sourceweft/contracts/grounded-generation";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findArtifactRecord: vi.fn(),
  markArtifactRunning: vi.fn(),
  completeArtifact: vi.fn(),
  failArtifact: vi.fn(),
  writeArtifactPayloadKey: vi.fn(),
  findArtifactVersionContent: vi.fn(),
  linkArtifactVersionParent: vi.fn(),
  recordArtifactInputSources: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("../artifacts/repository", () => ({
  findArtifactRecord: mocks.findArtifactRecord,
  markArtifactRunning: mocks.markArtifactRunning,
}));
vi.mock("../artifacts/publish", () => ({
  completeArtifact: mocks.completeArtifact,
  failArtifact: mocks.failArtifact,
}));
vi.mock("./artifact-store", () => ({
  writeArtifactPayloadKey: mocks.writeArtifactPayloadKey,
  findArtifactVersionContent: mocks.findArtifactVersionContent,
  linkArtifactVersionParent: mocks.linkArtifactVersionParent,
  recordArtifactInputSources: mocks.recordArtifactInputSources,
}));

vi.mock("../notifications", () => ({
  notify: mocks.notify,
}));

import { runArtifactGenerationJob } from "./job";

const job = {
  teamId: "team",
  workspaceId: "ws",
  threadId: "thread",
  artifactId: "art",
  versionNo: 1,
  userId: "user",
  artifactType: "table",
  isFinalAttempt: false,
};

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: "art",
    teamId: "team",
    workspaceId: "ws",
    threadId: "thread",
    artifactType: "table",
    title: "A table",
    status: "pending",
    currentVersionNo: 0,
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

test("a missing artifact is skipped before anything runs", async () => {
  mocks.findArtifactRecord.mockResolvedValue(null);
  const generate = vi.fn();
  const result = await runArtifactGenerationJob({
    job,
    namespace: "table",
    generate,
  });
  assert.deepEqual(result, { status: "skipped", reason: "missing-artifact" });
  expect(generate).not.toHaveBeenCalled();
  expect(mocks.markArtifactRunning).not.toHaveBeenCalled();
});

test("a version that was superseded is skipped", async () => {
  mocks.findArtifactRecord.mockResolvedValue(
    artifact({ status: "ready", currentVersionNo: 5 }),
  );
  const generate = vi.fn();
  const result = await runArtifactGenerationJob({
    job: { ...job, versionNo: 2 },
    namespace: "table",
    generate,
  });
  assert.deepEqual(result, { status: "skipped", reason: "superseded" });
  expect(generate).not.toHaveBeenCalled();
  expect(mocks.completeArtifact).not.toHaveBeenCalled();
});

test("a failure a retry cannot fix is recorded on the first attempt", async () => {
  mocks.findArtifactRecord.mockResolvedValue(artifact());
  const result = await runArtifactGenerationJob({
    job: { ...job, isFinalAttempt: false },
    namespace: "table",
    generate: async () => {
      throw new GroundedGenerationError("INPUT_TOO_LARGE", "too large");
    },
  });
  assert.deepEqual(result, { status: "failed", errorCode: "INPUT_TOO_LARGE" });
  expect(mocks.failArtifact).toHaveBeenCalledTimes(1);
  expect(mocks.failArtifact.mock.calls[0]![0].error).toMatchObject({
    code: "INPUT_TOO_LARGE",
    category: "validation",
  });
});

test("any other error is rethrown for the queue to retry", async () => {
  mocks.findArtifactRecord.mockResolvedValue(artifact());
  const failure = new Error("upstream 502");
  await assert.rejects(
    runArtifactGenerationJob({
      job: { ...job, isFinalAttempt: false },
      namespace: "table",
      generate: async () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  expect(mocks.failArtifact).not.toHaveBeenCalled();
  expect(mocks.writeArtifactPayloadKey).not.toHaveBeenCalled();
});

test("the person who asked is told when a first generation fails", async () => {
  mocks.findArtifactRecord.mockResolvedValue(artifact());
  await runArtifactGenerationJob({
    job,
    namespace: "table",
    generate: async () => {
      throw new GroundedGenerationError("GENERATION_QUALITY_TOO_LOW", "4 of 8");
    },
  });
  expect(mocks.notify).toHaveBeenCalledTimes(1);
  expect(mocks.notify.mock.calls[0]![0]).toEqual({
    kind: "artifact_generation_failed",
    teamId: "team",
    userId: "user",
    ref: { kind: "artifact", id: "art" },
    payload: {
      title: "A table",
      artifactType: "table",
      threadId: "thread",
      errorCode: "GENERATION_QUALITY_TOO_LOW",
      regeneration: false,
    },
  });
});

test("a failed regeneration is announced too, and nothing is said on success or retry", async () => {
  mocks.findArtifactRecord.mockResolvedValue(
    artifact({ status: "ready", currentVersionNo: 1 }),
  );
  await runArtifactGenerationJob({
    job: { ...job, versionNo: 2 },
    namespace: "table",
    generate: async () => {
      throw new GroundedGenerationError("INSUFFICIENT_CREDITS", "no credits");
    },
  });
  expect(mocks.notify).toHaveBeenCalledTimes(1);
  expect(mocks.notify.mock.calls[0]![0].payload).toMatchObject({
    errorCode: "INSUFFICIENT_CREDITS",
    regeneration: true,
  });

  mocks.notify.mockReset();
  mocks.findArtifactRecord.mockResolvedValue(artifact());
  await assert.rejects(
    runArtifactGenerationJob({
      job: { ...job, isFinalAttempt: false },
      namespace: "table",
      generate: async () => {
        throw new Error("upstream 502");
      },
    }),
  );
  mocks.findArtifactRecord.mockResolvedValue(artifact());
  await runArtifactGenerationJob({
    job,
    namespace: "table",
    generate: async () => ({ content: {}, sources: [] }),
  });
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("a notice that cannot be stored never fails the job", async () => {
  mocks.findArtifactRecord.mockResolvedValue(artifact());
  mocks.notify.mockRejectedValue(new Error("database down"));
  const result = await runArtifactGenerationJob({
    job,
    namespace: "table",
    generate: async () => {
      throw new GroundedGenerationError("INPUT_TOO_LARGE", "too large");
    },
  });
  assert.deepEqual(result, { status: "failed", errorCode: "INPUT_TOO_LARGE" });
});
