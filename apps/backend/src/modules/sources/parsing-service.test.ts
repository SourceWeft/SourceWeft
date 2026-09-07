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
}));
vi.mock("./repository", () => ({
  findSourceRecord: async () => fixtures.source,
  findLatestSourceRevisionRecord: async () => ({ id: "revision" }),
  updateSourceStatusForLatestRevision: async () => fixtures.source,
  updateSourceRecordForLatestRevision: async (
    input: Record<string, unknown>,
  ) => {
    fixtures.updates.push(input);
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
  enqueueSourceParsePollJob: vi.fn(),
}));
vi.mock("./parsers", () => ({
  getSourceParser: () => ({ parse: fixtures.parse }),
}));
vi.mock("./parsers/web-fetch", () => ({
  WEB_FETCH_SOURCE_MIME_TYPE: "application/x-web-url",
  webFetchSourceParser: { parse: async () => fixtures.parsed },
}));
vi.mock("./parsers/providers/document-parse-orchestrator", () => ({
  startDocumentParse: async () => ({
    kind: "completed",
    document: fixtures.parsed,
  }),
}));
vi.mock("./parsers/providers/registry", () => ({
  getDocumentProviderForResume: () => ({
    resume: async () => ({ kind: "completed", document: fixtures.parsed }),
  }),
}));
import { SourceParsingService } from "./parsing-service";

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
  fixtures.updates.length = 0;
  fixtures.parse.mockReset().mockResolvedValue(fixtures.parsed);
});
function service() {
  return new SourceParsingService(
    { indexSourceRevision: async () => ({ source: fixtures.source }) } as never,
    {} as never,
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
