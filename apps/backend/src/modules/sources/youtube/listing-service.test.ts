import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { ContentError } from "../../content/errors";
import { YouTubeSourceError } from "@sourceweft/builtin-document-parsers/youtube";
import { listYouTubeCollection } from "./listing-service";

const listCollection = vi.fn();
const getVideo = vi.fn();
const catalog = { id: "fake-catalog", getVideo, listCollection } as never;
const consume = vi.fn();
const findExistingSourceId = vi.fn();

const PLAYLIST_URL =
  "https://www.youtube.com/playlist?list=PLabc1234567890xyz";
const VIDEO_URL = "https://www.youtube.com/watch?v=aaaaaaaaaaa";

const baseInput = {
  teamId: "team-1",
  workspaceId: "ws-1",
  userId: "user-1",
  url: PLAYLIST_URL,
};

const deps = (overrides: Record<string, unknown> = {}) => ({
  catalog,
  rateLimiter: { consume } as never,
  findExistingSourceId,
  ...overrides,
});

beforeEach(() => {
  listCollection.mockReset();
  getVideo.mockReset();
  consume.mockReset().mockResolvedValue({ allowed: true });
  findExistingSourceId.mockReset().mockResolvedValue(null);
});

test("marks videos already added", async () => {
  listCollection.mockResolvedValue({
    kind: "playlist",
    title: "My playlist",
    videos: [
      {
        videoId: "aaaaaaaaaaa",
        title: "V1",
        url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      },
      {
        videoId: "bbbbbbbbbbb",
        title: "V2",
        url: "https://www.youtube.com/watch?v=bbbbbbbbbbb",
      },
    ],
  });
  findExistingSourceId.mockImplementation(
    async (input: { teamId: string; workspaceId: string; url: string }) =>
      input.url === "https://www.youtube.com/watch?v=aaaaaaaaaaa"
        ? "source-1"
        : null,
  );

  const result = await listYouTubeCollection(baseInput, deps());

  assert.equal(result.kind, "playlist");
  assert.deepEqual(
    result.videos.map((video) => [video.videoId, video.existingSourceId]),
    [
      ["aaaaaaaaaaa", "source-1"],
      ["bbbbbbbbbbb", null],
    ],
  );
  const firstCall = findExistingSourceId.mock.calls[0]?.[0];
  assert.equal(firstCall.teamId, "team-1");
  assert.equal(firstCall.workspaceId, "ws-1");
});

test("video url is rejected by listing", async () => {
  await assert.rejects(
    listYouTubeCollection({ ...baseInput, url: VIDEO_URL }, deps()),
    (error: unknown) => {
      assert.ok(error instanceof ContentError);
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, "YOUTUBE_URL_UNSUPPORTED");
      return true;
    },
  );
  assert.equal(listCollection.mock.calls.length, 0);
  assert.equal(consume.mock.calls.length, 0);
});

test("an unrecognised youtube url is also rejected", async () => {
  await assert.rejects(
    listYouTubeCollection(
      { ...baseInput, url: "https://www.youtube.com/feed/trending" },
      deps(),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ContentError);
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, "YOUTUBE_URL_UNSUPPORTED");
      return true;
    },
  );
});

test("a refused rate limit is rejected before any catalog call", async () => {
  consume.mockResolvedValue({
    allowed: false,
    scope: "hour",
    limit: 150,
    windowSeconds: 3600,
    retryAfterSeconds: 1380,
  });

  await assert.rejects(
    listYouTubeCollection(baseInput, deps()),
    (error: unknown) => {
      assert.ok(error instanceof ContentError);
      assert.equal(error.statusCode, 429);
      assert.equal(error.code, "SOURCE_DISCOVERY_RATE_LIMITED");
      return true;
    },
  );
  assert.equal(listCollection.mock.calls.length, 0);
  const rules = consume.mock.calls[0]?.[0] as Array<{ key: string }>;
  assert.deepEqual(
    rules.map((rule) => rule.key),
    [
      "source-discovery:user:user-1",
      "source-discovery:user:user-1",
      "source-discovery:user:user-1",
      "source-discovery:team:team-1",
    ],
  );
});

test("a catalog error becomes a ContentError with the same code", async () => {
  listCollection.mockRejectedValue(
    new YouTubeSourceError(404, "YOUTUBE_CHANNEL_NOT_FOUND", "not found"),
  );

  await assert.rejects(
    listYouTubeCollection(baseInput, deps()),
    (error: unknown) => {
      assert.ok(error instanceof ContentError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, "YOUTUBE_CHANNEL_NOT_FOUND");
      return true;
    },
  );
});

test("a missing playlist keeps its playlist code", async () => {
  listCollection.mockRejectedValue(
    new YouTubeSourceError(404, "YOUTUBE_PLAYLIST_NOT_FOUND", "not found"),
  );

  await assert.rejects(
    listYouTubeCollection(baseInput, deps()),
    (error: unknown) => {
      assert.ok(error instanceof ContentError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, "YOUTUBE_PLAYLIST_NOT_FOUND");
      return true;
    },
  );
});
