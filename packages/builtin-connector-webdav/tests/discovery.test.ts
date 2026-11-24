import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  ConnectorDiscoveryPage,
  ConnectorItem,
} from "@sourceweft/contracts";
import { createDavClient } from "../src/dav-client";
import { discoverWebDavPages, type DiscoveryLimits } from "../src/discovery";
import { buildFakeDav, type FakeDavSpec } from "./fake-dav";

const endpoint = new URL("https://dav.example.com/dav/");
const credential = { username: "alice", secret: "pw" };

type Warn = { message: string; meta?: Record<string, unknown> };

async function run(
  collections: FakeDavSpec["collections"],
  options: {
    roots: string[];
    status?: Record<string, number>;
    limits?: Partial<DiscoveryLimits>;
    rogueChildren?: Record<string, string[]>;
    omitSelf?: Record<string, boolean>;
    rawResponses?: Record<string, string[]>;
    now?: () => number;
    onPage?: () => void;
  },
): Promise<{
  pages: ConnectorDiscoveryPage[];
  warnings: Warn[];
  requests: string[];
}> {
  const warnings: Warn[] = [];
  const requests: string[] = [];
  const fakeFetch = buildFakeDav({
    endpoint,
    collections,
    status: options.status,
    rogueChildren: options.rogueChildren,
    omitSelf: options.omitSelf,
    rawResponses: options.rawResponses,
  });
  const recordingFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    requests.push(String(input));
    return fakeFetch(input, init);
  }) as typeof fetch;
  const client = createDavClient({
    fetch: recordingFetch,
    endpoint,
    credential,
  });
  const pages: ConnectorDiscoveryPage[] = [];
  for await (const page of discoverWebDavPages({
    client,
    endpoint,
    roots: options.roots,
    limits: options.limits,
    now: options.now,
    logger: { warn: (message, meta) => warnings.push({ message, meta }) },
  })) {
    pages.push(page);
    options.onPage?.();
  }
  return { pages, warnings, requests };
}

const itemsOf = (pages: ConnectorDiscoveryPage[]): ConnectorItem[] =>
  pages.flatMap((page) => page.items);
const idsOf = (pages: ConnectorDiscoveryPage[]): string[] =>
  itemsOf(pages).map((item) => item.externalId);
const finalPage = (pages: ConnectorDiscoveryPage[]): ConnectorDiscoveryPage =>
  pages[pages.length - 1]!;

test("walks the whole tree and emits every file, then a complete reconcile page", async () => {
  const { pages } = await run(
    {
      "/": {
        folders: ["Docs"],
        files: {
          "root.txt": { size: 3, etag: '"r"', contentType: "text/plain" },
        },
      },
      "/Docs/": {
        folders: ["Sub"],
        files: { "a.txt": { size: 5, etag: '"a"' } },
      },
      "/Docs/Sub/": { files: { "b.md": { size: 7, etag: '"b"' } } },
    },
    { roots: ["/"] },
  );
  assert.deepEqual(idsOf(pages).sort(), [
    "/Docs/Sub/b.md",
    "/Docs/a.txt",
    "/root.txt",
  ]);
  const last = finalPage(pages);
  assert.equal(last.complete, true);
  assert.equal(last.reconcileMissing, true);

  const root = itemsOf(pages).find((i) => i.externalId === "/root.txt")!;
  assert.equal(root.title, "root.txt");
  assert.equal(root.mimeType, "text/plain");
  assert.equal(root.sizeBytes, 3);
  // The etag is normalised (quotes stripped) for the content hash.
  assert.equal(root.contentHash, "r");
  assert.equal(root.externalUri, "https://dav.example.com/dav/root.txt");
  assert.equal(root.metadata.path, "/root.txt");
  // Only intermediate pages carry items; none of them reconciles.
  for (const page of pages.slice(0, -1)) {
    assert.equal(page.reconcileMissing, false);
    assert.equal(page.complete, false);
  }
});

test("the depth cap stops the descent and refuses to reconcile", async () => {
  const { pages } = await run(
    {
      "/": {
        folders: ["Docs"],
        files: { "root.txt": { size: 1, etag: '"r"' } },
      },
      "/Docs/": {
        folders: ["Sub"],
        files: { "a.txt": { size: 1, etag: '"a"' } },
      },
      "/Docs/Sub/": { files: { "b.md": { size: 1, etag: '"b"' } } },
    },
    { roots: ["/"], limits: { maxDepth: 1 } },
  );
  const ids = idsOf(pages);
  assert.ok(ids.includes("/root.txt"));
  assert.ok(ids.includes("/Docs/a.txt"));
  assert.ok(!ids.includes("/Docs/Sub/b.md"));
  // Incomplete but run-compatible: the run succeeds and archives nothing.
  assert.equal(finalPage(pages).complete, true);
  assert.equal(finalPage(pages).reconcileMissing, false);
});

test("the entry cap stops the walk and refuses to reconcile", async () => {
  const { pages } = await run(
    {
      "/": {
        folders: ["Docs"],
        files: {
          "a.txt": { size: 1, etag: '"a"' },
          "b.txt": { size: 1, etag: '"b"' },
          "c.txt": { size: 1, etag: '"c"' },
        },
      },
      "/Docs/": { files: { "d.txt": { size: 1, etag: '"d"' } } },
    },
    { roots: ["/"], limits: { maxEntries: 2 } },
  );
  assert.equal(finalPage(pages).complete, true);
  assert.equal(finalPage(pages).reconcileMissing, false);
  assert.ok(itemsOf(pages).length < 4);
});

test("a 403 on a subcollection marks the scan incomplete but still emits the rest", async () => {
  const { pages, warnings } = await run(
    {
      "/": {
        folders: ["Docs", "Secret"],
        files: { "root.txt": { size: 1, etag: '"r"' } },
      },
      "/Docs/": { files: { "a.txt": { size: 1, etag: '"a"' } } },
      "/Secret/": { files: { "secret.txt": { size: 1, etag: '"s"' } } },
    },
    { roots: ["/"], status: { "/Secret": 403 } },
  );
  const ids = idsOf(pages);
  assert.ok(ids.includes("/root.txt"));
  assert.ok(ids.includes("/Docs/a.txt"));
  assert.ok(!ids.includes("/Secret/secret.txt"));
  assert.equal(finalPage(pages).complete, true);
  assert.equal(finalPage(pages).reconcileMissing, false);
  assert.ok(warnings.some((w) => w.meta?.reason === "WEBDAV_FORBIDDEN"));
});

test("a 404 on a subcollection is tolerated the same way", async () => {
  const { pages } = await run(
    {
      "/": {
        folders: ["Gone"],
        files: { "root.txt": { size: 1, etag: '"r"' } },
      },
    },
    { roots: ["/"] },
  );
  // "/Gone/" is advertised as a child folder but absent from the tree (404).
  assert.ok(idsOf(pages).includes("/root.txt"));
  assert.equal(finalPage(pages).complete, true);
  assert.equal(finalPage(pages).reconcileMissing, false);
});

test("percent-encoded names are decoded for the id and re-encoded for the URL", async () => {
  const { pages } = await run(
    {
      "/": { folders: ["Folder A"] },
      "/Folder A/": { files: { "file%.txt": { size: 1, etag: '"f"' } } },
    },
    { roots: ["/"] },
  );
  const item = itemsOf(pages).find((i) => i.title === "file%.txt");
  assert.ok(item, "the encoded file is discovered");
  assert.equal(item!.externalId, "/Folder A/file%.txt");
  assert.equal(
    item!.externalUri,
    "https://dav.example.com/dav/Folder%20A/file%25.txt",
  );
});

test("a deleted file is absent from a later complete scan", async () => {
  const withFile: FakeDavSpec["collections"] = {
    "/": {
      files: {
        "a.txt": { size: 1, etag: '"a"' },
        "gone.txt": { size: 1, etag: '"g"' },
      },
    },
  };
  const withoutFile: FakeDavSpec["collections"] = {
    "/": { files: { "a.txt": { size: 1, etag: '"a"' } } },
  };
  const first = await run(withFile, { roots: ["/"] });
  assert.ok(idsOf(first.pages).includes("/gone.txt"));
  const second = await run(withoutFile, { roots: ["/"] });
  assert.ok(!idsOf(second.pages).includes("/gone.txt"));
  assert.equal(finalPage(second.pages).complete, true);
  assert.equal(finalPage(second.pages).reconcileMissing, true);
});

test("an unchanged etag yields an identical contentHash across runs", async () => {
  const tree: FakeDavSpec["collections"] = {
    "/": { files: { "a.txt": { size: 5, etag: '"same"' } } },
  };
  const a = await run(tree, { roots: ["/"] });
  const b = await run(tree, { roots: ["/"] });
  const hashA = itemsOf(a.pages)[0]!.contentHash;
  const hashB = itemsOf(b.pages)[0]!.contentHash;
  // Normalised: the surrounding quotes are stripped.
  assert.equal(hashA, "same");
  assert.equal(hashA, hashB);
});

test("without an etag the contentHash is a stable digest of size and last-modified", async () => {
  const tree: FakeDavSpec["collections"] = {
    "/": {
      files: {
        "a.txt": { size: 9, lastModified: "Sun, 22 Nov 2026 08:30:15 GMT" },
      },
    },
  };
  const expected = createHash("sha256")
    .update(`9|${new Date("Sun, 22 Nov 2026 08:30:15 GMT").toISOString()}`)
    .digest("hex");
  const a = await run(tree, { roots: ["/"] });
  const b = await run(tree, { roots: ["/"] });
  assert.equal(itemsOf(a.pages)[0]!.contentHash, expected);
  assert.equal(itemsOf(b.pages)[0]!.contentHash, expected);
});

test("multiple roots are each walked", async () => {
  const { pages } = await run(
    {
      "/": { folders: ["One", "Two", "Three"] },
      "/One/": { files: { "1.txt": { size: 1, etag: '"1"' } } },
      "/Two/": { files: { "2.txt": { size: 1, etag: '"2"' } } },
      "/Three/": { files: { "3.txt": { size: 1, etag: '"3"' } } },
    },
    { roots: ["/One/", "/Two/"] },
  );
  const ids = idsOf(pages);
  assert.deepEqual(ids.sort(), ["/One/1.txt", "/Two/2.txt"]);
  assert.equal(finalPage(pages).complete, true);
  assert.equal(finalPage(pages).reconcileMissing, true);
});

test("drops any server entry outside the listed collection and never requests it", async () => {
  const { pages, warnings, requests } = await run(
    {
      "/a/b/": {
        folders: ["child"],
        files: { "f.txt": { size: 1, etag: '"f"' } },
      },
      "/a/b/child/": { files: { "g.txt": { size: 1, etag: '"g"' } } },
    },
    {
      roots: ["/a/b/"],
      rogueChildren: {
        "/a/b/": [
          "/dav/a/", // the parent
          "/dav/a/bc/", // a /a/bc lookalike of root /a/b
          "/dav/a/sibling/", // a sibling collection
          "/dav/zzz/outside/", // outside the root entirely
          "/dav/a/b/%2E%2E/escape/", // encoded traversal
        ],
      },
    },
  );
  const ids = idsOf(pages);
  // Legitimate descendants are still discovered.
  assert.ok(ids.includes("/a/b/f.txt"));
  assert.ok(ids.includes("/a/b/child/g.txt"));
  // Not one rogue path is emitted as an item.
  for (const rogue of [
    "/a",
    "/a/bc",
    "/a/sibling",
    "/zzz/outside",
    "/a/b/../escape",
  ]) {
    assert.ok(!ids.includes(rogue), `${rogue} must not be an item`);
  }
  // The only collections ever requested are the root and its real child; no
  // rogue collection was queued, so none was fetched.
  assert.deepEqual(requests.sort(), [
    "https://dav.example.com/dav/a/b/",
    "https://dav.example.com/dav/a/b/child/",
  ]);
  // The scan still completes and reconciles: a sibling/parent echo is common.
  assert.equal(finalPage(pages).complete, true);
  assert.equal(finalPage(pages).reconcileMissing, true);
  // One fixed-message warning with only a count; the encoded-traversal href is
  // rejected by toExternalId earlier and so is not counted (4, not 5).
  const warn = warnings.find(
    (w) => w.message === "webdav_scan_out_of_scope_entries",
  );
  assert.ok(warn, "an out-of-scope warning is logged");
  assert.equal(warn!.meta?.count, 4);
});

// --- F2: etag normalisation and content hash --------------------------------

test("a quoted and an unquoted etag for the same bytes hash the same", async () => {
  const quoted = await run(
    { "/": { files: { "a.txt": { size: 5, etag: '"abc123"' } } } },
    { roots: ["/"] },
  );
  const unquoted = await run(
    { "/": { files: { "a.txt": { size: 5, etag: "abc123" } } } },
    { roots: ["/"] },
  );
  const h1 = itemsOf(quoted.pages)[0]!.contentHash;
  const h2 = itemsOf(unquoted.pages)[0]!.contentHash;
  assert.equal(h1, "abc123");
  assert.equal(h1, h2);
});

test("a weak and a -gzip-suffixed etag normalise to the strong bare tag", async () => {
  const weak = await run(
    { "/": { files: { "a.txt": { size: 5, etag: 'W/"abc123"' } } } },
    { roots: ["/"] },
  );
  const gzip = await run(
    { "/": { files: { "a.txt": { size: 5, etag: '"abc123-gzip"' } } } },
    { roots: ["/"] },
  );
  assert.equal(itemsOf(weak.pages)[0]!.contentHash, "abc123");
  assert.equal(itemsOf(gzip.pages)[0]!.contentHash, "abc123");
});

test("with no etag, size or last-modified the content hash is null", async () => {
  const { pages } = await run(
    { "/": { files: { "a.txt": {} } } },
    { roots: ["/"] },
  );
  const item = itemsOf(pages)[0]!;
  assert.equal(item.contentHash, null);
});

// --- F3: an incomplete listing is not treated as authoritative --------------

test("a 207 that omits the collection's own entry is incomplete and archives nothing", async () => {
  const { pages, warnings } = await run(
    {
      "/": {
        folders: ["Docs"],
        files: { "root.txt": { size: 1, etag: '"r"' } },
      },
      "/Docs/": { files: { "a.txt": { size: 1, etag: '"a"' } } },
    },
    { roots: ["/"], omitSelf: { "/": true } },
  );
  // Files still surface; nothing is reconciled away.
  assert.ok(idsOf(pages).includes("/root.txt"));
  assert.ok(idsOf(pages).includes("/Docs/a.txt"));
  assert.equal(finalPage(pages).complete, true);
  assert.equal(finalPage(pages).reconcileMissing, false);
  assert.ok(
    warnings.some((w) => w.message === "webdav_scan_self_missing"),
    "a self-missing warning is logged",
  );
});

test("a per-resource error inside a listing marks the scan incomplete", async () => {
  const { pages, warnings } = await run(
    { "/": { files: { "ok.txt": { size: 1, etag: '"o"' } } } },
    {
      roots: ["/"],
      rawResponses: {
        "/": [
          "<d:response><d:href>/dav/locked.txt</d:href>" +
            "<d:status>HTTP/1.1 423 Locked</d:status></d:response>",
        ],
      },
    },
  );
  assert.ok(idsOf(pages).includes("/ok.txt"));
  assert.equal(finalPage(pages).complete, true);
  assert.equal(finalPage(pages).reconcileMissing, false);
  const warn = warnings.find(
    (w) => w.message === "webdav_scan_dropped_responses",
  );
  assert.ok(warn, "a dropped-response warning is logged");
  assert.equal(warn!.meta?.count, 1);
});

test("a listing whose only children fall out of scope is incomplete", async () => {
  const { pages, warnings } = await run(
    { "/Docs/": {} },
    {
      roots: ["/Docs/"],
      // The server echoes a lower-cased child that is not a descendant of
      // the requested /Docs/ (a case mismatch), and nothing in scope.
      rogueChildren: { "/Docs/": ["/dav/docs/a.txt"] },
    },
  );
  assert.equal(finalPage(pages).complete, true);
  assert.equal(finalPage(pages).reconcileMissing, false);
  assert.ok(
    warnings.some((w) => w.message === "webdav_scan_unmatched_listings"),
    "an unmatched-listing warning is logged",
  );
});

test("an empty collection is still a clean, reconcilable scan", async () => {
  const { pages } = await run({ "/": {} }, { roots: ["/"] });
  assert.equal(finalPage(pages).complete, true);
  assert.equal(finalPage(pages).reconcileMissing, true);
});

// --- F4: the scan time budget counts only PROPFIND time ---------------------

test("the scan budget trips on accumulated PROPFIND time, cutting the walk", async () => {
  // Each PROPFIND advances the clock by 200ms; the budget is 300ms, so the
  // walk stops after the first couple of collections.
  const clock = { t: 0 };
  const endpointForClock = endpoint;
  const collections: FakeDavSpec["collections"] = {
    "/": { folders: ["b"], files: { "a.txt": { size: 1, etag: '"a"' } } },
    "/b/": { folders: ["c"], files: { "b.txt": { size: 1, etag: '"b"' } } },
    "/b/c/": { files: { "c.txt": { size: 1, etag: '"c"' } } },
  };
  const base = buildFakeDav({ endpoint: endpointForClock, collections });
  const slowFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    clock.t += 200; // time spent inside the request
    return base(input, init);
  }) as typeof fetch;
  const client = createDavClient({
    fetch: slowFetch,
    endpoint: endpointForClock,
    credential,
  });
  const pages: ConnectorDiscoveryPage[] = [];
  for await (const page of discoverWebDavPages({
    client,
    endpoint: endpointForClock,
    roots: ["/"],
    limits: { scanTimeoutMs: 300 },
    now: () => clock.t,
  })) {
    pages.push(page);
  }
  const last = pages[pages.length - 1]!;
  assert.equal(last.complete, true);
  assert.equal(last.reconcileMissing, false);
  assert.ok(!idsOf(pages).includes("/b/c/c.txt"), "the deep file is cut off");
});

test("time spent between pulls (extract/embed) does not count against the budget", async () => {
  // PROPFIND is instant; the consumer burns ten minutes between pages. With a
  // wall-clock budget that would trip, the scan still completes because only
  // request time counts.
  const clock = { t: 0 };
  const { pages } = await run(
    {
      "/": { folders: ["b"], files: { "a.txt": { size: 1, etag: '"a"' } } },
      "/b/": { files: { "b.txt": { size: 1, etag: '"b"' } } },
    },
    {
      roots: ["/"],
      limits: { scanTimeoutMs: 10 * 60_000 },
      now: () => clock.t,
      onPage: () => {
        clock.t += 20 * 60_000; // far past the budget, but not request time
      },
    },
  );
  assert.ok(idsOf(pages).includes("/a.txt"));
  assert.ok(idsOf(pages).includes("/b/b.txt"));
  assert.equal(finalPage(pages).complete, true);
  assert.equal(finalPage(pages).reconcileMissing, true);
});
