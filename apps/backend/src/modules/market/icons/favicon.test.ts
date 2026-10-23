import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  FAVICON_MAX_BYTES,
  faviconServiceUrl,
  fetchFavicon,
  imageExtension,
  imageMediaType,
} from "./favicon";

const PNG = Buffer.alloc(2048, 1);

function image(
  bytes: Buffer,
  contentType = "image/png",
  status = 200,
): Response {
  return new Response(new Uint8Array(bytes), {
    status,
    headers: { "content-type": contentType },
  });
}

/** A fetch answering Google and DuckDuckGo by host, recording the URLs. */
function services(answers: {
  google: () => Response;
  duckduckgo?: () => Response;
}) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith("https://www.google.com/")) return answers.google();
    if (url.startsWith("https://icons.duckduckgo.com/")) {
      if (!answers.duckduckgo) throw new Error("unexpected DuckDuckGo call");
      return answers.duckduckgo();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

test("service URLs name the namespace domain only, encoded", () => {
  assert.equal(
    faviconServiceUrl("google", "notion.com"),
    "https://www.google.com/s2/favicons?domain=notion.com&sz=128",
  );
  assert.equal(
    faviconServiceUrl("duckduckgo", "notion.com"),
    "https://icons.duckduckgo.com/ip3/notion.com.ico",
  );
  assert.ok(faviconServiceUrl("google", "a/b?c").includes("a%2Fb%3Fc"));
});

test("a Google hit is taken as is: bytes, media type, service", async () => {
  const { fetch, calls } = services({
    google: () => image(PNG, "image/png; charset=binary"),
  });
  const result = await fetchFavicon("notion.com", fetch);
  assert.equal(result.status, "hit");
  if (result.status !== "hit") return;
  assert.equal(result.service, "google");
  assert.equal(result.contentType, "image/png");
  assert.equal(result.bytes.byteLength, 2048);
  assert.deepEqual(calls, [faviconServiceUrl("google", "notion.com")]);
});

test("a Google 404 falls through to DuckDuckGo; a DuckDuckGo 404 is a miss even with a body", async () => {
  const ico = Buffer.alloc(32_000, 2);
  const hit = services({
    google: () => image(Buffer.alloc(700), "image/png", 404),
    duckduckgo: () => image(ico, "image/vnd.microsoft.icon"),
  });
  const result = await fetchFavicon("notion.com", hit.fetch);
  assert.equal(result.status, "hit");
  if (result.status === "hit") {
    assert.equal(result.service, "duckduckgo");
    assert.equal(result.contentType, "image/vnd.microsoft.icon");
  }
  assert.equal(hit.calls.length, 2);

  // DuckDuckGo answers an unknown domain with 404 and a 1.4 KB placeholder PNG.
  const miss = services({
    google: () => image(Buffer.alloc(700), "image/png", 404),
    duckduckgo: () => image(Buffer.alloc(1478), "image/png", 404),
  });
  assert.deepEqual(await fetchFavicon("unknown.test", miss.fetch), {
    status: "miss",
    reason: "not-found",
  });
});

test("a body under 1 KiB is a miss (the services' generic defaults)", async () => {
  const { fetch } = services({ google: () => image(Buffer.alloc(908)) });
  assert.deepEqual(await fetchFavicon("workers.dev", fetch), {
    status: "miss",
    reason: "too-small",
  });
});

test("a non-image content type is a miss and its body is not kept", async () => {
  const { fetch } = services({
    google: () =>
      new Response("<html>not an icon</html>".repeat(100), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  });
  assert.deepEqual(await fetchFavicon("acme.test", fetch), {
    status: "miss",
    reason: "not-an-image",
  });
  // SVG could carry scripts when opened from our asset host: not accepted.
  const svg = services({
    google: () => image(Buffer.alloc(4096), "image/svg+xml"),
  });
  assert.deepEqual(await fetchFavicon("acme.test", svg.fetch), {
    status: "miss",
    reason: "not-an-image",
  });
});

test("a body over the cap is a miss", async () => {
  const { fetch } = services({
    google: () => image(Buffer.alloc(FAVICON_MAX_BYTES + 1)),
  });
  assert.deepEqual(await fetchFavicon("acme.test", fetch), {
    status: "miss",
    reason: "too-large",
  });
});

test("a network error or an error status other than 404 is thrown, not cached", async () => {
  const failing = services({
    google: () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    fetchFavicon("acme.test", failing.fetch),
    /fetch failed/,
  );
  const rateLimited = services({
    google: () => new Response("slow down", { status: 429 }),
  });
  await assert.rejects(fetchFavicon("acme.test", rateLimited.fetch), /429/);
  // A DuckDuckGo 5xx after a Google 404 is thrown too.
  const ddgDown = services({
    google: () => image(Buffer.alloc(700), "image/png", 404),
    duckduckgo: () => new Response("", { status: 503 }),
  });
  await assert.rejects(fetchFavicon("acme.test", ddgDown.fetch), /503/);
});

test("media types and extensions", () => {
  assert.equal(imageMediaType("image/PNG"), "image/png");
  assert.equal(imageMediaType("image/x-icon"), "image/x-icon");
  assert.equal(imageMediaType("image/svg+xml"), undefined);
  assert.equal(imageMediaType(null), undefined);
  assert.equal(imageExtension("image/vnd.microsoft.icon"), "ico");
  assert.equal(imageExtension("image/jpeg"), "jpg");
});
