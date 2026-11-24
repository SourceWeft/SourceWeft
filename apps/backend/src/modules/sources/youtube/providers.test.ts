import assert from "node:assert/strict";
import { test } from "vitest";
import {
  YouTubeSourceError,
  type YouTubeCatalogProvider,
  type YouTubeTranscriptProvider,
} from "@sourceweft/builtin-document-parsers/youtube";
import { ContentError } from "../../content/errors";
import { HostYouTubeSourceParser } from "./providers";

const catalog = {
  id: "fake-catalog",
  getVideo: async (videoId: string) => ({
    videoId,
    title: "A talk",
    titleSource: "oembed",
  }),
} as unknown as YouTubeCatalogProvider;

function transcriptThatThrows(error: unknown): YouTubeTranscriptProvider {
  return {
    id: "fake-transcript",
    transcribe: async () => {
      throw error;
    },
  };
}

const parseInput = {
  fileName: "YouTube video jNQXAC9IVRw",
  mimeType: "text/x-sourceweft-youtube",
  fileSize: 0,
  content: Buffer.alloc(0),
  config: { chunkSize: 512, parserVersion: "v1" },
  sourceExternalUri: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
} as never;

test("a package YouTube error becomes a ContentError with the same code", async () => {
  const parser = new HostYouTubeSourceParser({
    catalog,
    transcript: transcriptThatThrows(
      new YouTubeSourceError(422, "YOUTUBE_NO_SPEECH", "no speech"),
    ),
  });
  await assert.rejects(parser.parse(parseInput), (error: unknown) => {
    assert.ok(error instanceof ContentError);
    assert.equal(error.statusCode, 422);
    assert.equal(error.code, "YOUTUBE_NO_SPEECH");
    return true;
  });
});

test("a ContentError from the model port passes through unchanged", async () => {
  const failure = new ContentError(502, "YOUTUBE_TRANSCRIPT_FAILED", "failed", {
    details: { modelErrorCode: "MODEL_UPSTREAM_ERROR" },
  });
  const parser = new HostYouTubeSourceParser({
    catalog,
    transcript: transcriptThatThrows(failure),
  });
  await assert.rejects(parser.parse(parseInput), (error: unknown) => {
    assert.equal(error, failure);
    return true;
  });
});
