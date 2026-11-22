import assert from "node:assert/strict";
import { test } from "node:test";
import { YouTubeSourceError } from "../src/youtube/errors";
import { createPublicFeedsCatalogProvider } from "../src/youtube/catalog/public-feeds";
import type { YouTubeCollection, YouTubeVideoInfo } from "../src/youtube/catalog/types";

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
      `<html><script>var ytInitialData = {"channelId":"${channelId}", "other":true};</script></html>`,
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

test("custom channel resolves via canonical link when channelId JSON is absent", async () => {
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

test("feed 404 throws YOUTUBE_CHANNEL_NOT_FOUND", async () => {
  const channelId = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const fetchFn = createFakeFetch({
    [feedUrl]: textResponse(404, "Not Found"),
  });
  const provider = createPublicFeedsCatalogProvider({ fetch: fetchFn });

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
