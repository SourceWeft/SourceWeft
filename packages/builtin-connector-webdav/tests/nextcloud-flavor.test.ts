import assert from "node:assert/strict";
import test from "node:test";
import { connectorContributionSchema } from "@sourceweft/capability-contracts";
import { connectorManifestSchema } from "@sourceweft/contracts";
import { nextcloudConnectorContribution } from "../src/nextcloud/contribution";
import { toBackendNextcloudManifest } from "../src/nextcloud/backend-manifest";
import { nextcloudEndpoint } from "../src/nextcloud/endpoint";
import { nextcloudFlavor } from "../src/nextcloud/flavor";
import type { DavEntry } from "../src/multistatus";
import { MAX_ROOTS } from "../src/limits";

const ENDPOINT = "https://cloud.example.com/remote.php/dav/files/alice/";
const SERVER = "https://cloud.example.com";

const entry = (over: Partial<DavEntry> = {}): DavEntry => ({
  href: "/remote.php/dav/files/alice/Docs/report.pdf",
  isCollection: false,
  etag: '"v1"',
  lastModified: new Date("2026-11-22T08:30:15Z"),
  contentLength: 48213,
  contentType: "application/pdf",
  ...over,
});

const identityFor = (
  over: Partial<DavEntry>,
  server: string | undefined = SERVER,
) => {
  const identity = nextcloudFlavor.itemIdentity(entry(over), {
    endpoint: new URL(ENDPOINT),
    server,
    relativePath: "/Docs/report.pdf",
  });
  assert.ok(identity, "expected an identity");
  return identity;
};

// --- static shape -----------------------------------------------------------

test("nextcloudFlavor has the Nextcloud ids, prefixes and oc extra props", () => {
  assert.equal(nextcloudFlavor.id, "nextcloud");
  assert.equal(nextcloudFlavor.capabilityId, "sourceweft/webdav");
  assert.equal(nextcloudFlavor.actionPrefix, "nextcloud");
  assert.equal(nextcloudFlavor.errorPrefix, "NEXTCLOUD");
  assert.deepEqual(
    [...nextcloudFlavor.extraProps],
    ["oc:fileid", "oc:permissions", "oc:owner-id"],
  );
  assert.equal(nextcloudFlavor.getManifest().type, "nextcloud");
});

// --- item identity ----------------------------------------------------------

test("itemIdentity uses nc:<fileid>, the canonical link and the full metadata", () => {
  const identity = identityFor({
    fileId: "123",
    permissions: "RGDNVW",
    ownerId: "alice",
  });
  assert.equal(identity.externalId, "nc:123");
  assert.equal(
    identity.externalUri,
    "https://cloud.example.com/index.php/f/123",
  );
  assert.deepEqual(identity.metadata, {
    path: "/Docs/report.pdf",
    fileId: "123",
    permissions: "RGDNVW",
    ownerId: "alice",
    shared: false,
    etag: '"v1"',
    contentType: "application/pdf",
    size: 48213,
  });
});

test("itemIdentity is stable across a rename or move (same fileId, new path)", () => {
  const first = nextcloudFlavor.itemIdentity(entry({ fileId: "77" }), {
    endpoint: new URL(ENDPOINT),
    server: SERVER,
    relativePath: "/Docs/old-name.pdf",
  });
  const moved = nextcloudFlavor.itemIdentity(entry({ fileId: "77" }), {
    endpoint: new URL(ENDPOINT),
    server: SERVER,
    relativePath: "/Archive/new-name.pdf",
  });
  assert.ok(first);
  assert.ok(moved);
  assert.equal(first.externalId, moved.externalId);
  assert.equal(first.externalId, "nc:77");
  assert.equal(first.metadata.path, "/Docs/old-name.pdf");
  assert.equal(moved.metadata.path, "/Archive/new-name.pdf");
});

test("the canonical link keeps a server base path and strips a trailing slash", () => {
  const identity = nextcloudFlavor.itemIdentity(entry({ fileId: "9" }), {
    endpoint: new URL(ENDPOINT),
    server: "https://host.example/nextcloud/",
    relativePath: "/Docs/report.pdf",
  });
  assert.ok(identity);
  assert.equal(
    identity.externalUri,
    "https://host.example/nextcloud/index.php/f/9",
  );
});

test("a share (permission flag S) is flagged in metadata", () => {
  assert.equal(
    identityFor({ fileId: "1", permissions: "RGDNVWS" }).metadata.shared,
    true,
  );
  assert.equal(
    identityFor({ fileId: "1", permissions: "RGDNVW" }).metadata.shared,
    false,
  );
  assert.equal(identityFor({ fileId: "1" }).metadata.shared, false);
});

test("a file with no usable fileId is skipped (itemIdentity returns null) (R3)", () => {
  const ctx = {
    endpoint: new URL(ENDPOINT),
    server: SERVER,
    relativePath: "/Docs/report.pdf",
  };
  // Absent, empty-and-therefore-null, and present-but-invalid file ids all
  // yield no identity, so discovery skips the file rather than indexing it
  // under a path id.
  assert.equal(nextcloudFlavor.itemIdentity(entry({}), ctx), null);
  assert.equal(
    nextcloudFlavor.itemIdentity(entry({ fileId: null }), ctx),
    null,
  );
});

// --- readability (oc:permissions read flag) ---------------------------------

test("isReadable requires the G (read) permission flag; a missing property is readable", () => {
  assert.equal(
    nextcloudFlavor.isReadable(entry({ permissions: "RGDNVW" })),
    true,
  );
  assert.equal(
    nextcloudFlavor.isReadable(entry({ permissions: "RDNVW" })),
    false,
  );
  assert.equal(nextcloudFlavor.isReadable(entry({ permissions: "" })), false);
  assert.equal(nextcloudFlavor.isReadable(entry({})), true);
  assert.equal(nextcloudFlavor.isReadable(entry({ permissions: null })), true);
});

// --- requireProps (readiness-only) ------------------------------------------

test("requireProps fails with the not_nextcloud reason when no entry has a fileId", () => {
  const result = nextcloudFlavor.requireProps!([
    entry({}),
    entry({ fileId: null }),
  ]);
  assert.ok(result);
  assert.equal(result.reason, "not_nextcloud");
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0);
});

test("requireProps passes when at least one entry carries a fileId", () => {
  assert.equal(
    nextcloudFlavor.requireProps!([entry({}), entry({ fileId: "5" })]),
    null,
  );
});

// --- endpoint builder -------------------------------------------------------

test("nextcloudEndpoint URL-encodes the user id and keeps a server base path", () => {
  assert.equal(
    nextcloudEndpoint("https://host.example/nextcloud", "al ice"),
    "https://host.example/nextcloud/remote.php/dav/files/al%20ice/",
  );
});

test("nextcloudEndpoint strips a trailing slash from the server", () => {
  assert.equal(
    nextcloudEndpoint("https://host.example/", "alice"),
    "https://host.example/remote.php/dav/files/alice/",
  );
});

// --- contribution and backend manifest --------------------------------------

test("the nextcloud contribution is a basic-credential connector with its own actions", () => {
  const c = nextcloudConnectorContribution;
  assert.equal(c.id, "nextcloud");
  assert.deepEqual(c.auth, {
    kind: "credential",
    scheme: "basic",
    flow: "login_flow",
  });
  assert.equal(c.sync.resources[0]!.type, "nextcloud_file");
  assert.equal(c.sync.resources[0]!.supportsDeleteDetection, true);
  assert.deepEqual(
    c.actions.map((a) => a.id),
    ["nextcloud.browse", "nextcloud.describe"],
  );
  assert.equal(c.selection.actions.browse, "nextcloud.browse");
  assert.equal(c.selection.actions.describe, "nextcloud.describe");
  connectorContributionSchema.parse(c);
});

test("the nextcloud config schema is server, endpoint, userId and roots", () => {
  const schema = nextcloudConnectorContribution.configSchema;
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "endpoint",
    "roots",
    "server",
    "userId",
  ]);
  assert.deepEqual([...schema.required].sort(), [
    "endpoint",
    "roots",
    "server",
    "userId",
  ]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.roots.maxItems, MAX_ROOTS);
  assert.equal(schema.properties.roots.minItems, 1);
});

test("the nextcloud backend manifest carries credential auth and the selection spec", () => {
  const manifest = connectorManifestSchema.parse(toBackendNextcloudManifest());
  assert.equal(manifest.type, "nextcloud");
  assert.equal(manifest.displayName, "Nextcloud");
  assert.deepEqual(manifest.auth, {
    kind: "credential",
    scheme: "basic",
    flow: "login_flow",
  });
  assert.deepEqual(
    manifest.actions.map((a) => a.type),
    ["nextcloud.browse", "nextcloud.describe"],
  );
  assert.equal(manifest.selection?.actions.browse, "nextcloud.browse");
  assert.equal(manifest.selection?.maxItems, MAX_ROOTS);
});
