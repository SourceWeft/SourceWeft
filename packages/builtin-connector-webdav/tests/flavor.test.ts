import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConnectorActionInput,
  ConnectorDiscoverInput,
  ConnectorDiscoveryPage,
  ConnectorItem,
  ConnectorSelectionBrowseResult,
  ConnectorSelectionDescribeResult,
} from "@sourceweft/contracts";
import { createWebdavAdapter, WebDavAdapterError } from "../src/adapter";
import { createDavClient } from "../src/dav-client";
import { webdavFlavor, type WebDavFlavor } from "../src/flavor";
import type { DavEntry } from "../src/multistatus";
import { buildFakeDav, fakeHarness, type FakeDavSpec } from "./fake-dav";

const ENDPOINT = "https://dav.example.com/dav/";
const ACCESS_TOKEN = JSON.stringify({ username: "alice", secret: "pw-Ω" });

/** The exact PROPFIND body the plain WebDAV flavor has always sent. Pinned so
 * the flavor seam cannot change the request a non-oc listing makes. */
const WEBDAV_PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  "<d:resourcetype/><d:getetag/><d:getlastmodified/>" +
  "<d:getcontentlength/><d:getcontenttype/>" +
  "</d:prop></d:propfind>";

const entry = (over: Partial<DavEntry> = {}): DavEntry => ({
  href: "/dav/x",
  isCollection: false,
  etag: null,
  lastModified: null,
  contentLength: null,
  contentType: null,
  ...over,
});

/** A second, deliberately different flavor: its own capability id, action and
 * error prefixes, file-id-based identity, a read-permission check and a
 * readiness requirement that the server returned `oc:fileid`. */
const fakeFlavor: WebDavFlavor = {
  id: "x",
  capabilityId: "example/x",
  actionPrefix: "x",
  errorPrefix: "X",
  getManifest: webdavFlavor.getManifest,
  extraProps: ["oc:fileid", "oc:permissions", "oc:owner-id"],
  itemIdentity(e, ctx) {
    const fileId = e.fileId ?? null;
    return {
      externalId: fileId !== null ? `x:${fileId}` : ctx.relativePath,
      externalUri:
        fileId !== null ? `https://x.example/f/${fileId}` : ctx.relativePath,
      metadata: {
        path: ctx.relativePath,
        fileId,
        permissions: e.permissions ?? null,
        ownerId: e.ownerId ?? null,
        etag: e.etag,
      },
    };
  },
  isReadable(e) {
    return e.permissions == null ? true : e.permissions.includes("R");
  },
  requireProps(entries) {
    return entries.every((e) => e.fileId != null)
      ? null
      : { reason: "x_unrecognised", message: "This server is not recognised." };
  },
};

function adapterFor(
  flavor: WebDavFlavor | undefined,
  collections: FakeDavSpec["collections"],
  options: { status?: Record<string, number> } = {},
) {
  const fetchImpl = buildFakeDav({
    endpoint: new URL(ENDPOINT),
    collections,
    status: options.status,
  });
  const harness = fakeHarness(fetchImpl);
  const adapter = createWebdavAdapter({
    credentialedFetch: harness.credentialedFetch,
    logger: harness.logger,
    ...(flavor ? { flavor } : {}),
  });
  return { adapter, harness };
}

function discoverInput(roots: string[]): ConnectorDiscoverInput {
  return {
    teamId: "t",
    workspaceId: "w",
    connectorId: "c1",
    connectorType: "x",
    config: { endpoint: ENDPOINT, roots },
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
    connectorType: "x",
    actionType,
    request,
    config: { endpoint: ENDPOINT, roots: ["/"] },
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

// --- webdavFlavor characterization ------------------------------------------

test("webdavFlavor has the shipped ids, prefixes and empty extra props", () => {
  assert.equal(webdavFlavor.id, "webdav");
  assert.equal(webdavFlavor.capabilityId, "sourceweft/webdav");
  assert.equal(webdavFlavor.actionPrefix, "webdav");
  assert.equal(webdavFlavor.errorPrefix, "WEBDAV");
  assert.deepEqual([...webdavFlavor.extraProps], []);
  assert.equal(webdavFlavor.getManifest().type, "webdav");
  assert.equal(webdavFlavor.requireProps, undefined);
  assert.equal(webdavFlavor.isReadable(entry()), true);
});

test("webdavFlavor item identity is the decoded path, the request URL and {path, etag}", () => {
  const identity = webdavFlavor.itemIdentity(entry({ etag: '"v1"' }), {
    endpoint: new URL(ENDPOINT),
    relativePath: "/Docs/a b.txt",
  });
  // The plain WebDAV flavor always assigns a (path-based) identity.
  assert.ok(identity);
  assert.equal(identity.externalId, "/Docs/a b.txt");
  assert.equal(
    identity.externalUri,
    "https://dav.example.com/dav/Docs/a%20b.txt",
  );
  assert.deepEqual(identity.metadata, { path: "/Docs/a b.txt", etag: '"v1"' });
});

test("the default adapter is the webdav flavor (capability id and action prefix)", async () => {
  const { adapter } = adapterFor(undefined, {
    "/": { folders: ["Docs"] },
    "/Docs/": {},
  });
  assert.equal(adapter.capabilityId, "sourceweft/webdav");
  assert.equal(adapter.getManifest().type, "webdav");
  const { result } = await adapter.executeAction(
    actionInput("webdav.browse", {}),
  );
  const browse = result as unknown as ConnectorSelectionBrowseResult;
  assert.deepEqual(
    browse.entries.map((e) => e.id),
    ["/Docs"],
  );
});

// --- a second flavor drives the same adapter --------------------------------

test("a flavor dispatches its own action prefix for browse and describe", async () => {
  const { adapter } = adapterFor(fakeFlavor, {
    "/": { folders: ["Docs"] },
    "/Docs/": {},
  });
  const browse = (await adapter.executeAction(actionInput("x.browse", {})))
    .result as unknown as ConnectorSelectionBrowseResult;
  assert.deepEqual(
    browse.entries.map((e) => e.id),
    ["/Docs"],
  );
  const describe = (
    await adapter.executeAction(actionInput("x.describe", { ids: ["/Docs/"] }))
  ).result as unknown as ConnectorSelectionDescribeResult;
  assert.equal(describe.items[0]!.id, "/Docs");
  assert.equal(describe.items[0]!.exists, true);
});

test("a flavor raises its own error prefix for unsupported and invalid actions", async () => {
  const { adapter } = adapterFor(fakeFlavor, { "/": {} });
  await assert.rejects(
    adapter.executeAction(actionInput("x.write", {})),
    (error: unknown) => {
      assert.ok(error instanceof WebDavAdapterError);
      assert.equal(error.code, "X_UNSUPPORTED_ACTION");
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
  await assert.rejects(
    adapter.executeAction(actionInput("x.browse", { containerId: 5 })),
    (error: unknown) => {
      assert.ok(error instanceof WebDavAdapterError);
      assert.equal(error.code, "X_INVALID_REQUEST");
      return true;
    },
  );
});

test("a flavor maps a 401 to its own reauth-required code", async () => {
  const { adapter } = adapterFor(
    fakeFlavor,
    { "/": {} },
    { status: { "/": 401 } },
  );
  await assert.rejects(
    collect(adapter.discoverPages!(discoverInput(["/"]))),
    (error: unknown) => {
      assert.ok(error instanceof WebDavAdapterError);
      assert.equal(error.code, "X_REAUTH_REQUIRED");
      assert.equal(error.statusCode, 422);
      return true;
    },
  );
});

test("discovery derives item id, uri and metadata from the flavor", async () => {
  const { adapter } = adapterFor(fakeFlavor, {
    "/": {
      files: {
        "a.txt": {
          size: 5,
          etag: '"v1"',
          fileId: "123",
          permissions: "RGDNVW",
          ownerId: "alice",
        },
      },
    },
  });
  const items: ConnectorItem[] = [];
  for await (const item of adapter.discover(discoverInput(["/"]))) {
    items.push(item);
  }
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.externalId, "x:123");
  assert.equal(item.externalUri, "https://x.example/f/123");
  assert.equal(item.title, "a.txt");
  assert.deepEqual(item.metadata, {
    path: "/a.txt",
    fileId: "123",
    permissions: "RGDNVW",
    ownerId: "alice",
    etag: '"v1"',
  });
});

test("an unreadable file is skipped by discovery without making the scan incomplete", async () => {
  const { adapter } = adapterFor(fakeFlavor, {
    "/": {
      files: {
        "ok.txt": { size: 1, etag: '"o"', fileId: "1", permissions: "RGDNVW" },
        "no.txt": { size: 1, etag: '"n"', fileId: "2", permissions: "DNVW" },
      },
    },
  });
  const pages = await collect(adapter.discoverPages!(discoverInput(["/"])));
  const ids = pages.flatMap((p) => p.items).map((i) => i.externalId);
  assert.deepEqual(ids, ["x:1"]);
  const last = pages[pages.length - 1]!;
  assert.equal(last.complete, true);
  // The skipped file does not make the scan incomplete: it still reconciles.
  assert.equal(last.reconcileMissing, true);
});

// --- requireProps is a readiness-only hook ----------------------------------

function readinessAdapter(selfHasFileId: boolean) {
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() !== "PROPFIND") {
      return new Response("nope", { status: 405 });
    }
    const fileid = selfHasFileId ? "<oc:fileid>42</oc:fileid>" : "";
    const body =
      '<?xml version="1.0"?>' +
      '<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">' +
      "<d:response><d:href>/dav/</d:href><d:propstat><d:prop>" +
      `<d:resourcetype><d:collection/></d:resourcetype>${fileid}` +
      "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>" +
      "</d:multistatus>";
    return new Response(body, {
      status: 207,
      headers: { "content-type": "application/xml" },
    });
  }) as typeof fetch;
  return createWebdavAdapter({
    credentialedFetch: () => ({ fetch: fetchImpl, close: async () => {} }),
    flavor: fakeFlavor,
  });
}

test("requireProps fails readiness when the required property is absent", async () => {
  const result = await readinessAdapter(false).checkSyncReadiness!(
    discoverInput(["/"]),
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, "x_unrecognised");
  assert.equal(result.message, "This server is not recognised.");
});

test("requireProps passes readiness when the required property is present", async () => {
  const result = await readinessAdapter(true).checkSyncReadiness!(
    discoverInput(["/"]),
  );
  assert.equal(result.ready, true);
});

// --- the PROPFIND body carries extra props only when requested --------------

test("the PROPFIND body includes extra props only when requested", async () => {
  const bodies: string[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "PROPFIND") {
      bodies.push(String(init?.body));
    }
    return new Response('<d:multistatus xmlns:d="DAV:"/>', {
      status: 207,
      headers: { "content-type": "application/xml" },
    });
  }) as typeof fetch;
  const client = createDavClient({
    fetch: fetchImpl,
    endpoint: new URL(ENDPOINT),
    credential: { username: "a", secret: "b" },
  });
  await client.propfind("/", 0);
  await client.propfind("/", 1, {
    extraProps: ["oc:fileid", "oc:permissions", "oc:owner-id"],
  });
  assert.equal(bodies.length, 2);
  // The default body is byte-identical to the shipped WebDAV body.
  assert.equal(bodies[0], WEBDAV_PROPFIND_BODY);
  assert.equal(bodies[0]!.includes("owncloud.org/ns"), false);
  // The requested body declares the oc namespace and adds each property.
  assert.match(bodies[1]!, /xmlns:oc="http:\/\/owncloud\.org\/ns"/);
  assert.match(bodies[1]!, /<oc:fileid\/>/);
  assert.match(bodies[1]!, /<oc:permissions\/>/);
  assert.match(bodies[1]!, /<oc:owner-id\/>/);
});
