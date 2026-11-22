import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildCandidates,
  interleaveHits,
  normalizeCandidateUrl,
} from "./candidates";

test("a URL is normalized: no fragment, tracking parameters or trailing slash", () => {
  assert.equal(
    normalizeCandidateUrl(
      "https://Example.com/post/?utm_source=x&id=7&fbclid=y#top",
    ),
    "https://example.com/post?id=7",
  );
  assert.equal(
    normalizeCandidateUrl("https://example.com/"),
    "https://example.com/",
  );
});

test("non-public and non-web URLs are rejected", () => {
  for (const url of [
    "http://localhost:3000/a",
    "http://10.0.0.5/a",
    "http://192.168.1.2/a",
    "ftp://example.com/a",
    "https://user:pw@example.com/a",
    "not a url",
  ]) {
    assert.equal(normalizeCandidateUrl(url), null, url);
  }
});

test("candidates are de-duplicated by normalized URL, keeping the first title", () => {
  const candidates = buildCandidates({
    hits: [
      {
        title: "First",
        url: "https://example.com/a/?utm_medium=x",
        snippet: "s1",
      },
      { title: "Second", url: "https://example.com/a#frag", snippet: "s2" },
      { title: "Other", url: "https://other.org/b", snippet: "s3" },
    ],
  });
  assert.deepEqual(
    candidates.map((item) => [item.url, item.title]),
    [
      ["https://example.com/a", "First"],
      ["https://other.org/b", "Other"],
    ],
  );
});

test("private hosts are left out", () => {
  const candidates = buildCandidates({
    hits: [
      { url: "http://127.0.0.1/x" },
      { url: "https://example.com/ok" },
    ],
  });
  assert.deepEqual(
    candidates.map((item) => item.url),
    ["https://example.com/ok"],
  );
});

test("discovery keeps youtube video candidates and drops playlists", () => {
  const candidates = buildCandidates({
    hits: [
      {
        title: "A talk",
        url: "https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLabc1234567890&index=2",
      },
      // Same video via the short host: de-duplicated against the first.
      { url: "https://youtu.be/aaaaaaaaaaa" },
      { url: "https://www.youtube.com/playlist?list=PLabc1234567890xyz" },
      { url: "https://www.youtube.com/@somechannel" },
      { url: "https://example.com/ok" },
    ],
  });
  assert.deepEqual(
    candidates.map((item) => item.url),
    ["https://www.youtube.com/watch?v=aaaaaaaaaaa", "https://example.com/ok"],
  );
  assert.equal(candidates[0]?.title, "A talk");
  assert.equal(candidates[0]?.domain, "youtube.com");
});

test("a missing title falls back to the domain and long text is cut", () => {
  const [candidate] = buildCandidates({
    hits: [{ url: "https://www.example.com/p", snippet: "word ".repeat(200) }],
  });
  assert.equal(candidate?.title, "example.com");
  assert.equal(candidate?.domain, "example.com");
  assert.ok((candidate?.snippet.length ?? 0) <= 301);
  assert.ok(candidate?.snippet.endsWith("…"));
});

test("the list is capped", () => {
  const hits = Array.from({ length: 30 }, (_, index) => ({
    url: `https://example.com/${index}`,
  }));
  assert.equal(buildCandidates({ hits }).length, 20);
  assert.equal(buildCandidates({ hits, limit: 3 }).length, 3);
});

test("every query contributes before any contributes twice", () => {
  const merged = interleaveHits([
    [{ url: "https://a.com/1" }, { url: "https://a.com/2" }],
    [{ url: "https://b.com/1" }],
    [{ url: "https://c.com/1" }, { url: "https://c.com/2" }],
  ]);
  assert.deepEqual(
    merged.map((hit) => hit.url),
    [
      "https://a.com/1",
      "https://b.com/1",
      "https://c.com/1",
      "https://a.com/2",
      "https://c.com/2",
    ],
  );
});
