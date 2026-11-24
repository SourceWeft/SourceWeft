import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  isConnectorItemSkipError,
  type ConnectorActionInput,
  type ConnectorDiscoverInput,
  type ConnectorDiscoveryPage,
  type ConnectorExtractInput,
  type ConnectorItem,
  type ConnectorSelectionBrowseResult,
  type ConnectorSelectionDescribeResult,
} from "@sourceweft/contracts";
import { isConnectorExtractedFile } from "@sourceweft/contracts";
import { createWebdavAdapter, WebDavAdapterError } from "../src/adapter";
import { buildFakeDav, fakeHarness, type FakeDavSpec } from "./fake-dav";

const ENDPOINT = "https://dav.example.com/dav/";
const USERNAME = "alice";
const SECRET = "app-password-Ω-9";
const ACCESS_TOKEN = JSON.stringify({ username: USERNAME, secret: SECRET });

function adapterFor(
  collections: FakeDavSpec["collections"],
  options: {
    status?: Record<string, number>;
    methods?: string[];
    rogueChildren?: Record<string, string[]>;
  } = {},
) {
  let fetchImpl = buildFakeDav({
    endpoint: new URL(ENDPOINT),
    collections,
    status: options.status,
    rogueChildren: options.rogueChildren,
  });
  if (options.methods) {
    const inner = fetchImpl;
    const record = options.methods;
    fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      record.push((init?.method ?? "GET").toUpperCase());
      return inner(input, init);
    }) as typeof fetch;
  }
  const harness = fakeHarness(fetchImpl);
  const adapter = createWebdavAdapter({
    credentialedFetch: harness.credentialedFetch,
    logger: harness.logger,
  });
  return { adapter, harness };
}

function discoverInput(
  roots: string[],
  extra: Partial<ConnectorDiscoverInput> = {},
): ConnectorDiscoverInput {
  return {
    teamId: "t",
    workspaceId: "w",
    connectorId: "c1",
    connectorType: "webdav",
    config: { endpoint: ENDPOINT, roots },
    accessToken: ACCESS_TOKEN,
    ...extra,
  };
}

function extractInput(item: ConnectorItem): ConnectorExtractInput {
  return { ...discoverInput(["/"]), item };
}

function actionInput(
  actionType: string,
  request: Record<string, unknown>,
): ConnectorActionInput {
  return {
    teamId: "t",
    workspaceId: "w",
    connectorId: "c1",
    connectorType: "webdav",
    actionType,
    request,
    config: { endpoint: ENDPOINT, roots: ["/"] },
    accessToken: ACCESS_TOKEN,
    idempotencyKey: "k",
  };
}

function fileItem(
  overrides: Partial<ConnectorItem> & { path: string },
): ConnectorItem {
  const { path, ...rest } = overrides;
  return {
    externalId: path,
    externalUri: `${ENDPOINT}${path.slice(1)}`,
    title: path.split("/").filter(Boolean).at(-1) ?? "",
    mimeType: "text/plain",
    sizeBytes: 5,
    externalUpdatedAt: null,
    contentHash: '"v1"',
    metadata: { path, etag: '"v1"' },
    ...rest,
  };
}

async function collect(
  iterable: AsyncIterable<ConnectorDiscoveryPage>,
): Promise<ConnectorDiscoveryPage[]> {
  const pages: ConnectorDiscoveryPage[] = [];
  for await (const page of iterable) pages.push(page);
  return pages;
}

// --- credentialIdentity -----------------------------------------------------

test("credentialIdentity is sha256 of origin and username, not the secret", () => {
  const { adapter } = adapterFor({ "/": {} });
  const identity = adapter.credentialIdentity!(
    { endpoint: ENDPOINT, roots: ["/"] },
    { username: USERNAME, secret: SECRET },
  );
  const expected = createHash("sha256")
    .update(`https://dav.example.com\n${USERNAME}`)
    .digest("hex");
  assert.equal(identity, expected);
  assert.equal(identity.includes(SECRET), false);
});

// --- checkSyncReadiness ------------------------------------------------------

test("readiness is ready when every root answers", async () => {
  const { adapter, harness } = adapterFor({ "/": {}, "/Docs/": {} });
  const result = await adapter.checkSyncReadiness!(
    discoverInput(["/", "/Docs/"]),
  );
  assert.equal(result.ready, true);
  assert.deepEqual(result.metadata, { rootCount: 2 });
  assert.equal(harness.state.scopes, harness.state.closes);
  assert.ok(harness.state.closes > 0);
});

test("readiness maps 401 to reauth_required", async () => {
  const { adapter } = adapterFor({ "/": {} }, { status: { "/": 401 } });
  const result = await adapter.checkSyncReadiness!(discoverInput(["/"]));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "reauth_required");
});

test("readiness maps 403 to a path-forbidden reason", async () => {
  const { adapter } = adapterFor(
    { "/Docs/": {} },
    { status: { "/Docs": 403 } },
  );
  const result = await adapter.checkSyncReadiness!(discoverInput(["/Docs/"]));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "path_forbidden");
});

test("readiness maps 404 to a path-not-found reason", async () => {
  const { adapter } = adapterFor({ "/": {} });
  const result = await adapter.checkSyncReadiness!(
    discoverInput(["/Missing/"]),
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, "path_not_found");
});

test("readiness treats a malformed credential as reauth_required without a request", async () => {
  const methods: string[] = [];
  const { adapter } = adapterFor({ "/": {} }, { methods });
  const result = await adapter.checkSyncReadiness!(
    discoverInput(["/"], { accessToken: "not json" }),
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, "reauth_required");
  assert.equal(methods.length, 0);
});

// --- discoverPages: credential mapping --------------------------------------

test("discoverPages maps a 401 to a 422 reconnect error, never a raw 401", async () => {
  const { adapter } = adapterFor({ "/": {} }, { status: { "/": 401 } });
  await assert.rejects(
    collect(adapter.discoverPages!(discoverInput(["/"]))),
    (error: unknown) => {
      assert.ok(error instanceof WebDavAdapterError);
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, "WEBDAV_REAUTH_REQUIRED");
      return true;
    },
  );
});

test("discover yields the discovered items", async () => {
  const { adapter } = adapterFor({
    "/": { files: { "a.txt": { size: 1, etag: '"a"' } } },
  });
  const items: ConnectorItem[] = [];
  for await (const item of adapter.discover(discoverInput(["/"]))) {
    items.push(item);
  }
  assert.deepEqual(
    items.map((i) => i.externalId),
    ["/a.txt"],
  );
});

// --- extract -----------------------------------------------------------------

test("extract skips an unsupported type", async () => {
  const { adapter } = adapterFor({ "/": {} });
  await assert.rejects(
    adapter.extract(
      extractInput(fileItem({ path: "/photo.png", mimeType: "image/png" })),
    ),
    (error: unknown) => {
      assert.ok(isConnectorItemSkipError(error));
      assert.equal(error.reason, "unsupported_type");
      return true;
    },
  );
});

test("extract downloads a supported file", async () => {
  const { adapter, harness } = adapterFor({
    "/Docs/": {
      files: {
        "a.txt": {
          size: 5,
          etag: '"v1"',
          body: "hello",
          contentType: "text/plain",
        },
      },
    },
  });
  const extracted = await adapter.extract(
    extractInput(fileItem({ path: "/Docs/a.txt" })),
  );
  assert.ok(isConnectorExtractedFile(extracted));
  assert.equal(extracted.file.fileName, "a.txt");
  assert.equal(extracted.file.mimeType, "text/plain");
  const bytes = await extracted.file.download({ maxBytes: 1000 });
  assert.equal(bytes.toString("utf8"), "hello");
  assert.equal(harness.state.scopes, harness.state.closes);
});

test("extract's download skips a file over the cap", async () => {
  const { adapter } = adapterFor({
    "/Docs/": { files: { "a.txt": { size: 1000, etag: '"v1"', body: "x" } } },
  });
  const extracted = await adapter.extract(
    extractInput(fileItem({ path: "/Docs/a.txt" })),
  );
  assert.ok(isConnectorExtractedFile(extracted));
  await assert.rejects(
    extracted.file.download({ maxBytes: 10 }),
    (error: unknown) => {
      assert.ok(isConnectorItemSkipError(error));
      assert.equal(error.reason, "too_large");
      return true;
    },
  );
});

test("extract's download returns the fresh bytes even when the etag changed since discovery", async () => {
  const { adapter } = adapterFor({
    "/Docs/": { files: { "a.txt": { size: 5, etag: '"v2"', body: "hello" } } },
  });
  const extracted = await adapter.extract(
    extractInput(
      fileItem({
        path: "/Docs/a.txt",
        metadata: { path: "/Docs/a.txt", etag: '"v1"' },
      }),
    ),
  );
  assert.ok(isConnectorExtractedFile(extracted));
  // No skip: the new content is indexed; the next run sees the new etag.
  const bytes = await extracted.file.download({ maxBytes: 1000 });
  assert.equal(bytes.toString("utf8"), "hello");
});

test("extract's download skips a file that is forbidden, gone or locked", async () => {
  for (const status of [403, 404, 410, 423]) {
    const { adapter } = adapterFor(
      { "/Docs/": { files: { "a.txt": { size: 5, body: "hi" } } } },
      { status: { "/Docs/a.txt": status } },
    );
    const extracted = await adapter.extract(
      extractInput(fileItem({ path: "/Docs/a.txt" })),
    );
    assert.ok(isConnectorExtractedFile(extracted));
    await assert.rejects(
      extracted.file.download({ maxBytes: 1000 }),
      (error: unknown) => {
        assert.ok(isConnectorItemSkipError(error), String(status));
        assert.equal(error.reason, "unreadable", String(status));
        return true;
      },
    );
  }
});

test("extract's download still fails the run on a 500 (not a per-file skip)", async () => {
  const { adapter } = adapterFor(
    { "/Docs/": { files: { "a.txt": { size: 5, body: "hi" } } } },
    { status: { "/Docs/a.txt": 500 } },
  );
  const extracted = await adapter.extract(
    extractInput(fileItem({ path: "/Docs/a.txt" })),
  );
  assert.ok(isConnectorExtractedFile(extracted));
  await assert.rejects(
    extracted.file.download({ maxBytes: 1000 }),
    (error: unknown) => {
      assert.ok(!isConnectorItemSkipError(error), "a 500 is not a skip");
      return true;
    },
  );
});

test("extract's download maps a 401 to a 422 reconnect error", async () => {
  const { adapter } = adapterFor(
    { "/Docs/": { files: { "a.txt": { size: 5, body: "hi" } } } },
    { status: { "/Docs/a.txt": 401 } },
  );
  const extracted = await adapter.extract(
    extractInput(fileItem({ path: "/Docs/a.txt" })),
  );
  assert.ok(isConnectorExtractedFile(extracted));
  await assert.rejects(
    extracted.file.download({ maxBytes: 1000 }),
    (error: unknown) => {
      assert.ok(error instanceof WebDavAdapterError);
      assert.equal(error.statusCode, 422);
      return true;
    },
  );
});

// --- executeAction: browse ---------------------------------------------------

test("browse lists only child folders, sorted, with no files", async () => {
  const { adapter } = adapterFor({
    "/": {
      folders: ["Photos", "Docs"],
      files: { "readme.txt": { size: 1, etag: '"r"' } },
    },
    "/Docs/": {},
    "/Photos/": {},
  });
  const { result } = await adapter.executeAction(
    actionInput("webdav.browse", {}),
  );
  const browse = result as unknown as ConnectorSelectionBrowseResult;
  assert.equal(browse.container, null);
  assert.deepEqual(browse.breadcrumbs, []);
  assert.deepEqual(
    browse.entries.map((e) => e.id),
    ["/Docs", "/Photos"],
  );
  assert.ok(browse.entries.every((e) => e.kind === "folder" && e.expandable));
  assert.equal(browse.hasMore, false);
});

test("browse of a nested folder reports container and breadcrumbs", async () => {
  const { adapter } = adapterFor({
    "/": { folders: ["Docs"] },
    "/Docs/": { folders: ["Sub"] },
    "/Docs/Sub/": { folders: ["Leaf"] },
    "/Docs/Sub/Leaf/": {},
  });
  const { result } = await adapter.executeAction(
    actionInput("webdav.browse", { containerId: "/Docs/Sub" }),
  );
  const browse = result as unknown as ConnectorSelectionBrowseResult;
  assert.equal(browse.container?.id, "/Docs/Sub");
  assert.equal(browse.container?.name, "Sub");
  assert.deepEqual(browse.breadcrumbs, [{ id: "/Docs", name: "Docs" }]);
  assert.deepEqual(
    browse.entries.map((e) => e.id),
    ["/Docs/Sub/Leaf"],
  );
});

test("browse returns only strict descendants, dropping parents, siblings and lookalikes", async () => {
  const { adapter } = adapterFor(
    {
      "/a/b/": { folders: ["child"] },
      "/a/b/child/": {},
    },
    {
      rogueChildren: {
        "/a/b/": [
          "/dav/a/", // the parent
          "/dav/a/bc/", // a /a/bc lookalike of container /a/b
          "/dav/a/sibling/", // a sibling collection
          "/dav/zzz/outside/", // outside the container entirely
        ],
      },
    },
  );
  const { result } = await adapter.executeAction(
    actionInput("webdav.browse", { containerId: "/a/b" }),
  );
  const browse = result as unknown as ConnectorSelectionBrowseResult;
  assert.deepEqual(
    browse.entries.map((e) => e.id),
    ["/a/b/child"],
  );
});

// --- executeAction: describe -------------------------------------------------

test("describe reports existence and display names of roots", async () => {
  const { adapter } = adapterFor({ "/Docs/": {} });
  const { result } = await adapter.executeAction(
    actionInput("webdav.describe", { ids: ["/Docs/", "/Missing/"] }),
  );
  const describe = result as unknown as ConnectorSelectionDescribeResult;
  assert.equal(describe.items.length, 2);
  assert.deepEqual(describe.items[0], {
    id: "/Docs",
    kind: "folder",
    name: "Docs",
    detail: "/Docs",
    exists: true,
    meta: {},
  });
  assert.equal(describe.items[1]!.exists, false);
  assert.equal(describe.items[1]!.kind, null);
});

test("describe reports a file path as a file, not a folder", async () => {
  const { adapter } = adapterFor({
    "/Docs/": {
      files: { "a.txt": { size: 5, etag: '"v1"', contentType: "text/plain" } },
    },
  });
  const { result } = await adapter.executeAction(
    actionInput("webdav.describe", { ids: ["/Docs/a.txt"] }),
  );
  const describe = result as unknown as ConnectorSelectionDescribeResult;
  assert.equal(describe.items.length, 1);
  assert.equal(describe.items[0]!.exists, true);
  assert.equal(describe.items[0]!.kind, "file");
});

// --- executeAction: unsupported ---------------------------------------------

test("an unknown action throws a fixed unsupported-action error", async () => {
  const { adapter } = adapterFor({ "/": {} });
  await assert.rejects(
    adapter.executeAction(actionInput("webdav.write", {})),
    (error: unknown) => {
      assert.ok(error instanceof WebDavAdapterError);
      assert.equal(error.code, "WEBDAV_UNSUPPORTED_ACTION");
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
});

// --- read-only guarantee -----------------------------------------------------

test("the adapter only ever issues PROPFIND, GET and OPTIONS", async () => {
  const methods: string[] = [];
  const { adapter } = adapterFor(
    {
      "/": {
        folders: ["Docs"],
        files: { "a.txt": { size: 5, etag: '"v1"', body: "hi" } },
      },
      "/Docs/": {},
    },
    { methods },
  );
  await adapter.checkSyncReadiness!(discoverInput(["/"]));
  await collect(adapter.discoverPages!(discoverInput(["/"])));
  await adapter.executeAction(actionInput("webdav.browse", {}));
  await adapter.executeAction(actionInput("webdav.describe", { ids: ["/"] }));
  const extracted = await adapter.extract(
    extractInput(fileItem({ path: "/a.txt" })),
  );
  if (isConnectorExtractedFile(extracted)) {
    await extracted.file.download({ maxBytes: 1000 });
  }
  const unique = [...new Set(methods)].sort();
  assert.deepEqual(unique, ["GET", "PROPFIND"]);
});

// --- secret safety -----------------------------------------------------------

test("the secret never appears in a logger call or a thrown error", async () => {
  const logged: unknown[] = [];
  const original = { ...console };
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => void logged.push(args);
  }
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
    [];
  const errors: unknown[] = [];
  try {
    // A failing walk (401) plus an unreadable extract, over a scope whose fetch
    // never reflects the credential back.
    const fetchImpl = buildFakeDav({
      endpoint: new URL(ENDPOINT),
      collections: { "/": {} },
      status: { "/": 401 },
    });
    const adapter = createWebdavAdapter({
      credentialedFetch: () => ({ fetch: fetchImpl, close: async () => {} }),
      logger: { warn: (message, meta) => warnings.push({ message, meta }) },
    });
    try {
      await collect(adapter.discoverPages!(discoverInput(["/"])));
    } catch (error) {
      errors.push(error);
    }
    const result = await adapter.checkSyncReadiness!(discoverInput(["/"]));
    errors.push(new Error(JSON.stringify(result)));
  } finally {
    Object.assign(console, original);
  }
  const b64 = Buffer.from(`${USERNAME}:${SECRET}`).toString("base64");
  const haystacks = [
    JSON.stringify(logged),
    JSON.stringify(warnings),
    ...errors.map((error) =>
      [
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? String(error.stack) : "",
        JSON.stringify(error),
      ].join("\n"),
    ),
  ];
  for (const text of haystacks) {
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(b64), false);
  }
});
