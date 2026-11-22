import assert from "node:assert/strict";
import { GroundedGenerationError } from "@sourceweft/contracts/grounded-generation";
import { TABLE_LIMITS, type TableColumnInput } from "@sourceweft/contracts/table";
import { beforeEach, expect, test, vi } from "vitest";
import { tableContentFixture } from "./test-support";

const mocks = vi.hoisted(() => ({
  requireGeneratingThread: vi.fn(),
  requireViewableArtifact: vi.fn(),
  checkGroundedSources: vi.fn(),
  openArtifact: vi.fn(),
  findArtifactRecord: vi.fn(),
  findArtifactRecordByRequestKey: vi.fn(),
  enqueueTableGenerateJob: vi.fn(),
  countRunningGroundedJobs: vi.fn(),
  findTableVersionContent: vi.fn(),
  writeTablePayloadKey: vi.fn(),
}));

vi.mock("../grounded-generation/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../grounded-generation/access")>()),
  requireGeneratingThread: mocks.requireGeneratingThread,
  requireViewableArtifact: mocks.requireViewableArtifact,
}));
vi.mock("../grounded-generation/corpus-loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../grounded-generation/corpus-loader")>()),
  checkGroundedSources: mocks.checkGroundedSources,
}));
vi.mock("../artifacts/publish", () => ({ openArtifact: mocks.openArtifact }));
vi.mock("../artifacts/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../artifacts/repository")>()),
  findArtifactRecord: mocks.findArtifactRecord,
  findArtifactRecordByRequestKey: mocks.findArtifactRecordByRequestKey,
}));
vi.mock("../content/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../content/queue")>()),
  enqueueTableGenerateJob: mocks.enqueueTableGenerateJob,
}));
vi.mock("../grounded-generation/artifact-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../grounded-generation/artifact-store")>()),
  countRunningGroundedJobs: mocks.countRunningGroundedJobs,
}));
vi.mock("./repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./repository")>()),
  findTableVersionContent: mocks.findTableVersionContent,
  writeTablePayloadKey: mocks.writeTablePayloadKey,
}));

import { requestTableArtifact, requestTableRegeneration, tableRequestKey } from "./requests";

const scope = { teamId: "team_1", workspaceId: "ws_1" };
const workspace = { id: "ws_1", organizationId: "team_1" };
const thread = { id: "thread_1" };

const request = {
  threadId: "thread_1",
  sourceIds: ["src_a", "src_b"],
  columns: [
    { name: "Design", type: "text" },
    { name: "Participants", type: "number" },
  ] satisfies TableColumnInput[],
  instruction: "focus on trials",
};

function generate(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws_1",
    userId: "user_1",
    uiLocale: "en",
    request: { ...request, ...overrides },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireGeneratingThread.mockResolvedValue({ workspace, thread });
  mocks.checkGroundedSources.mockResolvedValue([
    { sourceId: "src_a", title: "Alpha", indexed: true },
    { sourceId: "src_b", title: "Beta", indexed: true },
  ]);
  mocks.countRunningGroundedJobs.mockResolvedValue(0);
  mocks.findArtifactRecordByRequestKey.mockResolvedValue(null);
  mocks.openArtifact.mockResolvedValue({ artifactId: "art_1", reused: false });
  mocks.findArtifactRecord.mockResolvedValue({
    id: "art_1",
    currentVersionNo: 0,
    visibility: "private",
  });
  mocks.enqueueTableGenerateJob.mockResolvedValue({ created: true });
});

test("a request opens a table artifact, follows its thread's visibility and queues version 1", async () => {
  const result = await requestTableArtifact(generate({ visibility: "workspace" }));
  assert.deepEqual(result, {
    artifactId: "art_1",
    versionNo: 1,
    status: "pending",
    artifactStatus: "pending",
    visibility: "private",
    reused: false,
  });
  const [opened] = mocks.openArtifact.mock.calls[0]!;
  assert.equal(opened.spec.artifactType, "table");
  assert.equal(opened.spec.title, "Table: Alpha +1");
  assert.equal(opened.spec.prompt, "focus on trials");
  expect(mocks.enqueueTableGenerateJob).toHaveBeenCalledWith({
    ...scope,
    threadId: "thread_1",
    artifactId: "art_1",
    versionNo: 1,
    userId: "user_1",
    sourceIds: ["src_a", "src_b"],
    columns: request.columns,
    instruction: "focus on trials",
    uiLocale: "en",
  });
});

test("the same request within five minutes returns the same artifact and enqueues nothing", async () => {
  await requestTableArtifact(generate());
  const key = mocks.openArtifact.mock.calls[0]![0].spec.idempotency.requestKey as string;
  assert.match(key, /^table:[0-9a-f]{40}$/);
  mocks.openArtifact.mockClear();
  mocks.enqueueTableGenerateJob.mockClear();
  mocks.findArtifactRecordByRequestKey.mockResolvedValue({ id: "art_1" });

  const again = await requestTableArtifact(generate());
  assert.equal(again.artifactId, "art_1");
  assert.equal(again.reused, true);
  expect(mocks.findArtifactRecordByRequestKey).toHaveBeenCalledWith(
    expect.objectContaining({ artifactType: "table", requestKey: key }),
  );
  expect(mocks.openArtifact).not.toHaveBeenCalled();
  expect(mocks.enqueueTableGenerateJob).not.toHaveBeenCalled();
  // A repeat starts nothing, so the running limit is not consulted for it.
  expect(mocks.countRunningGroundedJobs).toHaveBeenCalledTimes(1);
});

test("a repeat of a table that is already ready reports it as ready", async () => {
  mocks.findArtifactRecordByRequestKey.mockResolvedValue({ id: "art_1" });
  mocks.findArtifactRecord.mockResolvedValue({
    id: "art_1",
    currentVersionNo: 1,
    visibility: "private",
    status: "ready",
  });
  const again = await requestTableArtifact(generate());
  assert.equal(again.reused, true);
  // The accepted request's status is unchanged for the API; where the
  // artifact stands is reported beside it.
  assert.equal(again.status, "pending");
  assert.equal(again.artifactStatus, "ready");
});

test("the request key ignores source order and changes with the columns, the instruction and the window", () => {
  const base = {
    userId: "u",
    threadId: "t",
    sourceIds: ["b", "a"],
    columns: request.columns,
    instruction: "x",
  };
  const now = 10 * 60_000;
  assert.equal(
    tableRequestKey(base, now),
    tableRequestKey({ ...base, sourceIds: ["a", "b"] }, now + 1_000),
  );
  assert.notEqual(
    tableRequestKey(base, now),
    tableRequestKey({ ...base, columns: [{ name: "Other", type: "text" }] }, now),
  );
  assert.notEqual(tableRequestKey(base, now), tableRequestKey({ ...base, instruction: "y" }, now));
  assert.notEqual(tableRequestKey(base, now), tableRequestKey(base, now + 5 * 60_000));
});

test("a fourth running generation for one user is refused, counting study and table jobs together", async () => {
  mocks.countRunningGroundedJobs.mockResolvedValue(3);
  await assert.rejects(
    requestTableArtifact(generate()),
    (error: unknown) =>
      (error as { code?: string }).code === "TABLE_TOO_MANY_RUNNING" &&
      (error as { statusCode?: number }).statusCode === 429,
  );
  expect(mocks.countRunningGroundedJobs).toHaveBeenCalledWith({
    ...scope,
    userId: "user_1",
  });
  expect(mocks.openArtifact).not.toHaveBeenCalled();
  expect(mocks.enqueueTableGenerateJob).not.toHaveBeenCalled();

  mocks.countRunningGroundedJobs.mockResolvedValue(2);
  await requestTableArtifact(generate());
  expect(mocks.enqueueTableGenerateJob).toHaveBeenCalledTimes(1);
});

test("a source outside the workspace fails with SOURCE_NOT_READABLE and opens no artifact", async () => {
  mocks.checkGroundedSources.mockRejectedValue(
    new GroundedGenerationError("SOURCE_NOT_READABLE", "nope", { sourceIds: ["src_x"] }),
  );
  await assert.rejects(
    requestTableArtifact(generate({ sourceIds: ["src_a", "src_x"] })),
    (error: unknown) =>
      (error as { code?: string }).code === "SOURCE_NOT_READABLE" &&
      (error as { statusCode?: number }).statusCode === 404,
  );
  expect(mocks.openArtifact).not.toHaveBeenCalled();
  expect(mocks.enqueueTableGenerateJob).not.toHaveBeenCalled();
});

/* ------------------------------------------------------------ regeneration */

const sources = ["src_a", "src_b"].map((sourceId) => ({
  sourceId,
  documentId: `doc_${sourceId}`,
  contentHash: `hash_${sourceId}`,
}));
const stored = tableContentFixture({ sources, language: "zh-CN", instruction: "focus on trials" });

function regenerate(body: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws_1",
    userId: "user_1",
    artifactId: "art_1",
    uiLocale: "en",
    body,
  };
}

beforeEach(() => {
  mocks.requireViewableArtifact.mockResolvedValue({
    workspace,
    artifact: {
      id: "art_1",
      ...scope,
      artifactType: "table",
      status: "ready",
      currentVersionNo: 1,
      threadId: "thread_1",
    },
  });
  mocks.findTableVersionContent.mockResolvedValue(stored);
});

test("regeneration without a body reuses the previous recipe", async () => {
  const result = await requestTableRegeneration(regenerate());
  assert.deepEqual(result, { artifactId: "art_1", versionNo: 2, status: "pending" });
  expect(mocks.checkGroundedSources).toHaveBeenCalledWith(
    expect.objectContaining({ sourceIds: ["src_a", "src_b"] }),
  );
  expect(mocks.enqueueTableGenerateJob).toHaveBeenCalledWith({
    ...scope,
    threadId: "thread_1",
    artifactId: "art_1",
    versionNo: 2,
    userId: "user_1",
    sourceIds: ["src_a", "src_b"],
    // The columns come back with the ids the table already has.
    columns: stored.generation.recipe.columns,
    instruction: "focus on trials",
    // The language the table was made in, so unchanged cells stay reusable.
    language: "zh-CN",
    uiLocale: "en",
  });
  expect(mocks.writeTablePayloadKey).toHaveBeenCalledWith(
    expect.objectContaining({ artifactId: "art_1" }),
    "regeneration",
    { versionNo: 2, status: "running" },
  );
});

test("regeneration keeps column ids sent back by the client", async () => {
  const kept = stored.columns[0]!;
  const columns: TableColumnInput[] = [
    { id: kept.id, name: "Study design", description: "How it was run", type: "text" },
    { name: "Funding", type: "text" },
  ];
  await requestTableRegeneration(regenerate({ columns, language: "en" }));
  const queued = mocks.enqueueTableGenerateJob.mock.calls[0]![0];
  assert.deepEqual(queued.columns, columns);
  assert.equal(queued.columns[0].id, kept.id);
  assert.equal(queued.language, "en");
  // Sources and the instruction still come from the recipe.
  assert.deepEqual(queued.sourceIds, ["src_a", "src_b"]);
  assert.equal(queued.instruction, "focus on trials");
});

test("a regeneration that adds sources but not columns is checked against the 400-cell cap", async () => {
  // The recipe has two columns; 201 sources would be 402 cells, and the
  // schema alone cannot see it because only one side was sent.
  const sourceIds = Array.from({ length: 50 }, (_, index) => `src_${index}`);
  const wide = tableContentFixture({
    sources,
    columns: Array.from({ length: 9 }, (_, index) => ({
      name: `Column ${index}`,
      type: "text" as const,
    })),
  });
  mocks.findTableVersionContent.mockResolvedValue(wide);
  assert.ok(sourceIds.length * wide.columns.length > TABLE_LIMITS.maxCells);
  await assert.rejects(
    requestTableRegeneration(regenerate({ sourceIds })),
    (error: unknown) =>
      (error as { code?: string }).code === "VALIDATION_ERROR" &&
      (error as { statusCode?: number }).statusCode === 422 &&
      /450 cells/.test((error as Error).message),
  );
  expect(mocks.enqueueTableGenerateJob).not.toHaveBeenCalled();
  expect(mocks.writeTablePayloadKey).not.toHaveBeenCalled();
});

test("a regeneration that adds columns but not sources is checked against the cap too", async () => {
  const many = tableContentFixture({
    sources: Array.from({ length: 50 }, (_, index) => ({
      sourceId: `src_${index}`,
      documentId: `doc_${index}`,
      contentHash: `hash_${index}`,
    })),
    columns: [{ name: "Design", type: "text" }],
  });
  mocks.findTableVersionContent.mockResolvedValue(many);
  const columns = Array.from({ length: 9 }, (_, index) => ({
    name: `Column ${index}`,
    type: "text" as const,
  }));
  await assert.rejects(
    requestTableRegeneration(regenerate({ columns })),
    (error: unknown) => (error as { code?: string }).code === "VALIDATION_ERROR",
  );
  expect(mocks.enqueueTableGenerateJob).not.toHaveBeenCalled();
  // Exactly at the cap passes.
  await requestTableRegeneration(regenerate({ columns: columns.slice(0, 8) }));
  expect(mocks.enqueueTableGenerateJob).toHaveBeenCalledTimes(1);
});

test("regeneration needs a ready table with readable content, and refuses a second queued run", async () => {
  mocks.requireViewableArtifact.mockResolvedValueOnce({
    workspace,
    artifact: { id: "art_1", ...scope, artifactType: "table", status: "running", currentVersionNo: 0 },
  });
  await assert.rejects(
    requestTableRegeneration(regenerate()),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
  );
  mocks.findTableVersionContent.mockResolvedValueOnce({ not: "a table" });
  await assert.rejects(
    requestTableRegeneration(regenerate()),
    (error: unknown) => (error as { code?: string }).code === "TABLE_CONTENT_UNREADABLE",
  );
  mocks.enqueueTableGenerateJob.mockResolvedValueOnce({ created: false });
  await assert.rejects(
    requestTableRegeneration(regenerate()),
    (error: unknown) => (error as { code?: string }).code === "TABLE_REGENERATION_IN_PROGRESS",
  );
  expect(mocks.writeTablePayloadKey).not.toHaveBeenCalled();
});

test("a regeneration is refused at the running limit before anything is queued", async () => {
  mocks.countRunningGroundedJobs.mockResolvedValue(3);
  await assert.rejects(
    requestTableRegeneration(regenerate()),
    (error: unknown) => (error as { code?: string }).code === "TABLE_TOO_MANY_RUNNING",
  );
  expect(mocks.enqueueTableGenerateJob).not.toHaveBeenCalled();
});
