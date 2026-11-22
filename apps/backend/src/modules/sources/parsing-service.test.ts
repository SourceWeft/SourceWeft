import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  source: {} as Record<string, unknown>,
  parsed: {
    title: "Fixture",
    content: "hello",
    pages: [{ content: "hello" }],
    chunks: [],
    metadata: {},
  },
  bytes: Buffer.from("hello\n"),
  updates: [] as Array<Record<string, unknown>>,
  parse: vi.fn(),
  start: vi.fn(),
  enqueue: vi.fn(),
  index: vi.fn(),
  resume: vi.fn(),
  createVideoPort: vi.fn(),
  createYouTubeParser: vi.fn(),
  youtubeParse: vi.fn(),
  getExecutionState: vi.fn(),
  rejectRevisionWrite: false,
}));
vi.mock("./repository", () => ({
  findSourceRecord: async () => fixtures.source,
  findLatestSourceRevisionRecord: async () => ({ id: "revision" }),
  updateSourceStatusForLatestRevision: async () => fixtures.source,
  updateSourceRecordForLatestRevision: async (
    input: Record<string, unknown>,
  ) => {
    if (fixtures.rejectRevisionWrite) return null;
    fixtures.updates.push(input);
    fixtures.source = { ...fixtures.source, ...input };
    return fixtures.source;
  },
  updateSourceRecord: vi.fn(),
  updateSourceStatus: vi.fn(),
  createSourceRevisionRecord: vi.fn(),
  getSourceStatusDetail: vi.fn(),
}));
vi.mock("./storage", () => ({
  downloadSourceObject: async () => fixtures.bytes,
}));
vi.mock("./guards", () => ({ requireContentSource: vi.fn() }));
vi.mock("../content/queue", () => ({
  enqueueSourceParseJob: vi.fn(),
  enqueueSourceParsePollJob: fixtures.enqueue,
}));
vi.mock("./parsers", () => ({
  getSourceParser: () => ({ parse: fixtures.parse }),
}));
vi.mock("./parsers/web-fetch", () => ({
  WEB_FETCH_SOURCE_MIME_TYPE: "application/x-web-url",
  webFetchSourceParser: { parse: async () => fixtures.parsed },
}));
vi.mock("./parsers/providers/document-parse-orchestrator", () => ({
  isDocumentProviderMimeType: (mimeType: string) =>
    mimeType === "application/pdf" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType.startsWith("image/"),
  startDocumentParse: fixtures.start,
}));
vi.mock("./parsers/providers/registry", () => ({
  getDocumentProviderForResume: () => ({
    resume: fixtures.resume,
  }),
}));
vi.mock("./youtube/model-port", () => ({
  createBilledVideoModelPort: fixtures.createVideoPort,
}));
vi.mock("./youtube/providers", () => ({
  createYouTubeSourceParser: fixtures.createYouTubeParser,
}));
import { SourceParsingService } from "./parsing-service";
import { requireContentSource } from "./guards";
import { createSourceRevisionRecord, updateSourceRecord } from "./repository";
import { enqueueSourceParseJob } from "../content/queue";

beforeEach(() => {
  fixtures.source = {
    id: "source",
    sourceType: "file_upload",
    title: "Fixture",
    mimeType: "text/plain",
    storageKey: "file",
    storageBucket: "bucket",
    metadata: {},
    sizeBytes: 5,
  };
  fixtures.rejectRevisionWrite = false;
  fixtures.resume
    .mockReset()
    .mockResolvedValue({ kind: "completed", document: fixtures.parsed });
  fixtures.parsed.content = "hello";
  fixtures.parsed.metadata = {};
  fixtures.parsed.pages = [{ content: "hello" }];
  fixtures.index
    .mockReset()
    .mockImplementation(async () => ({ source: fixtures.source }));
  fixtures.updates.length = 0;
  fixtures.start
    .mockReset()
    .mockResolvedValue({ kind: "completed", document: fixtures.parsed });
  fixtures.enqueue.mockReset().mockResolvedValue(undefined);
  fixtures.parse.mockReset().mockResolvedValue(fixtures.parsed);
  fixtures.createVideoPort.mockReset().mockResolvedValue({ port: "video" });
  fixtures.youtubeParse.mockReset().mockResolvedValue(fixtures.parsed);
  fixtures.createYouTubeParser
    .mockReset()
    .mockReturnValue({ parse: fixtures.youtubeParse });
  fixtures.getExecutionState
    .mockReset()
    .mockResolvedValue({ kind: "unmetered", reason: "billing_not_installed" });
});
function service() {
  return new SourceParsingService(
    { indexSourceRevision: fixtures.index } as never,
    { getExecutionState: fixtures.getExecutionState } as never,
  );
}
const job = {
  teamId: "team",
  workspaceId: "workspace",
  userId: "user",
  sourceId: "source",
  sourceRevisionId: "revision",
  idempotencyKey: "key",
};
function contentUpdate() {
  return fixtures.updates.find((row) => row.contentText !== undefined)!;
}

test("uploaded original byte size survives parsing and repairs an old parsed-text size", async () => {
  await service().processSourceParseJob(job);
  assert.equal(contentUpdate().sizeBytes, 6);
  assert.equal(
    (contentUpdate().metadata as Record<string, unknown>).parsedTextSizeBytes,
    5,
  );
  assert.equal(fixtures.parse.mock.calls[0]![0].fileSize, 6);
});

test("resumed document parsing preserves original storage byte size", async () => {
  fixtures.source.mimeType = "application/pdf";
  await service().processSourceParsePollJob({
    ...job,
    backendId: "pdf2markdown",
    taskId: "task",
    fileName: "test.pdf",
    mimeType: "application/pdf",
    fileSize: 6,
    parsingConfig: {},
    attempt: 1,
  } as never);
  assert.equal(contentUpdate().sizeBytes, 6);
  assert.equal(
    (contentUpdate().metadata as Record<string, unknown>).parsedTextSizeBytes,
    5,
  );
});

test("a refreshed web source tracks newly parsed content rather than a previous size", async () => {
  Object.assign(fixtures.source, {
    sourceType: "web_url",
    storageKey: null,
    externalUri: "https://example.test",
    sizeBytes: 1234,
  });
  await service().processSourceParseJob(job);
  assert.equal(contentUpdate().sizeBytes, 5);
});

test("resuming an AnyDoc OCR task preserves the entry engine and actual backend diagnostics", async () => {
  fixtures.source.mimeType = "application/pdf";
  fixtures.source.metadata = {
    documentParseEntryEngine: "anydoc",
    documentParseProviderRequested: "anydoc",
    documentParseProviderResolved: "pdf2markdown",
    documentParseBackend: "pdf2markdown",
    providerTaskId: "task",
    parserEngine: "old-engine",
    pageLocationAvailable: false,
    pageCountSource: "old-source",
  };
  await service().processSourceParsePollJob({
    ...job,
    backendId: "pdf2markdown",
    taskId: "task",
    fileName: "test.pdf",
    mimeType: "application/pdf",
    fileSize: 6,
    parsingConfig: {},
    attempt: 1,
  } as never);
  const metadata = contentUpdate().metadata as Record<string, unknown>;
  assert.equal(metadata.documentParseEntryEngine, "anydoc");
  assert.equal(metadata.documentParseProviderRequested, "anydoc");
  assert.equal(metadata.parserEngine, undefined);
  assert.equal(metadata.pageLocationAvailable, undefined);
  assert.equal(metadata.pageCountSource, undefined);
  assert.equal(fixtures.parse.mock.calls.length, 0);
});

function pendingOutcome() {
  return {
    kind: "pending",
    token: {
      backendId: "pdf2markdown",
      taskId: "paid-task",
      sourceId: "source",
      teamId: "team",
      workspaceId: "workspace",
      userId: "user",
      fileName: "scan.pdf",
      mimeType: "application/pdf",
      fileSize: 6,
      parsingConfig: { parserVersion: "v3", chunkSize: 512 },
      attempt: 0,
    },
    diagnostics: {
      metadata: {
        documentParseEntryEngine: "anydoc",
        documentParseBackend: "pdf2markdown",
      },
    },
  };
}

test("enqueue failure after persisted OCR submission reuses the current revision task", async () => {
  fixtures.source.mimeType = "application/pdf";
  fixtures.start.mockResolvedValue(pendingOutcome());
  fixtures.enqueue.mockRejectedValueOnce(new Error("queue unavailable"));
  await assert.rejects(
    service().processSourceParseJob({ ...job, isFinalAttempt: false }),
    /queue unavailable/,
  );
  assert.equal(fixtures.start.mock.calls.length, 1);
  await service().processSourceParseJob(job);
  assert.equal(fixtures.start.mock.calls.length, 1);
  assert.equal(fixtures.enqueue.mock.calls.length, 2);
  assert.equal(fixtures.enqueue.mock.calls[1]?.[0].taskId, "paid-task");
});

for (const mismatch of [
  "sourceRevisionId",
  "sourceId",
  "teamId",
  "workspaceId",
  "userId",
]) {
  test(`OCR pending task is never reused across ${mismatch}`, async () => {
    fixtures.source.mimeType = "application/pdf";
    const pending = {
      sourceRevisionId: "revision",
      token: pendingOutcome().token,
    };
    if (mismatch === "sourceRevisionId")
      pending.sourceRevisionId = "old-revision";
    else Object.assign(pending.token, { [mismatch]: "another-owner" });
    fixtures.source.metadata = { documentParsePending: pending };
    await service().processSourceParseJob(job);
    assert.equal(fixtures.start.mock.calls.length, 1);
    assert.equal(fixtures.enqueue.mock.calls.length, 0);
    assert.equal(
      (contentUpdate().metadata as Record<string, unknown>)
        .documentParsePending,
      undefined,
    );
  });
}

test("fresh local parse clears old OCR diagnostics and preserves upload metadata", async () => {
  fixtures.source.metadata = {
    providerTaskId: "old-task",
    documentParseEntryEngine: "anydoc",
    parserEngine: "old",
    pageCountSource: "old",
    billingPageCount: 12,
    userTitleProvided: true,
  };
  await service().processSourceParseJob(job);
  const metadata = contentUpdate().metadata as Record<string, unknown>;
  for (const key of [
    "providerTaskId",
    "documentParseEntryEngine",
    "parserEngine",
    "pageCountSource",
    "billingPageCount",
  ])
    assert.equal(metadata[key], undefined);
  assert.equal(metadata.userTitleProvided, true);
});

test("Office parsing bills actual text equivalents and ignores old document units", async () => {
  fixtures.source.mimeType =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  fixtures.source.estimatedPages = 99;
  fixtures.parsed.content = "x".repeat(12001);
  fixtures.parsed.pages = [];
  fixtures.parsed.metadata = {
    billingPageCount: 1,
    pageLocationAvailable: false,
  };
  await service().processSourceParseJob(job);
  const metadata = contentUpdate().metadata as Record<string, unknown>;
  assert.equal(metadata.parsedPages, 0);
  assert.equal(metadata.pageCount, undefined);
  assert.equal(metadata.totalPages, 0);
  assert.equal(metadata.ingestionBillingPages, 4);
  assert.equal(metadata.ingestionBillingBasis, "text-equivalent");
  assert.equal(contentUpdate().estimatedPages, 4);
  assert.equal(fixtures.index.mock.calls[0]?.[0].parsedPages, 0);
  assert.equal(fixtures.index.mock.calls[0]?.[0].parsedTokens, 3001);
});

for (const patch of [
  { attempt: -1 },
  { parsingConfig: { chunkSize: 0, parserVersion: "v3" } },
  { parsingConfig: { chunkSize: Infinity, parserVersion: "v3" } },
  { parsingConfig: { chunkSize: 512, parserVersion: " " } },
]) {
  test(`invalid persisted pending schema ${JSON.stringify(patch)} is not reused`, async () => {
    fixtures.source.mimeType = "application/pdf";
    fixtures.source.metadata = {
      documentParsePending: {
        sourceRevisionId: "revision",
        token: { ...pendingOutcome().token, ...patch },
      },
    };
    await service().processSourceParseJob(job);
    assert.equal(fixtures.start.mock.calls.length, 1);
    assert.equal(fixtures.enqueue.mock.calls.length, 0);
  });
}

for (const rejectWrite of [false, true]) {
  test(`pending poll ${rejectWrite ? "does not pollute a new revision" : "persists the new attempt for recovery"}`, async () => {
    fixtures.source.mimeType = "application/pdf";
    const outcome = pendingOutcome();
    outcome.token.attempt = 2;
    fixtures.resume.mockResolvedValue(outcome);
    fixtures.rejectRevisionWrite = rejectWrite;
    await service().processSourceParsePollJob({
      ...job,
      ...outcome.token,
      sourceRevisionId: "revision",
      idempotencyKey: "key",
      attempt: 1,
    } as never);
    assert.equal(fixtures.enqueue.mock.calls.length, rejectWrite ? 0 : 1);
    if (rejectWrite) {
      assert.equal(fixtures.updates.length, 0);
      assert.equal(
        (fixtures.source.metadata as Record<string, unknown>)
          .documentParsePending,
        undefined,
      );
    } else {
      const metadata = fixtures.source.metadata as {
        documentParsePending: {
          sourceRevisionId: string;
          token: { attempt: number };
        };
      };
      assert.equal(metadata.documentParsePending.sourceRevisionId, "revision");
      assert.equal(metadata.documentParsePending.token.attempt, 2);
      assert.equal(fixtures.updates[0]?.sourceRevisionId, "revision");
    }
  });
}

const YOUTUBE_URI = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

function youtubeSource() {
  Object.assign(fixtures.source, {
    sourceType: "youtube",
    title: "YouTube video jNQXAC9IVRw",
    mimeType: "text/x-sourceweft-youtube",
    storageKey: null,
    storageBucket: null,
    externalUri: YOUTUBE_URI,
    sizeBytes: Buffer.byteLength(YOUTUBE_URI),
    metadata: { userTitleProvided: true, videoId: "jNQXAC9IVRw" },
  });
}

test("youtube branch passes billing and completes with transcript content", async () => {
  youtubeSource();
  fixtures.parsed.content = "# Talk\n\n[0:00](link) hello";
  const billing = {
    name: "billing-port",
    getExecutionState: fixtures.getExecutionState,
  };
  await new SourceParsingService(
    { indexSourceRevision: fixtures.index } as never,
    billing as never,
  ).processSourceParseJob(job);

  assert.deepEqual(fixtures.createVideoPort.mock.calls[0]![0], {
    billing,
    teamId: "team",
    workspaceId: "workspace",
    userId: "user",
    sourceId: "source",
    idempotencyKey: "key",
  });
  assert.deepEqual(fixtures.createYouTubeParser.mock.calls[0]![0], {
    port: "video",
  });

  const parseInput = fixtures.youtubeParse.mock.calls[0]![0];
  assert.equal(parseInput.billing, billing);
  assert.equal(parseInput.sourceExternalUri, YOUTUBE_URI);
  assert.equal(parseInput.preferInputTitle, true);
  assert.equal(parseInput.mimeType, "text/x-sourceweft-youtube");
  assert.equal(parseInput.idempotencyKey, "key");
  assert.equal(fixtures.parse.mock.calls.length, 0);

  assert.equal(contentUpdate().contentText, "# Talk\n\n[0:00](link) hello");
  assert.equal(fixtures.index.mock.calls.length, 1);
  const last = fixtures.updates.at(-1)!;
  assert.equal(
    (last.metadata as Record<string, unknown>).currentStep,
    "completed",
  );
});

test("a youtube parse without a job key bills under a per-revision key", async () => {
  youtubeSource();
  const { idempotencyKey: _omitted, ...withoutKey } = job;
  await service().processSourceParseJob(withoutKey);
  assert.equal(
    fixtures.createVideoPort.mock.calls[0]![0].idempotencyKey,
    "source_parse_source_revision",
  );
});

test("a failed youtube transcription fails the source with its code", async () => {
  youtubeSource();
  const failure = Object.assign(new Error("private video"), {
    code: "YOUTUBE_VIDEO_UNAVAILABLE",
  });
  fixtures.youtubeParse.mockRejectedValue(failure);
  await assert.rejects(service().processSourceParseJob(job), /private video/);
  assert.equal(fixtures.index.mock.calls.length, 0);
});

test("a youtube parse with no ingestion pages left fails before any model call", async () => {
  youtubeSource();
  fixtures.getExecutionState.mockResolvedValue({
    kind: "metered",
    mode: "enforced",
    availableCredits: 100,
    consumedThisCycle: 0,
    ingestionPages: { enforced: true, available: 0, cycleCapacity: 10 },
  });

  await assert.rejects(service().processSourceParseJob(job), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, "PAGES_LIMIT_EXCEEDED");
    assert.equal((error as { statusCode?: unknown }).statusCode, 402);
    return true;
  });
  assert.deepEqual(fixtures.getExecutionState.mock.calls[0], ["team", "user"]);
  assert.equal(fixtures.createVideoPort.mock.calls.length, 0);
  assert.equal(fixtures.youtubeParse.mock.calls.length, 0);
  assert.equal(fixtures.index.mock.calls.length, 0);
});

test("a youtube parse with one ingestion page left goes ahead", async () => {
  youtubeSource();
  fixtures.getExecutionState.mockResolvedValue({
    kind: "metered",
    mode: "enforced",
    availableCredits: 100,
    consumedThisCycle: 0,
    ingestionPages: { enforced: true, available: 1, cycleCapacity: 10 },
  });

  await service().processSourceParseJob(job);
  assert.equal(fixtures.createVideoPort.mock.calls.length, 1);
  assert.equal(fixtures.youtubeParse.mock.calls.length, 1);
});

test("a youtube source can be reparsed without stored bytes", async () => {
  youtubeSource();
  vi.mocked(requireContentSource).mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
    source: { ...fixtures.source, id: "source" },
  } as never);
  vi.mocked(updateSourceRecord).mockResolvedValue(fixtures.source as never);
  vi.mocked(createSourceRevisionRecord).mockResolvedValue({
    id: "revision-2",
    revisionNo: 2,
  } as never);
  vi.mocked(enqueueSourceParseJob).mockResolvedValue({ id: "job-2" } as never);

  const result = await service().tryQueueSourceReparse({
    workspaceId: "workspace",
    sourceId: "source",
    userId: "user",
  });
  assert.ok(result);
  assert.equal(
    vi.mocked(enqueueSourceParseJob).mock.calls.at(-1)![0].idempotencyKey,
    "source_parse_source_2",
  );
});
