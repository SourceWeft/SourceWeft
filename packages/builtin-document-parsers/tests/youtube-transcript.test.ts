import assert from "node:assert/strict";
import { test } from "node:test";
import { YouTubeSourceError } from "../src/youtube/errors";
import { formatYouTubeSourceMarkdown } from "../src/youtube/format";
import { canonicalVideoUrl } from "../src/youtube/url";
import { createGeminiTranscriptProvider } from "../src/youtube/transcript/gemini";
import { parseTranscriptOutput } from "../src/youtube/transcript/parse";
import {
  YOUTUBE_TRANSCRIPT_MAX_OUTPUT_TOKENS,
  type VideoModelPort,
  type YouTubeTranscript,
} from "../src/youtube/transcript/types";
import type { YouTubeVideoInfo } from "../src/youtube/catalog/types";

test("parses header and segments", () => {
  const text = [
    "LANGUAGE: en",
    "DURATION: 0:45",
    "SPEECH: yes",
    "[0:00] Hello and welcome to the show.",
    "[0:20] Today we talk about testing.",
  ].join("\n");

  const result = parseTranscriptOutput(text, { truncated: false });

  assert.equal(result.language, "en");
  assert.equal(result.durationSeconds, 45);
  assert.equal(result.speech, true);
  assert.deepEqual(result.segments, [
    { startSeconds: 0, text: "Hello and welcome to the show." },
    { startSeconds: 20, text: "Today we talk about testing." },
  ]);
  assert.deepEqual(result.warnings, []);
});

test("non-monotonic stamps merge into previous segment", () => {
  const text = "[0:00] a\n[0:40] b\n[0:20] c";

  const result = parseTranscriptOutput(text, { truncated: false });

  assert.deepEqual(result.segments, [
    { startSeconds: 0, text: "a" },
    { startSeconds: 40, text: "b c" },
  ]);
  assert.equal(result.warnings.length, 1);
});

test("stamp beyond duration merges", () => {
  const text = ["DURATION: 0:30", "[0:00] a", "[0:40] b"].join("\n");

  const result = parseTranscriptOutput(text, { truncated: false });

  assert.deepEqual(result.segments, [{ startSeconds: 0, text: "a b" }]);
  assert.equal(result.warnings.length, 1);
});

test("text before the first stamp becomes a segment at 0", () => {
  const text = ["LANGUAGE: en", "preamble line", "[0:10] first stamped line"].join("\n");

  const result = parseTranscriptOutput(text, { truncated: false });

  assert.deepEqual(result.segments, [
    { startSeconds: 0, text: "preamble line" },
    { startSeconds: 10, text: "first stamped line" },
  ]);
});

test("length finish keeps complete lines", () => {
  const text = [
    "LANGUAGE: en",
    "DURATION: 2:00",
    "SPEECH: yes",
    "[0:00] First bit.",
    "[0:30] Second bit.",
    "[1:00] half a sen",
  ].join("\n");

  const result = parseTranscriptOutput(text, { truncated: true });

  assert.deepEqual(result.segments, [
    { startSeconds: 0, text: "First bit." },
    { startSeconds: 30, text: "Second bit." },
  ]);
});

test("truncated keeps the last line when it ends with terminal punctuation and a trailing newline", () => {
  const text = "[0:00] First bit.\n[0:30] Second bit.\n";

  const result = parseTranscriptOutput(text, { truncated: true });

  assert.deepEqual(result.segments, [
    { startSeconds: 0, text: "First bit." },
    { startSeconds: 30, text: "Second bit." },
  ]);
});

test("speech no throws YOUTUBE_NO_SPEECH", async () => {
  const fakeModel: VideoModelPort = {
    complete: async () => ({
      text: "LANGUAGE: en\nDURATION: 0:10\nSPEECH: no\n",
    }),
  };
  const provider = createGeminiTranscriptProvider({ model: fakeModel });

  await assert.rejects(
    () => provider.transcribe({ videoId: "abc", videoUrl: canonicalVideoUrl("abc") }),
    (error: unknown) => {
      assert.ok(error instanceof YouTubeSourceError);
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, "YOUTUBE_NO_SPEECH");
      return true;
    },
  );
});

test("empty model output throws YOUTUBE_TRANSCRIPT_FAILED", async () => {
  const fakeModel: VideoModelPort = {
    complete: async () => ({ text: "   " }),
  };
  const provider = createGeminiTranscriptProvider({ model: fakeModel });

  await assert.rejects(
    () => provider.transcribe({ videoId: "abc", videoUrl: canonicalVideoUrl("abc") }),
    (error: unknown) => {
      assert.ok(error instanceof YouTubeSourceError);
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, "YOUTUBE_TRANSCRIPT_FAILED");
      return true;
    },
  );
});

test("gemini provider passes max output tokens 65536 and the canonical url", async () => {
  const videoId = "jNQXAC9IVRw";
  const videoUrl = canonicalVideoUrl(videoId);
  const calls: { prompt: string; videoUrl: string; maxOutputTokens: number }[] = [];
  const fakeModel: VideoModelPort = {
    complete: async (input) => {
      calls.push(input);
      return {
        text: "LANGUAGE: en\nDURATION: 0:10\nSPEECH: yes\n[0:00] Hi.\n",
        model: "google/gemini-2.5-flash",
        finishReason: "stop",
      };
    },
  };
  const provider = createGeminiTranscriptProvider({ model: fakeModel });

  const transcript = await provider.transcribe({ videoId, videoUrl });

  const recorded = calls[0];
  assert.ok(recorded);
  assert.equal(recorded.videoUrl, videoUrl);
  assert.equal(recorded.maxOutputTokens, YOUTUBE_TRANSCRIPT_MAX_OUTPUT_TOKENS);
  assert.equal(recorded.maxOutputTokens, 65_536);
  assert.ok(recorded.prompt.includes("Transcribe the speech in this video verbatim"));
  assert.equal(provider.id, "gemini");
  assert.equal(transcript.origin, "ai_transcription");
  assert.equal(transcript.providerId, "gemini");
  assert.equal(transcript.model, "google/gemini-2.5-flash");
  assert.deepEqual(transcript.coverage, { kind: "complete" });
});

test("length finish reports partial coverage ending at the last kept segment", async () => {
  const fakeModel: VideoModelPort = {
    complete: async () => ({
      text: [
        "LANGUAGE: en",
        "DURATION: 2:00",
        "SPEECH: yes",
        "[0:00] First bit.",
        "[0:30] Second bit incomplete",
      ].join("\n"),
      finishReason: "length",
    }),
  };
  const provider = createGeminiTranscriptProvider({ model: fakeModel });

  const transcript = await provider.transcribe({
    videoId: "abc",
    videoUrl: canonicalVideoUrl("abc"),
  });

  assert.deepEqual(transcript.coverage, { kind: "partial", endSeconds: 0 });
  assert.deepEqual(transcript.segments, [{ startSeconds: 0, text: "First bit." }]);
});

test("format renders timestamp links and partial note", () => {
  const video: YouTubeVideoInfo = {
    videoId: "jNQXAC9IVRw",
    title: "Me at the zoo",
    titleSource: "oembed",
    channelTitle: "jawed",
    channelUrl: "https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A",
  };
  const transcript: YouTubeTranscript = {
    language: "en",
    durationSeconds: 65,
    segments: [
      { startSeconds: 0, text: "Okay so here we are." },
      { startSeconds: 31, text: "in front of the elephants." },
    ],
    coverage: { kind: "partial", endSeconds: 31 },
    origin: "ai_transcription",
    providerId: "gemini",
    model: "google/gemini-2.5-flash",
    warnings: [],
  };

  const markdown = formatYouTubeSourceMarkdown({ video, transcript });

  assert.ok(markdown.includes("# Me at the zoo"));
  assert.ok(
    markdown.includes(
      "Channel: [jawed](https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A)",
    ),
  );
  assert.ok(markdown.includes("Video: https://www.youtube.com/watch?v=jNQXAC9IVRw"));
  assert.ok(markdown.includes("Transcript: AI transcription (google/gemini-2.5-flash)"));
  assert.ok(markdown.includes("Transcript covers 0:00–0:31 of 1:05."));
  assert.ok(
    markdown.includes(
      "[0:00](https://www.youtube.com/watch?v=jNQXAC9IVRw&t=0s) Okay so here we are.",
    ),
  );
  assert.ok(
    markdown.includes(
      "[0:31](https://www.youtube.com/watch?v=jNQXAC9IVRw&t=31s) in front of the elephants.",
    ),
  );
});

test("format renders a timestamp over an hour as h:mm:ss", () => {
  const video: YouTubeVideoInfo = {
    videoId: "jNQXAC9IVRw",
    title: "Long talk",
    titleSource: "fallback",
  };
  const transcript: YouTubeTranscript = {
    segments: [{ startSeconds: 3725, text: "An hour in." }],
    coverage: { kind: "complete" },
    origin: "ai_transcription",
    providerId: "gemini",
    warnings: [],
  };

  const markdown = formatYouTubeSourceMarkdown({ video, transcript });

  assert.ok(
    markdown.includes(
      "[1:02:05](https://www.youtube.com/watch?v=jNQXAC9IVRw&t=3725s) An hour in.",
    ),
  );
  assert.ok(!markdown.includes("Channel:"));
});
