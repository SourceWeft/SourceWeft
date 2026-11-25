import assert from "node:assert/strict";
import test from "node:test";
import {
  isConnectorExtractedFile,
  type ConnectorActionInput,
  type ConnectorDiscoverInput,
  type ConnectorDiscoveryPage,
  type ConnectorItem,
  type ConnectorSelectionBrowseResult,
  type ConnectorSelectionDescribeResult,
} from "@sourceweft/contracts";
import { createWebdavAdapter } from "../src/adapter";
import { nextcloudFlavor } from "../src/nextcloud/flavor";
import { buildFakeDav, fakeHarness, type FakeDavSpec } from "./fake-dav";

const SERVER = "https://cloud.example.com";
const ENDPOINT = "https://cloud.example.com/remote.php/dav/files/alice/";
const ACCESS_TOKEN = JSON.stringify({ username: "alice", secret: "app-pw-Ω" });

function adapterFor(
  collections: FakeDavSpec["collections"],
  options: {
    status?: Record<string, number>;
    endpoint?: string;
    server?: string;
  } = {},
) {
  const endpoint = options.endpoint ?? ENDPOINT;
  const fetchImpl = buildFakeDav({
    endpoint: new URL(endpoint),
    collections,
    status: options.status,
  });
  const harness = fakeHarness(fetchImpl);
  const adapter = createWebdavAdapter({
    credentialedFetch: harness.credentialedFetch,
    logger: harness.logger,
    flavor: nextcloudFlavor,
  });
  return { adapter, harness, endpoint, server: options.server ?? SERVER };
}

function discoverInput(
  roots: string[],
  over: { endpoint?: string; server?: string } = {},
): ConnectorDiscoverInput {
  return {
    teamId: "t",
    workspaceId: "w",
    connectorId: "c1",
    connectorType: "nextcloud",
    config: {
      server: over.server ?? SERVER,
      endpoint: over.endpoint ?? ENDPOINT,
      userId: "alice",
      roots,
    },
    accessToken: ACCESS_TOKEN,
  };
}

function actionInput(
  actionType: string,
  request: Record<string, unknown>,
): ConnectorActionInput {
  return {
    teamId: "t",
    workspaceId: "w",
    connectorId: "c1",
    connectorType: "nextcloud",
    actionType,
    request,
    config: {
      server: SERVER,
      endpoint: ENDPOINT,
      userId: "alice",
      roots: ["/"],
    },
    accessToken: ACCESS_TOKEN,
    idempotencyKey: "k",
  };
}

async function collect(
  iterable: AsyncIterable<ConnectorDiscoveryPage>,
): Promise<ConnectorDiscoveryPage[]> {
  const pages: ConnectorDiscoveryPage[] = [];
  for await (const page of iterable) pages.push(page);
  return pages;
}

async function discoverItems(
  adapter: ReturnType<typeof adapterFor>["adapter"],
  input: ConnectorDiscoverInput,
): Promise<ConnectorItem[]> {
  const items: ConnectorItem[] = [];
  for await (const item of adapter.discover(input)) items.push(item);
  return items;
}

// --- discovery identity -----------------------------------------------------

test("discovery emits nc:<fileid> ids, the canonical link and nextcloud metadata", async () => {
  const { adapter } = adapterFor({
    "/": {
      self: { fileId: "10", permissions: "RGDNVCK" },
      files: {
        "report.pdf": {
          size: 42,
          etag: '"a1"',
          contentType: "application/pdf",
          fileId: "555",
          permissions: "RGDNVW",
          ownerId: "alice",
        },
      },
    },
  });
  const items = await discoverItems(adapter, discoverInput(["/"]));
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.externalId, "nc:555");
  assert.equal(item.externalUri, "https://cloud.example.com/index.php/f/555");
  assert.equal(item.title, "report.pdf");
  assert.deepEqual(item.metadata, {
    path: "/report.pdf",
    fileId: "555",
    permissions: "RGDNVW",
    ownerId: "alice",
    shared: false,
    etag: '"a1"',
    contentType: "application/pdf",
    size: 42,
  });
});

test("a rename or move keeps the same externalId and a new metadata.path (no delete+add)", async () => {
  const before = adapterFor({
    "/": {
      self: { fileId: "10" },
      files: {
        "old.pdf": {
          size: 1,
          etag: '"x"',
          fileId: "900",
          permissions: "RGDNVW",
        },
      },
    },
  });
  const after = adapterFor({
    "/": {
      self: { fileId: "10" },
      folders: ["Sub"],
    },
    "/Sub/": {
      files: {
        "new.pdf": {
          size: 1,
          etag: '"x"',
          fileId: "900",
          permissions: "RGDNVW",
        },
      },
    },
  });
  const [a] = await discoverItems(before.adapter, discoverInput(["/"]));
  const moved = await discoverItems(after.adapter, discoverInput(["/"]));
  const b = moved.find((i) => i.externalId === "nc:900");
  assert.equal(a!.externalId, "nc:900");
  assert.equal(a!.metadata.path, "/old.pdf");
  assert.ok(b);
  assert.equal(b.metadata.path, "/Sub/new.pdf");
});

test("a file without the G read flag is skipped but the scan still reconciles", async () => {
  const { adapter } = adapterFor({
    "/": {
      self: { fileId: "10" },
      files: {
        "readable.txt": {
          size: 1,
          etag: '"r"',
          fileId: "1",
          permissions: "RGDNVW",
        },
        "secret.txt": {
          size: 1,
          etag: '"s"',
          fileId: "2",
          permissions: "RDNVW",
        },
      },
    },
  });
  const pages = await collect(adapter.discoverPages!(discoverInput(["/"])));
  const ids = pages.flatMap((p) => p.items).map((i) => i.externalId);
  assert.deepEqual(ids, ["nc:1"]);
  const last = pages[pages.length - 1]!;
  assert.equal(last.complete, true);
  assert.equal(last.reconcileMissing, true);
});

test("a shared file (permission flag S) is flagged in metadata", async () => {
  const { adapter } = adapterFor({
    "/": {
      self: { fileId: "10" },
      files: {
        "shared.txt": {
          size: 1,
          etag: '"h"',
          fileId: "3",
          permissions: "RGDNVWS",
        },
      },
    },
  });
  const items = await discoverItems(adapter, discoverInput(["/"]));
  assert.equal(items[0]!.metadata.shared, true);
});

// --- readiness --------------------------------------------------------------

test("readiness fails with not_nextcloud when the server returns no oc:fileid", async () => {
  const { adapter } = adapterFor({ "/": {} });
  const result = await adapter.checkSyncReadiness!(discoverInput(["/"]));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "not_nextcloud");
  assert.equal(typeof result.message, "string");
});

test("readiness passes when the server returns an oc:fileid", async () => {
  const { adapter } = adapterFor({ "/": { self: { fileId: "10" } } });
  const result = await adapter.checkSyncReadiness!(discoverInput(["/"]));
  assert.equal(result.ready, true);
});

// --- extract ----------------------------------------------------------------

test("extract downloads the file using metadata.path, not the nc:<fileid> id", async () => {
  const { adapter } = adapterFor({
    "/": {
      self: { fileId: "10" },
      files: {
        "notes.txt": {
          size: 5,
          etag: '"n"',
          contentType: "text/plain",
          body: "hello",
          fileId: "42",
          permissions: "RGDNVW",
        },
      },
    },
  });
  const [item] = await discoverItems(adapter, discoverInput(["/"]));
  assert.equal(item!.externalId, "nc:42");
  const extracted = await adapter.extract({
    ...discoverInput(["/"]),
    item: item!,
  });
  assert.ok(isConnectorExtractedFile(extracted));
  assert.equal(extracted.file.fileName, "notes.txt");
  const bytes = await extracted.file.download({ maxBytes: 1000 });
  assert.equal(Buffer.from(bytes).toString("utf8"), "hello");
});

// --- selection actions ------------------------------------------------------

test("browse and describe dispatch under the nextcloud.* action prefix", async () => {
  const { adapter } = adapterFor({
    "/": { self: { fileId: "10" }, folders: ["Docs"] },
    "/Docs/": { self: { fileId: "11" } },
  });
  const browse = (
    await adapter.executeAction(actionInput("nextcloud.browse", {}))
  ).result as unknown as ConnectorSelectionBrowseResult;
  assert.deepEqual(
    browse.entries.map((e) => e.id),
    ["/Docs"],
  );
  const describe = (
    await adapter.executeAction(
      actionInput("nextcloud.describe", { ids: ["/Docs/"] }),
    )
  ).result as unknown as ConnectorSelectionDescribeResult;
  assert.equal(describe.items[0]!.id, "/Docs");
  assert.equal(describe.items[0]!.exists, true);
});

// --- within-scan duplicate identity -----------------------------------------

test("the same fileid under two folders yields one item (first by walk order wins)", async () => {
  const { adapter, harness } = adapterFor({
    "/": { self: { fileId: "10" }, folders: ["A", "B"] },
    "/A/": {
      files: {
        "doc.pdf": {
          size: 1,
          etag: '"x"',
          fileId: "500",
          permissions: "RGDNVW",
        },
      },
    },
    "/B/": {
      files: {
        "copy.pdf": {
          size: 1,
          etag: '"x"',
          fileId: "500",
          permissions: "RGDNVW",
        },
      },
    },
  });
  const pages = await collect(adapter.discoverPages!(discoverInput(["/"])));
  const items = pages.flatMap((p) => p.items);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.externalId, "nc:500");
  // A/ is walked before B/, so its path is the one that is kept.
  assert.equal(items[0]!.metadata.path, "/A/doc.pdf");
  const last = pages[pages.length - 1]!;
  assert.equal(last.complete, true);
  // A duplicate never marks the scan incomplete.
  assert.equal(last.reconcileMissing, true);
  // Exactly one fixed-message warning carrying only a count.
  const dupWarnings = harness.warnings.filter(
    (w) => w.message === "webdav_scan_duplicate_items",
  );
  assert.equal(dupWarnings.length, 1);
  assert.equal(dupWarnings[0]!.meta?.count, 1);
});

test("overlapping roots emit a shared fileid only once", async () => {
  const { adapter } = adapterFor({
    "/A/": {
      files: {
        "doc.pdf": {
          size: 1,
          etag: '"x"',
          fileId: "600",
          permissions: "RGDNVW",
        },
      },
    },
    "/B/": {
      files: {
        "copy.pdf": {
          size: 1,
          etag: '"x"',
          fileId: "600",
          permissions: "RGDNVW",
        },
      },
    },
  });
  const items = await discoverItems(adapter, discoverInput(["/A/", "/B/"]));
  assert.deepEqual(
    items.map((i) => i.externalId),
    ["nc:600"],
  );
  assert.equal(items[0]!.metadata.path, "/A/doc.pdf");
});

test("a server echoing one fileid on two hrefs in a listing yields one item", async () => {
  const { adapter } = adapterFor({
    "/": {
      self: { fileId: "10" },
      files: {
        "a.pdf": { size: 1, etag: '"x"', fileId: "500", permissions: "RGDNVW" },
        "b.pdf": { size: 1, etag: '"x"', fileId: "500", permissions: "RGDNVW" },
      },
    },
  });
  const pages = await collect(adapter.discoverPages!(discoverInput(["/"])));
  const items = pages.flatMap((p) => p.items);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.externalId, "nc:500");
  assert.equal(items[0]!.metadata.path, "/a.pdf");
  assert.equal(pages[pages.length - 1]!.reconcileMissing, true);
});

test("a readable file with no oc:fileid is skipped but the scan still reconciles (R3)", async () => {
  const { adapter } = adapterFor({
    "/": {
      self: { fileId: "10" },
      files: {
        "ided.txt": {
          size: 1,
          etag: '"i"',
          fileId: "7",
          permissions: "RGDNVW",
        },
        "noid.txt": { size: 1, etag: '"n"', permissions: "RGDNVW" },
      },
    },
  });
  const pages = await collect(adapter.discoverPages!(discoverInput(["/"])));
  const ids = pages.flatMap((p) => p.items).map((i) => i.externalId);
  assert.deepEqual(ids, ["nc:7"]);
  const last = pages[pages.length - 1]!;
  assert.equal(last.complete, true);
  assert.equal(last.reconcileMissing, true);
});

// --- sub-folder install -----------------------------------------------------

test("a sub-folder install builds endpoints and canonical links under the base path", async () => {
  const endpoint = "https://host.example/nextcloud/remote.php/dav/files/alice/";
  const server = "https://host.example/nextcloud";
  const { adapter } = adapterFor(
    {
      "/": {
        self: { fileId: "10" },
        files: {
          "a.txt": {
            size: 1,
            etag: '"a"',
            fileId: "88",
            permissions: "RGDNVW",
          },
        },
      },
    },
    { endpoint, server },
  );
  const items = await discoverItems(
    adapter,
    discoverInput(["/"], { endpoint, server }),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0]!.externalId, "nc:88");
  assert.equal(
    items[0]!.externalUri,
    "https://host.example/nextcloud/index.php/f/88",
  );
  assert.equal(items[0]!.metadata.path, "/a.txt");
});
