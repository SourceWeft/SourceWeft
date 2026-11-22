import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { ContentError } from "../content/errors";
import { toApiError } from "../../api/response/api-response";

const mocks = vi.hoisted(() => ({
  sources: new Map<string, Record<string, unknown>>(),
  createSourceRecord: vi.fn(),
  updateSourceRecord: vi.fn(),
  findSourceRecordByExternalUri: vi.fn(),
  createSourceRevisionRecord: vi.fn(),
  getSourceStatusDetail: vi.fn(),
  enqueueSourceParseJob: vi.fn(),
  assertConfigured: vi.fn(),
}));

vi.mock("../workspace/guards", () => ({
  requireContentWorkspace: async () => ({
    id: "ws-1",
    organizationId: "team-1",
  }),
}));
vi.mock("./repository", () => ({
  createSourceRecord: mocks.createSourceRecord,
  updateSourceRecord: mocks.updateSourceRecord,
  findSourceRecordByExternalUri: mocks.findSourceRecordByExternalUri,
  createSourceRevisionRecord: mocks.createSourceRevisionRecord,
  getSourceStatusDetail: mocks.getSourceStatusDetail,
}));
vi.mock("../content/queue", () => ({
  enqueueSourceParseJob: mocks.enqueueSourceParseJob,
}));
vi.mock("./youtube/model-port", () => ({
  assertYouTubeTranscriptionConfigured: mocks.assertConfigured,
}));

import { ContentSourceService } from "./service";

const VIDEO_ID = "jNQXAC9IVRw";
const CANONICAL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

beforeEach(() => {
  mocks.sources.clear();
  let nextId = 0;
  mocks.createSourceRecord.mockReset().mockImplementation(async (input) => {
    const source = { id: `source-${++nextId}`, status: "queued", ...input };
    mocks.sources.set(source.id, source);
    return source;
  });
  mocks.updateSourceRecord.mockReset().mockImplementation(async (input) => {
    const source = { ...mocks.sources.get(input.sourceId), ...input };
    mocks.sources.set(input.sourceId, source);
    return source;
  });
  mocks.findSourceRecordByExternalUri
    .mockReset()
    .mockImplementation(
      async (input: { sourceType: string; externalUri: string }) =>
        [...mocks.sources.values()].find(
          (source) =>
            source.sourceType === input.sourceType &&
            source.externalUri === input.externalUri,
        ) ?? null,
    );
  mocks.createSourceRevisionRecord
    .mockReset()
    .mockResolvedValue({ id: "revision-1", revisionNo: 1 });
  mocks.getSourceStatusDetail.mockReset().mockResolvedValue(null);
  mocks.enqueueSourceParseJob.mockReset().mockResolvedValue({ id: "job-1" });
  mocks.assertConfigured.mockReset().mockResolvedValue(undefined);
});

function create(url: string, extra: Record<string, unknown> = {}) {
  return new ContentSourceService().createUrlSource({
    workspaceId: "ws-1",
    userId: "user-1",
    url,
    ...extra,
  });
}

test("creates a youtube source with canonical uri and video id", async () => {
  const result = await create(`https://youtu.be/${VIDEO_ID}?si=share`);

  assert.equal(mocks.createSourceRecord.mock.calls.length, 1);
  const input = mocks.createSourceRecord.mock.calls[0]![0];
  assert.equal(input.ingestKind, "youtube");
  assert.equal(input.sourceType, "youtube");
  assert.equal(input.externalId, VIDEO_ID);
  assert.equal(input.externalUri, CANONICAL);
  assert.equal(input.mimeType, "text/x-sourceweft-youtube");
  assert.equal(input.title, `YouTube video ${VIDEO_ID}`);
  assert.equal(input.status, "queued");
  assert.equal(input.createdBy, "user-1");
  assert.deepEqual(
    {
      loaderId: input.metadata.loaderId,
      parserId: input.metadata.parserId,
      videoId: input.metadata.videoId,
      requestedUrl: input.metadata.requestedUrl,
      catalogProvider: input.metadata.catalogProvider,
      transcriptProvider: input.metadata.transcriptProvider,
      userTitleProvided: input.metadata.userTitleProvided,
    },
    {
      loaderId: "youtube",
      parserId: "youtube",
      videoId: VIDEO_ID,
      requestedUrl: `https://youtu.be/${VIDEO_ID}?si=share`,
      catalogProvider: "public-feeds",
      transcriptProvider: "gemini",
      userTitleProvided: false,
    },
  );

  assert.equal(mocks.findSourceRecordByExternalUri.mock.calls.length, 1);
  assert.deepEqual(mocks.findSourceRecordByExternalUri.mock.calls[0]![0], {
    teamId: "team-1",
    workspaceId: "ws-1",
    sourceType: "youtube",
    externalUri: CANONICAL,
  });

  assert.equal(mocks.enqueueSourceParseJob.mock.calls.length, 1);
  assert.equal(
    mocks.enqueueSourceParseJob.mock.calls[0]![0].idempotencyKey,
    "source_parse_source-1_1",
  );
  assert.equal(result.source.id, "source-1");
  assert.equal(result.status.status, "queued");
});

test("a user title is kept and marked as provided", async () => {
  await create(CANONICAL, { title: "  My talk  " });
  const input = mocks.createSourceRecord.mock.calls[0]![0];
  assert.equal(input.title, "My talk");
  assert.equal(input.metadata.userTitleProvided, true);
});

test("dedupes across url forms", async () => {
  const first = await create(`https://youtu.be/${VIDEO_ID}`);
  const second = await create(`https://www.youtube.com/shorts/${VIDEO_ID}`);
  const third = await create(
    `https://m.youtube.com/watch?v=${VIDEO_ID}&list=PLxyz12345&index=3`,
  );

  assert.equal(mocks.createSourceRecord.mock.calls.length, 1);
  assert.equal(second.source.id, first.source.id);
  assert.equal(third.source.id, first.source.id);
  assert.equal(mocks.enqueueSourceParseJob.mock.calls.length, 1);
});

test("forceRefresh on an existing video queues a new parse of the same source", async () => {
  const first = await create(`https://youtu.be/${VIDEO_ID}`);
  const refreshed = await create(CANONICAL, { forceRefresh: true });

  assert.equal(mocks.createSourceRecord.mock.calls.length, 1);
  assert.equal(refreshed.source.id, first.source.id);
  assert.equal(mocks.enqueueSourceParseJob.mock.calls.length, 2);
  assert.equal(
    mocks.enqueueSourceParseJob.mock.calls[1]![0].forceRefresh,
    true,
  );
});

for (const [url, kind] of [
  ["https://www.youtube.com/playlist?list=PLxyz12345", "playlist"],
  ["https://www.youtube.com/@GoogleDevelopers", "channel"],
  ["https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw", "channel"],
] as const) {
  test(`collection url throws YOUTUBE_COLLECTION_URL with kind (${kind}: ${url})`, async () => {
    await assert.rejects(create(url), (error: unknown) => {
      assert.ok(error instanceof ContentError);
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, "YOUTUBE_COLLECTION_URL");
      assert.deepEqual(error.details, { kind });

      // API clients receive the kind too.
      const apiError = toApiError(error);
      assert.equal(apiError.code, "YOUTUBE_COLLECTION_URL");
      assert.deepEqual(apiError.details, { kind });
      return true;
    });
    assert.equal(mocks.createSourceRecord.mock.calls.length, 0);
    assert.equal(mocks.enqueueSourceParseJob.mock.calls.length, 0);
  });
}

for (const url of [
  "https://www.youtube.com/feed/history",
  "https://youtu.be/",
  "https://www.youtube.com/watch?v=short",
  "https://YOUTU.BE./jNQXAC9IVRw",
]) {
  test(`an unrecognised YouTube link is YOUTUBE_URL_UNSUPPORTED (${url})`, async () => {
    await assert.rejects(create(url), (error: unknown) => {
      assert.ok(error instanceof ContentError);
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, "YOUTUBE_URL_UNSUPPORTED");
      return true;
    });
    assert.equal(mocks.createSourceRecord.mock.calls.length, 0);
  });
}

test("unconfigured profile throws YOUTUBE_TRANSCRIPTION_NOT_CONFIGURED and creates nothing", async () => {
  mocks.assertConfigured.mockRejectedValue(
    new ContentError(
      503,
      "YOUTUBE_TRANSCRIPTION_NOT_CONFIGURED",
      "not configured",
    ),
  );
  await assert.rejects(create(CANONICAL), {
    code: "YOUTUBE_TRANSCRIPTION_NOT_CONFIGURED",
  });
  assert.equal(mocks.createSourceRecord.mock.calls.length, 0);
  assert.equal(mocks.updateSourceRecord.mock.calls.length, 0);
  assert.equal(mocks.createSourceRevisionRecord.mock.calls.length, 0);
  assert.equal(mocks.enqueueSourceParseJob.mock.calls.length, 0);
});

test("a non-YouTube link still becomes a web source", async () => {
  await create("https://example.com/article");
  assert.equal(mocks.assertConfigured.mock.calls.length, 0);
  const input = mocks.createSourceRecord.mock.calls[0]![0];
  assert.equal(input.sourceType, "web_url");
  assert.equal(input.externalUri, "https://example.com/article");
});
