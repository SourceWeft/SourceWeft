// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { HttpClientError } from "@sourceweft/sdk";

const listYouTubeCollection = vi.hoisted(() => vi.fn());
const createUrlSource = vi.hoisted(() => vi.fn());
const listSourceStatuses = vi.hoisted(() => vi.fn());

vi.mock("../../../../../../lib/sdk", () => ({
  contentClient: { listYouTubeCollection, createUrlSource, listSourceStatuses },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { YouTubeListingDialog } from "./youtube-listing-dialog";
import { click, flush, mountWithIntl, unmountAll } from "@/test/react";

const PLAYLIST_URL =
  "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf";

const LISTING = {
  kind: "playlist",
  title: "Battery lectures",
  channelTitle: "Open Courseware",
  videos: [
    {
      videoId: "aaaaaaaaaaa",
      title: "Lecture 1: Cells",
      url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      publishedAt: "2026-01-05T00:00:00Z",
      thumbnailUrl: "https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg",
      existingSourceId: null,
    },
    {
      videoId: "bbbbbbbbbbb",
      title: "Lecture 2: Anodes",
      url: "https://www.youtube.com/watch?v=bbbbbbbbbbb",
      existingSourceId: null,
    },
    {
      videoId: "ccccccccccc",
      title: "Lecture 3: Already here",
      url: "https://www.youtube.com/watch?v=ccccccccccc",
      existingSourceId: "source-3",
    },
  ],
};

beforeEach(() => {
  listYouTubeCollection.mockReset();
  createUrlSource.mockReset();
  listSourceStatuses.mockReset();
});
afterEach(unmountAll);

const text = () => document.body.textContent ?? "";
const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(name),
  );
const checkboxOf = (videoId: string) =>
  document.body
    .querySelector(`[data-youtube-video="${videoId}"]`)
    ?.querySelector('[role="checkbox"]') as HTMLElement | null;

async function mountOpen(onImported = vi.fn()) {
  await mountWithIntl(
    createElement(YouTubeListingDialog, {
      onImported,
      onOpenChange: () => {},
      parentSourceId: "folder-1",
      url: PLAYLIST_URL,
      workspaceId: "w1",
    }),
  );
  await flush(3);
  return onImported;
}

test("the listing shows the collection title, channel and videos", async () => {
  listYouTubeCollection.mockResolvedValue(LISTING);
  await mountOpen();

  assert.deepEqual(listYouTubeCollection.mock.calls[0], [
    "w1",
    { url: PLAYLIST_URL },
  ]);
  assert.ok(text().includes("Battery lectures"));
  assert.ok(text().includes("Open Courseware"));
  assert.ok(text().includes("Lecture 1: Cells"));
  assert.ok(text().includes("Lecture 2: Anodes"));
});

test("existing videos are disabled", async () => {
  listYouTubeCollection.mockResolvedValue(LISTING);
  await mountOpen();

  assert.ok(text().includes("Already added"));
  assert.equal(checkboxOf("ccccccccccc")?.hasAttribute("disabled"), true);
  assert.equal(checkboxOf("aaaaaaaaaaa")?.hasAttribute("disabled"), false);
  await click(buttonNamed("Select all")!);
  assert.ok(buttonNamed("Import 2 videos"));
});

test("import sends only selected videos", async () => {
  listYouTubeCollection.mockResolvedValue(LISTING);
  createUrlSource.mockImplementation(
    async (_ws: string, input: { url: string }) => ({
      source: { id: `id:${input.url}` },
    }),
  );
  listSourceStatuses.mockImplementation(
    async (_ws: string, input: { ids: string[] }) => ({
      items: input.ids.map((id) => ({
        id,
        status: { status: "indexed", error: null, errorCode: null },
      })),
    }),
  );
  const onImported = await mountOpen();

  assert.equal(buttonNamed("Import 0 videos")?.hasAttribute("disabled"), true);
  await click(checkboxOf("bbbbbbbbbbb")!);
  await click(buttonNamed("Import 1 video")!);
  await flush(6);

  assert.deepEqual(
    createUrlSource.mock.calls.map((call) => call.slice(0, 2)),
    [
      [
        "w1",
        {
          url: "https://www.youtube.com/watch?v=bbbbbbbbbbb",
          parentSourceId: "folder-1",
        },
      ],
    ],
  );
  assert.ok(text().includes("1 added, 0 failed, 0 not imported."));
  assert.equal(onImported.mock.calls.length, 1);
});

test("YOUTUBE_NO_SPEECH renders the localized message", async () => {
  listYouTubeCollection.mockResolvedValue(LISTING);
  createUrlSource.mockImplementation(
    async (_ws: string, input: { url: string }) => ({
      source: { id: `id:${input.url}` },
    }),
  );
  listSourceStatuses.mockImplementation(
    async (_ws: string, input: { ids: string[] }) => ({
      items: input.ids.map((id) => ({
        id,
        status: {
          status: "failed",
          error: "raw provider text",
          errorCode: "YOUTUBE_NO_SPEECH",
        },
      })),
    }),
  );
  await mountOpen();

  await click(checkboxOf("aaaaaaaaaaa")!);
  await click(buttonNamed("Import 1 video")!);
  await flush(6);

  assert.ok(text().includes("No speech was found in this video"));
  assert.ok(!text().includes("raw provider text"));
});

test("an unknown failure keeps the server message", async () => {
  listYouTubeCollection.mockResolvedValue(LISTING);
  createUrlSource.mockRejectedValue(
    new HttpClientError({
      message: "Something odd happened.",
      status: 500,
      statusText: "Internal Server Error",
      code: "INTERNAL",
    }),
  );
  await mountOpen();

  await click(checkboxOf("aaaaaaaaaaa")!);
  await click(buttonNamed("Import 1 video")!);
  await flush(6);

  assert.ok(text().includes("Something odd happened."));
});

test("a listing error is localized", async () => {
  listYouTubeCollection.mockRejectedValue(
    new HttpClientError({
      message: "raw",
      status: 404,
      statusText: "Not Found",
      code: "YOUTUBE_CHANNEL_NOT_FOUND",
    }),
  );
  await mountOpen();

  assert.ok(text().includes("This channel could not be found."));
  assert.ok(buttonNamed("Try again"));
});

test("a missing playlist is reported as a playlist, not a channel", async () => {
  listYouTubeCollection.mockRejectedValue(
    new HttpClientError({
      message: "raw",
      status: 404,
      statusText: "Not Found",
      code: "YOUTUBE_PLAYLIST_NOT_FOUND",
    }),
  );
  await mountOpen();

  assert.ok(text().includes("This playlist could not be found."));
  assert.ok(!text().includes("channel"));
  assert.ok(buttonNamed("Try again"));
});

test("a refused listing says when it can be tried again", async () => {
  listYouTubeCollection.mockRejectedValue(
    new HttpClientError({
      message: "slow down",
      status: 429,
      statusText: "Too Many Requests",
      code: "SOURCE_DISCOVERY_RATE_LIMITED",
      details: { scope: "minute", retryAfterSeconds: 30 },
    }),
  );
  await mountOpen();

  const notice = document.body.querySelector("[data-rate-limit-notice]");
  assert.ok(notice?.textContent?.includes("30s"));
  assert.equal(buttonNamed("Try again")?.hasAttribute("disabled"), true);
});

const TRANSCRIPT_NOTE = "Videos are transcribed by AI";
const COST_NOTE = "Transcribing a video uses credits.";

test("the transcript and cost notes appear only once the listing has loaded", async () => {
  let resolveListing: (value: typeof LISTING) => void = () => {};
  listYouTubeCollection.mockReturnValue(
    new Promise((resolve) => {
      resolveListing = resolve;
    }),
  );
  await mountOpen();

  assert.ok(text().includes("Loading videos"));
  assert.ok(!text().includes(TRANSCRIPT_NOTE));
  assert.ok(!text().includes(COST_NOTE));

  resolveListing(LISTING);
  await flush(3);

  assert.ok(text().includes(TRANSCRIPT_NOTE));
  assert.ok(text().includes(COST_NOTE));
});

test("a listing error shows no transcript note", async () => {
  listYouTubeCollection.mockRejectedValue(
    new HttpClientError({
      message: "raw",
      status: 502,
      statusText: "Bad Gateway",
      code: "YOUTUBE_LISTING_FAILED",
    }),
  );
  await mountOpen();

  assert.ok(text().includes("The videos could not be listed."));
  assert.ok(!text().includes(TRANSCRIPT_NOTE));
});

test("a video refused for lack of ingestion pages shows the quota row", async () => {
  listYouTubeCollection.mockResolvedValue(LISTING);
  createUrlSource.mockImplementation(
    async (_ws: string, input: { url: string }) => ({
      source: { id: `id:${input.url}` },
    }),
  );
  listSourceStatuses.mockImplementation(
    async (_ws: string, input: { ids: string[] }) => ({
      items: input.ids.map((id) => ({
        id,
        status: {
          status: "failed",
          error: "Ingestion pages limit exceeded",
          errorCode: "PAGES_LIMIT_EXCEEDED",
        },
      })),
    }),
  );
  await mountOpen();

  await click(checkboxOf("aaaaaaaaaaa")!);
  await click(buttonNamed("Import 1 video")!);
  await flush(6);

  const row = document.body.querySelector('[data-youtube-video="aaaaaaaaaaa"]');
  assert.ok(
    row?.textContent?.includes(
      "Not imported: you have run out of ingestion pages.",
    ),
  );
  assert.ok(text().includes("0 added, 0 failed, 1 not imported."));
});
