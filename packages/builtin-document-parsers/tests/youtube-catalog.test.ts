import assert from "node:assert/strict";
import { test } from "node:test";
import { YouTubeSourceError } from "../src/youtube/errors";
import { createPublicFeedsCatalogProvider } from "../src/youtube/catalog/public-feeds";
import type { YouTubeCollection, YouTubeVideoInfo } from "../src/youtube/catalog/types";
import { parseYouTubeUrl, type YouTubeUrlTarget } from "../src/youtube/url";

const VIDEO_ID = "jNQXAC9IVRw";
const OEMBED_URL = `https://www.youtube.com/oembed?url=${encodeURIComponent(
  `https://www.youtube.com/watch?v=${VIDEO_ID}`,
)}&format=json`;

type FetchMap = Record<string, () => Response>;

function createFakeFetch(map: FetchMap): typeof fetch {
  const seen: string[] = [];
  const fakeFetch = (async (input: unknown) => {
    const url =
      input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : (input as Request).url;
    seen.push(url);
    const factory = map[url];
    if (!factory) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    return factory();
  }) as typeof fetch & { seen: string[] };
  (fakeFetch as typeof fakeFetch & { seen: string[] }).seen = seen;
  return fakeFetch;
}

function jsonResponse(status: number, body: unknown): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

function textResponse(status: number, body: string, contentType = "text/html"): () => Response {
  return () => new Response(body, { status, headers: { "content-type": contentType } });
}

function atomFeed(options: {
  title: string;
  channelTitle?: string;
  entries: { videoId: string; title: string; published?: string; thumbnailUrl?: string }[];
}): string {
  const entries = options.entries
    .map(
      (e) => `
  <entry>
    <id>yt:video:${e.videoId}</id>
    <yt:videoId>${e.videoId}</yt:videoId>
    <title>${e.title}</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${e.videoId}"/>
    ${e.published ? `<published>${e.published}</published>` : ""}
    <media:group>
      <media:title>${e.title}</media:title>
      ${e.thumbnailUrl ? `<media:thumbnail url="${e.thumbnailUrl}" width="480" height="360"/>` : ""}
    </media:group>
  </entry>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>${options.title}</title>
  ${
    options.channelTitle
      ? `<author><name>${options.channelTitle}</name><uri>https://www.youtube.com/channel/UC000000000000000000000</uri></author>`
      : ""
  }
  ${entries}
</feed>`;
}

test("oembed 200 returns title and channel", async () => {
  const fetchFn = createFakeFetch({
    [OEMBED_URL]: jsonResponse(200, {
      title: "Me at the zoo",
      author_name: "jawed",
      author_url: "https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A",
      thumbnail_url: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
    }),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  const info: YouTubeVideoInfo = await provider.getVideo(VIDEO_ID);

  assert.deepEqual(info, {
    videoId: VIDEO_ID,
    title: "Me at the zoo",
    titleSource: "oembed",
    channelTitle: "jawed",
    channelUrl: "https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A",
    thumbnailUrl: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
  });
});

test("oembed 401 is not unavailable", async () => {
  const fetchFn = createFakeFetch({
    [OEMBED_URL]: textResponse(401, "Unauthorized"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  const info = await provider.getVideo(VIDEO_ID);

  assert.deepEqual(info, {
    videoId: VIDEO_ID,
    title: `YouTube video ${VIDEO_ID}`,
    titleSource: "fallback",
  });
});

test("oembed 403 is not unavailable (also fallback)", async () => {
  const fetchFn = createFakeFetch({
    [OEMBED_URL]: textResponse(403, "Forbidden"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  const info = await provider.getVideo(VIDEO_ID);

  assert.equal(info.titleSource, "fallback");
  assert.equal(info.title, `YouTube video ${VIDEO_ID}`);
});

test("oembed 404 throws YOUTUBE_VIDEO_UNAVAILABLE", async () => {
  const fetchFn = createFakeFetch({
    [OEMBED_URL]: textResponse(404, "Not Found"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  await assert.rejects(
    () => provider.getVideo(VIDEO_ID),
    (error: unknown) => {
      assert.ok(error instanceof YouTubeSourceError);
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, "YOUTUBE_VIDEO_UNAVAILABLE");
      return true;
    },
  );
});

test("oembed 400 also throws YOUTUBE_VIDEO_UNAVAILABLE", async () => {
  const fetchFn = createFakeFetch({
    [OEMBED_URL]: textResponse(400, "Bad Request"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  await assert.rejects(
    () => provider.getVideo(VIDEO_ID),
    (error: unknown) => {
      assert.ok(error instanceof YouTubeSourceError);
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, "YOUTUBE_VIDEO_UNAVAILABLE");
      return true;
    },
  );
});

test("oembed network error falls back rather than blocking", async () => {
  const fetchFn = (async () => {
    throw new TypeError("network error: fetch failed");
  }) as typeof fetch;
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  const info = await provider.getVideo(VIDEO_ID);

  assert.deepEqual(info, {
    videoId: VIDEO_ID,
    title: `YouTube video ${VIDEO_ID}`,
    titleSource: "fallback",
  });
});

test("playlist feed parses entries", async () => {
  const feedUrl = "https://www.youtube.com/feeds/videos.xml?playlist_id=PLxyz12345";
  const xml = atomFeed({
    title: "My Playlist",
    entries: [
      {
        videoId: "video000001",
        title: "First video",
        published: "2024-01-01T00:00:00+00:00",
        thumbnailUrl: "https://i.ytimg.com/vi/video000001/hqdefault.jpg",
      },
      {
        videoId: "video000002",
        title: "Second video",
        published: "2024-01-02T00:00:00+00:00",
        thumbnailUrl: "https://i.ytimg.com/vi/video000002/hqdefault.jpg",
      },
    ],
  });
  const fetchFn = createFakeFetch({
    [feedUrl]: textResponse(200, xml, "application/atom+xml"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  const collection: YouTubeCollection = await provider.listCollection({
    kind: "playlist",
    playlistId: "PLxyz12345",
  });

  assert.equal(collection.kind, "playlist");
  assert.equal(collection.title, "My Playlist");
  assert.deepEqual(collection.videos, [
    {
      videoId: "video000001",
      title: "First video",
      url: "https://www.youtube.com/watch?v=video000001",
      publishedAt: "2024-01-01T00:00:00+00:00",
      thumbnailUrl: "https://i.ytimg.com/vi/video000001/hqdefault.jpg",
    },
    {
      videoId: "video000002",
      title: "Second video",
      url: "https://www.youtube.com/watch?v=video000002",
      publishedAt: "2024-01-02T00:00:00+00:00",
      thumbnailUrl: "https://i.ytimg.com/vi/video000002/hqdefault.jpg",
    },
  ]);
});

test("handle resolves via channel page then channel feed", async () => {
  const handlePageUrl = "https://www.youtube.com/@GoogleDevelopers";
  const channelId = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const xml = atomFeed({
    title: "Google for Developers",
    channelTitle: "Google for Developers",
    entries: [{ videoId: "video000003", title: "Dev video" }],
  });
  const fetchFn = createFakeFetch({
    [handlePageUrl]: textResponse(
      200,
      `<html><script>var ytInitialData = {"metadata":{"channelMetadataRenderer":{"externalId":"${channelId}"}}};</script></html>`,
    ),
    [feedUrl]: textResponse(200, xml, "application/atom+xml"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  const collection = await provider.listCollection({
    kind: "channel",
    channel: { type: "handle", value: "GoogleDevelopers" },
  });

  assert.equal(collection.kind, "channel");
  assert.equal(collection.title, "Google for Developers");
  assert.equal(collection.channelTitle, "Google for Developers");
  assert.equal(collection.videos.length, 1);
  assert.equal(collection.videos[0]?.videoId, "video000003");
});

test("handle page resolves its own channel, not the first channelId on the page", async () => {
  // Real @handle pages carry other channels' ids (featured channels,
  // recommendations) in ytInitialData before the channel's own metadata.
  const handlePageUrl = "https://www.youtube.com/@3blue1brown";
  const ownChannelId = "UCYO_jab_esuFRV4b17AJtAw";
  const otherChannelId = "UC1_uAIS3r8Vu6JjXWvastJg";
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${ownChannelId}`;
  const fetchFn = createFakeFetch({
    [handlePageUrl]: textResponse(
      200,
      `<html><head><link rel="canonical" href="https://www.youtube.com/channel/${ownChannelId}"></head>` +
        `<script>var ytInitialData = {"channelId":"${otherChannelId}",` +
        `"metadata":{"channelMetadataRenderer":{"externalId":"${ownChannelId}"}}};</script></html>`,
    ),
    [feedUrl]: textResponse(200, atomFeed({ title: "3Blue1Brown", entries: [] }), "application/atom+xml"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  const collection = await provider.listCollection({
    kind: "channel",
    channel: { type: "handle", value: "3blue1brown" },
  });

  assert.equal(collection.title, "3Blue1Brown");
  assert.deepEqual((fetchFn as unknown as { seen: string[] }).seen, [handlePageUrl, feedUrl]);
});

test("handle page without a canonical link resolves via channelMetadataRenderer externalId", async () => {
  const handlePageUrl = "https://www.youtube.com/@GoogleDevelopers";
  const channelId = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const fetchFn = createFakeFetch({
    [handlePageUrl]: textResponse(
      200,
      `<script>var ytInitialData = {"channelId":"UC1_uAIS3r8Vu6JjXWvastJg",` +
        `"metadata":{"channelMetadataRenderer":{"title":"Devs","externalId":"${channelId}"}}};</script>`,
    ),
    [feedUrl]: textResponse(200, atomFeed({ title: "Devs", entries: [] }), "application/atom+xml"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  const collection = await provider.listCollection({
    kind: "channel",
    channel: { type: "handle", value: "GoogleDevelopers" },
  });

  assert.equal(collection.title, "Devs");
  assert.deepEqual((fetchFn as unknown as { seen: string[] }).seen, [handlePageUrl, feedUrl]);
});

test("handle page with only other channels' ids throws YOUTUBE_CHANNEL_NOT_FOUND", async () => {
  const handlePageUrl = "https://www.youtube.com/@OnlyOthers";
  const fetchFn = createFakeFetch({
    [handlePageUrl]: textResponse(200, `{"channelId":"UC1_uAIS3r8Vu6JjXWvastJg"}`),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  await assert.rejects(
    () =>
      provider.listCollection({
        kind: "channel",
        channel: { type: "handle", value: "OnlyOthers" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof YouTubeSourceError);
      assert.equal(error.code, "YOUTUBE_CHANNEL_NOT_FOUND");
      return true;
    },
  );
});

test("custom channel resolves via canonical link", async () => {
  const customPageUrl = "https://www.youtube.com/c/Google";
  const channelId = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const xml = atomFeed({ title: "Google", entries: [] });
  const fetchFn = createFakeFetch({
    [customPageUrl]: textResponse(
      200,
      `<html><head><link rel="canonical" href="https://www.youtube.com/channel/${channelId}"></head></html>`,
    ),
    [feedUrl]: textResponse(200, xml, "application/atom+xml"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  const collection = await provider.listCollection({
    kind: "channel",
    channel: { type: "custom", value: "Google" },
  });

  assert.equal(collection.title, "Google");
  assert.deepEqual(collection.videos, []);
});

test("handle page without channel id throws YOUTUBE_CHANNEL_NOT_FOUND", async () => {
  const handlePageUrl = "https://www.youtube.com/@NoChannelHere";
  const fetchFn = createFakeFetch({
    [handlePageUrl]: textResponse(200, "<html><body>nothing useful here</body></html>"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  await assert.rejects(
    () =>
      provider.listCollection({
        kind: "channel",
        channel: { type: "handle", value: "NoChannelHere" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof YouTubeSourceError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, "YOUTUBE_CHANNEL_NOT_FOUND");
      return true;
    },
  );
});

test("feed 500 throws YOUTUBE_LISTING_FAILED", async () => {
  const feedUrl = "https://www.youtube.com/feeds/videos.xml?playlist_id=PLxyz12345";
  const fetchFn = createFakeFetch({
    [feedUrl]: textResponse(500, "Internal Server Error"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  await assert.rejects(
    () => provider.listCollection({ kind: "playlist", playlistId: "PLxyz12345" }),
    (error: unknown) => {
      assert.ok(error instanceof YouTubeSourceError);
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, "YOUTUBE_LISTING_FAILED");
      return true;
    },
  );
});

/** Answers each call to `url` with the next response, in order. */
function createSequenceFetch(url: string, responses: (() => Response)[]): {
  fetch: typeof fetch;
  calls: () => number;
} {
  let calls = 0;
  const fetchFn = (async (input: unknown) => {
    const requested = typeof input === "string" ? input : String(input);
    assert.equal(requested, url);
    const factory = responses[calls];
    calls += 1;
    if (!factory) throw new Error(`Unexpected fetch #${calls} of ${url}`);
    return factory();
  }) as typeof fetch;
  return { fetch: fetchFn, calls: () => calls };
}

test("a feed 404 followed by a 200 is retried once and the listing succeeds", async () => {
  const feedUrl = "https://www.youtube.com/feeds/videos.xml?playlist_id=PLxyz12345";
  const xml = atomFeed({
    title: "Retried playlist",
    entries: [{ videoId: "aaaaaaaaaaa", title: "First" }],
  });
  const sequence = createSequenceFetch(feedUrl, [
    textResponse(404, "Not Found"),
    textResponse(200, xml, "application/atom+xml"),
  ]);
  const provider = createPublicFeedsCatalogProvider({
    fetch: sequence.fetch,
    feedRetryDelayMs: 0,
  });

  const collection = await provider.listCollection({
    kind: "playlist",
    playlistId: "PLxyz12345",
  });

  assert.equal(collection.title, "Retried playlist");
  assert.deepEqual(
    collection.videos.map((video) => video.videoId),
    ["aaaaaaaaaaa"],
  );
  assert.equal(sequence.calls(), 2);
});

test("the feed retry waits before fetching again", async () => {
  const feedUrl = "https://www.youtube.com/feeds/videos.xml?playlist_id=PLxyz12345";
  const xml = atomFeed({ title: "Late playlist", entries: [] });
  const sequence = createSequenceFetch(feedUrl, [
    textResponse(404, "Not Found"),
    textResponse(200, xml, "application/atom+xml"),
  ]);
  const provider = createPublicFeedsCatalogProvider({
    fetch: sequence.fetch,
    feedRetryDelayMs: 40,
  });

  const startedAt = performance.now();
  await provider.listCollection({ kind: "playlist", playlistId: "PLxyz12345" });

  assert.ok(performance.now() - startedAt >= 35);
  assert.equal(sequence.calls(), 2);
});

test("a playlist feed 404 twice throws YOUTUBE_PLAYLIST_NOT_FOUND after exactly two fetches", async () => {
  const feedUrl = "https://www.youtube.com/feeds/videos.xml?playlist_id=PLxyz12345";
  const sequence = createSequenceFetch(feedUrl, [
    textResponse(404, "Not Found"),
    textResponse(404, "Not Found"),
  ]);
  const provider = createPublicFeedsCatalogProvider({
    fetch: sequence.fetch,
    feedRetryDelayMs: 0,
  });

  await assert.rejects(
    () => provider.listCollection({ kind: "playlist", playlistId: "PLxyz12345" }),
    (error: unknown) => {
      assert.ok(error instanceof YouTubeSourceError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, "YOUTUBE_PLAYLIST_NOT_FOUND");
      return true;
    },
  );
  assert.equal(sequence.calls(), 2);
});

test("a channel feed 404 twice throws YOUTUBE_CHANNEL_NOT_FOUND after exactly two fetches", async () => {
  const channelId = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const sequence = createSequenceFetch(feedUrl, [
    textResponse(404, "Not Found"),
    textResponse(404, "Not Found"),
  ]);
  const provider = createPublicFeedsCatalogProvider({
    fetch: sequence.fetch,
    feedRetryDelayMs: 0,
  });

  await assert.rejects(
    () =>
      provider.listCollection({
        kind: "channel",
        channel: { type: "id", value: channelId },
      }),
    (error: unknown) => {
      assert.ok(error instanceof YouTubeSourceError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, "YOUTUBE_CHANNEL_NOT_FOUND");
      return true;
    },
  );
  assert.equal(sequence.calls(), 2);
});

test("a feed 500 is not retried", async () => {
  const feedUrl = "https://www.youtube.com/feeds/videos.xml?playlist_id=PLxyz12345";
  const sequence = createSequenceFetch(feedUrl, [textResponse(500, "Internal Server Error")]);
  const provider = createPublicFeedsCatalogProvider({
    fetch: sequence.fetch,
    feedRetryDelayMs: 0,
  });

  await assert.rejects(
    () => provider.listCollection({ kind: "playlist", playlistId: "PLxyz12345" }),
    (error: unknown) => {
      assert.ok(error instanceof YouTubeSourceError);
      assert.equal(error.code, "YOUTUBE_LISTING_FAILED");
      return true;
    },
  );
  assert.equal(sequence.calls(), 1);
});

test("channel id type resolves feed directly, without a page lookup", async () => {
  const channelId = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const xml = atomFeed({ title: "Direct channel", entries: [] });
  const fetchFn = createFakeFetch({
    [feedUrl]: textResponse(200, xml, "application/atom+xml"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  const collection = await provider.listCollection({
    kind: "channel",
    channel: { type: "id", value: channelId },
  });

  assert.equal(collection.title, "Direct channel");
});

test("user type resolves feed directly via user= param", async () => {
  const feedUrl = "https://www.youtube.com/feeds/videos.xml?user=Google";
  const xml = atomFeed({ title: "Google legacy", entries: [] });
  const fetchFn = createFakeFetch({
    [feedUrl]: textResponse(200, xml, "application/atom+xml"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  const collection = await provider.listCollection({
    kind: "channel",
    channel: { type: "user", value: "Google" },
  });

  assert.equal(collection.title, "Google legacy");
});

test("more than 15 entries are capped at 15", async () => {
  const feedUrl = "https://www.youtube.com/feeds/videos.xml?playlist_id=PLbig";
  const entries = Array.from({ length: 20 }, (_, i) => ({
    videoId: `video0000${String(i).padStart(2, "0")}`,
    title: `Video ${i}`,
  }));
  const xml = atomFeed({ title: "Big playlist", entries });
  const fetchFn = createFakeFetch({
    [feedUrl]: textResponse(200, xml, "application/atom+xml"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  const collection = await provider.listCollection({ kind: "playlist", playlistId: "PLbig" });

  assert.equal(collection.videos.length, 15);
  assert.equal(collection.videos[0]?.videoId, "video000000");
  assert.equal(collection.videos[14]?.videoId, "video000014");
});

test("provider id is public-feeds", () => {
  const provider = createPublicFeedsCatalogProvider({ fetch: (async () => {
    throw new Error("unused");
  }) as typeof fetch });
  assert.equal(provider.id, "public-feeds");
});

function withFinalUrl(factory: () => Response, url: string): () => Response {
  return () => {
    const response = factory();
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
}

test("a unicode handle's channel page URL is encoded exactly once", async () => {
  const target = parseYouTubeUrl(`https://www.youtube.com/@${encodeURIComponent("小明频道")}`);
  assert.deepEqual(target, { kind: "channel", channel: { type: "handle", value: "小明频道" } });
  const handlePageUrl = `https://www.youtube.com/@${encodeURIComponent("小明频道")}`;
  const channelId = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const fetchFn = createFakeFetch({
    [handlePageUrl]: textResponse(200, `{"externalId":"${channelId}"}`),
    [feedUrl]: textResponse(200, atomFeed({ title: "小明频道", entries: [] }), "application/atom+xml"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  const collection = await provider.listCollection(
    target as Extract<YouTubeUrlTarget, { kind: "channel" }>,
  );

  assert.equal(collection.title, "小明频道");
  assert.deepEqual((fetchFn as unknown as { seen: string[] }).seen, [handlePageUrl, feedUrl]);
});

test("a legacy user link with an encoded character is not double-encoded in the feed URL", async () => {
  const target = parseYouTubeUrl("https://www.youtube.com/user/Foo%20Bar");
  const feedUrl = "https://www.youtube.com/feeds/videos.xml?user=Foo%20Bar";
  const fetchFn = createFakeFetch({
    [feedUrl]: textResponse(200, atomFeed({ title: "Foo Bar", entries: [] }), "application/atom+xml"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  const collection = await provider.listCollection(
    target as Extract<YouTubeUrlTarget, { kind: "channel" }>,
  );

  assert.equal(collection.title, "Foo Bar");
});

test("a channel page that lands on a non-YouTube host (consent wall) is YOUTUBE_LISTING_FAILED", async () => {
  const handlePageUrl = "https://www.youtube.com/@GoogleDevelopers";
  const fetchFn = createFakeFetch({
    [handlePageUrl]: withFinalUrl(
      textResponse(200, "<html>Before you continue to YouTube</html>"),
      "https://consent.youtube.com/m?continue=https%3A%2F%2Fwww.youtube.com%2F%40GoogleDevelopers",
    ),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  await assert.rejects(
    () =>
      provider.listCollection({
        kind: "channel",
        channel: { type: "handle", value: "GoogleDevelopers" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof YouTubeSourceError);
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, "YOUTUBE_LISTING_FAILED");
      return true;
    },
  );
});

test("a channel page whose final URL stays on www.youtube.com still resolves", async () => {
  const handlePageUrl = "https://www.youtube.com/@GoogleDevelopers";
  const channelId = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const fetchFn = createFakeFetch({
    [handlePageUrl]: withFinalUrl(
      textResponse(200, `{"externalId":"${channelId}"}`),
      handlePageUrl,
    ),
    [feedUrl]: textResponse(200, atomFeed({ title: "Devs", entries: [] }), "application/atom+xml"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  const collection = await provider.listCollection({
    kind: "channel",
    channel: { type: "handle", value: "GoogleDevelopers" },
  });

  assert.equal(collection.title, "Devs");
});

test("feed text stays a string and HTML entities are decoded", async () => {
  const feedUrl = "https://www.youtube.com/feeds/videos.xml?playlist_id=PLxyz12345";
  const xml = atomFeed({
    title: "2024",
    entries: [{ videoId: "12345678901", title: "It&#39;s 1999" }],
  });
  const fetchFn = createFakeFetch({
    [feedUrl]: textResponse(200, xml, "application/atom+xml"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

  const collection = await provider.listCollection({ kind: "playlist", playlistId: "PLxyz12345" });

  assert.equal(collection.title, "2024");
  assert.equal(collection.videos[0]?.videoId, "12345678901");
  assert.equal(collection.videos[0]?.title, "It's 1999");
});

for (const xml of [
  "<feed></feed>",
  '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>',
]) {
  test(`an empty feed is an empty listing, not a failure (${xml.length} chars)`, async () => {
    const feedUrl = "https://www.youtube.com/feeds/videos.xml?playlist_id=PLempty123";
    const fetchFn = createFakeFetch({
      [feedUrl]: textResponse(200, xml, "application/atom+xml"),
    });
    const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

    const collection = await provider.listCollection({
      kind: "playlist",
      playlistId: "PLempty123",
    });

    assert.equal(collection.kind, "playlist");
    assert.deepEqual(collection.videos, []);
  });
}
