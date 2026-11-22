import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalVideoUrl,
  isUnrecognisedYouTubeUrl,
  isYouTubeHost,
  parseYouTubeUrl,
  timestampUrl,
  type YouTubeUrlTarget,
} from "../src/youtube/url";

// Table of input -> expected parse result. One real, stable video id
// (jNQXAC9IVRw, "Me at the zoo") and one placeholder id/playlist id/channel
// id are reused across cases, matching the shapes in the task brief.
const cases: { name: string; input: string; expected: YouTubeUrlTarget | null }[] = [
  {
    name: "standard watch url",
    input: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    expected: { kind: "video", videoId: "jNQXAC9IVRw" },
  },
  {
    name: "youtu.be short link with tracking param",
    input: "https://youtu.be/jNQXAC9IVRw?si=x",
    expected: { kind: "video", videoId: "jNQXAC9IVRw" },
  },
  {
    name: "shorts url",
    input: "https://www.youtube.com/shorts/jNQXAC9IVRw",
    expected: { kind: "video", videoId: "jNQXAC9IVRw" },
  },
  {
    name: "live url",
    input: "https://www.youtube.com/live/jNQXAC9IVRw",
    expected: { kind: "video", videoId: "jNQXAC9IVRw" },
  },
  {
    name: "embed url",
    input: "https://www.youtube.com/embed/jNQXAC9IVRw",
    expected: { kind: "video", videoId: "jNQXAC9IVRw" },
  },
  {
    name: "youtube-nocookie embed url",
    input: "https://www.youtube-nocookie.com/embed/jNQXAC9IVRw",
    expected: { kind: "video", videoId: "jNQXAC9IVRw" },
  },
  {
    name: "mobile host watch url",
    input: "https://m.youtube.com/watch?v=jNQXAC9IVRw",
    expected: { kind: "video", videoId: "jNQXAC9IVRw" },
  },
  {
    name: "watch url with list and index is still a video",
    input: "https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLxyz12345&index=3",
    expected: { kind: "video", videoId: "jNQXAC9IVRw" },
  },
  {
    name: "playlist url",
    input: "https://www.youtube.com/playlist?list=PLxyz12345",
    expected: { kind: "playlist", playlistId: "PLxyz12345" },
  },
  {
    name: "channel handle url",
    input: "https://www.youtube.com/@GoogleDevelopers",
    expected: { kind: "channel", channel: { type: "handle", value: "GoogleDevelopers" } },
  },
  {
    name: "channel handle url with /videos tab",
    input: "https://www.youtube.com/@GoogleDevelopers/videos",
    expected: { kind: "channel", channel: { type: "handle", value: "GoogleDevelopers" } },
  },
  {
    name: "channel id url",
    input: "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
    expected: { kind: "channel", channel: { type: "id", value: "UC_x5XG1OV2P6uZZ5FSM9Ttw" } },
  },
  {
    name: "legacy user url",
    input: "https://www.youtube.com/user/Google",
    expected: { kind: "channel", channel: { type: "user", value: "Google" } },
  },
  {
    name: "legacy custom url",
    input: "https://www.youtube.com/c/Google",
    expected: { kind: "channel", channel: { type: "custom", value: "Google" } },
  },
  {
    name: "unicode channel handle url",
    input: "https://www.youtube.com/@小明频道",
    expected: { kind: "channel", channel: { type: "handle", value: "小明频道" } },
  },
  {
    name: "percent-encoded unicode channel handle url",
    input: `https://www.youtube.com/@${encodeURIComponent("小明频道")}/videos`,
    expected: { kind: "channel", channel: { type: "handle", value: "小明频道" } },
  },
  {
    name: "handle with a malformed percent escape",
    input: "https://www.youtube.com/@abc%E5%",
    expected: null,
  },
  {
    name: "legacy user url with an encoded space is decoded once",
    input: "https://www.youtube.com/user/Foo%20Bar",
    expected: { kind: "channel", channel: { type: "user", value: "Foo Bar" } },
  },
  {
    name: "legacy custom url with unicode is decoded",
    input: "https://www.youtube.com/c/小明",
    expected: { kind: "channel", channel: { type: "custom", value: "小明" } },
  },
  {
    name: "embedded playlist url",
    input: "https://www.youtube.com/embed/videoseries?list=PLxyz12345",
    expected: { kind: "playlist", playlistId: "PLxyz12345" },
  },
  {
    name: "legacy /v/ video url",
    input: "https://www.youtube.com/v/jNQXAC9IVRw?version=3",
    expected: { kind: "video", videoId: "jNQXAC9IVRw" },
  },
  {
    name: "non-YouTube host with a watch-shaped path",
    input: "https://example.com/watch?v=jNQXAC9IVRw",
    expected: null,
  },
  {
    name: "YouTube host but an unrecognised path",
    input: "youtube.com/feed/history",
    expected: null,
  },
];

for (const { name, input, expected } of cases) {
  test(`parseYouTubeUrl: ${name}`, () => {
    assert.deepEqual(parseYouTubeUrl(input), expected);
  });
}

test("isUnrecognisedYouTubeUrl: non-YouTube host is false", () => {
  assert.equal(isUnrecognisedYouTubeUrl("https://example.com/watch?v=jNQXAC9IVRw"), false);
});

test("isUnrecognisedYouTubeUrl: YouTube host with unrecognised path is true", () => {
  assert.equal(isUnrecognisedYouTubeUrl("youtube.com/feed/history"), true);
});

test("isUnrecognisedYouTubeUrl: YouTube host with a recognised path is false", () => {
  assert.equal(
    isUnrecognisedYouTubeUrl("https://www.youtube.com/watch?v=jNQXAC9IVRw"),
    false,
  );
});

test("parseYouTubeUrl: never throws on garbage input", () => {
  assert.equal(parseYouTubeUrl("not a url at all :: /// ???"), null);
  assert.equal(parseYouTubeUrl(""), null);
});

test("isYouTubeHost: recognises every documented host", () => {
  for (const host of [
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "youtu.be",
  ]) {
    assert.equal(isYouTubeHost(host), true);
  }
});

test("isYouTubeHost: rejects other hosts", () => {
  assert.equal(isYouTubeHost("example.com"), false);
  assert.equal(isYouTubeHost("notyoutube.com"), false);
});

test("canonicalVideoUrl: builds the canonical watch URL", () => {
  assert.equal(
    canonicalVideoUrl("jNQXAC9IVRw"),
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  );
});

test("timestampUrl: appends a floored integer seconds timestamp", () => {
  assert.equal(
    timestampUrl("jNQXAC9IVRw", 754.9),
    "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=754s",
  );
});
