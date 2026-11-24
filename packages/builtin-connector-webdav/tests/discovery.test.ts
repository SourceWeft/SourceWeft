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
  },
): Promise<{ pages: ConnectorDiscoveryPage[]; warnings: Warn[] }> {
  const warnings: Warn[] = [];
  const client = createDavClient({
    fetch: buildFakeDav({ endpoint, collections, status: options.status }),
    endpoint,
    credential,
  });
  const pages: ConnectorDiscoveryPage[] = [];
  for await (const page of discoverWebDavPages({
    client,
    endpoint,
    roots: options.roots,
    limits: options.limits,
    logger: { warn: (message, meta) => warnings.push({ message, meta }) },
  })) {
    pages.push(page);
  }
  return { pages, warnings };
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
  assert.equal(root.contentHash, '"r"');
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
  assert.equal(finalPage(pages).complete, false);
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
  assert.equal(finalPage(pages).complete, false);
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
  assert.equal(finalPage(pages).complete, false);
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
  assert.equal(finalPage(pages).complete, false);
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
  assert.equal(hashA, '"same"');
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
