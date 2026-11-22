import assert from "node:assert/strict";
import { test } from "node:test";
import { YouTubeSourceError } from "../src/youtube/errors";
import { YOUTUBE_SOURCE_MIME_TYPE } from "../src/youtube/format";
import { YouTubeSourceParser } from "../src/youtube/parser";
import type { YouTubeCatalogProvider } from "../src/youtube/catalog/types";
import type { YouTubeTranscriptProvider } from "../src/youtube/transcript/types";
import type { ParseInput } from "../src/types";

const VIDEO_ID = "jNQXAC9IVRw";

function createFixtureCatalog(): YouTubeCatalogProvider {
  return {
    id: "public-feeds",
    async getVideo(videoId: string) {
      assert.equal(videoId, VIDEO_ID);
      return {
        videoId,
        title: "Me at the zoo",
        titleSource: "oembed" as const,
        channelTitle: "jawed",
        channelUrl: "https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A",
      };
    },
    async listCollection() {
      throw new Error("not used in this test");
    },
  };
}

function createFixtureTranscript(): YouTubeTranscriptProvider {
  return {
    id: "gemini",
    async transcribe(input: { videoId: string; videoUrl: string }) {
      assert.equal(input.videoId, VIDEO_ID);
      assert.equal(input.videoUrl, `https://www.youtube.com/watch?v=${VIDEO_ID}`);
      return {
        language: "en",
        durationSeconds: 40,
        segments: [
          { startSeconds: 0, text: "Okay so here we are." },
          { startSeconds: 31, text: "in front of the elephants." },
        ],
        coverage: { kind: "complete" as const },
        origin: "ai_transcription" as const,
        providerId: "gemini",
        model: "google/gemini-2.5-flash",
        warnings: [],
      };
    },
  };
}

function createParser() {
  return new YouTubeSourceParser({
    catalog: createFixtureCatalog(),
    transcript: createFixtureTranscript(),
  });
}

function baseInput(overrides: Partial<ParseInput> = {}): ParseInput {
  return {
    fileName: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    mimeType: YOUTUBE_SOURCE_MIME_TYPE,
    fileSize: 0,
    content: Buffer.from(""),
    config: { chunkSize: 512, parserVersion: "test" },
    sourceExternalUri: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    ...overrides,
  };
}

test("parses a video source into timestamped markdown with ai_transcription metadata", async () => {
  const parser = createParser();

  const result = await parser.parse(baseInput());

  assert.ok(
    result.content.includes(
      `[0:31](https://www.youtube.com/watch?v=${VIDEO_ID}&t=31s)`,
    ),
  );
  assert.equal(result.metadata.transcriptOrigin, "ai_transcription");
  assert.equal(result.metadata.videoId, VIDEO_ID);
  assert.equal(result.metadata.catalogProvider, "public-feeds");
  assert.equal(result.metadata.transcriptProvider, "gemini");
  assert.equal(result.metadata.transcriptModel, "google/gemini-2.5-flash");
  assert.equal(result.metadata.transcriptLanguage, "en");
  assert.equal(result.metadata.titleSource, "oembed");
  assert.equal(result.title, "Me at the zoo");
});

test("preferInputTitle keeps the requested title instead of the catalog title", async () => {
  const parser = createParser();

  const result = await parser.parse(
    baseInput({ fileName: "My custom title", preferInputTitle: true }),
  );

  assert.equal(result.title, "My custom title");
});

test("a non-video YouTube URL throws YOUTUBE_URL_UNSUPPORTED", async () => {
  const parser = createParser();

  await assert.rejects(
    () =>
      parser.parse(
        baseInput({
          sourceExternalUri: "https://www.youtube.com/playlist?list=PLxyz1234567890",
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof YouTubeSourceError);
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, "YOUTUBE_URL_UNSUPPORTED");
      return true;
    },
  );
});

test("a missing source URL throws YOUTUBE_URL_UNSUPPORTED", async () => {
  const parser = createParser();

  await assert.rejects(
    () => parser.parse(baseInput({ sourceExternalUri: undefined })),
    (error: unknown) => {
      assert.ok(error instanceof YouTubeSourceError);
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, "YOUTUBE_URL_UNSUPPORTED");
      return true;
    },
  );
});
