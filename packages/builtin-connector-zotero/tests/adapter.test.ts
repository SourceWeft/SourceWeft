import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorItemSkipError } from "@sourceweft/contracts";
import { createZoteroAdapter, ZoteroAdapterError } from "../src/adapter";
import { zoteroCredentialIdentity } from "../src/identity";
import {
  API_KEY,
  baseInput,
  harness,
  keyInfo,
  rawCollection,
  rawItem,
  storedCredential,
  userConfig,
} from "./helpers/adapter-fixtures";

const groupConfig = (libraryId = "7") => ({
  libraryType: "group",
  libraryId,
  items: [],
});

test("the adapter identifies itself and has no OAuth or webhook surface", () => {
  const { adapter } = harness({});
  assert.equal(adapter.capabilityId, "sourceweft/zotero");
  assert.equal(adapter.getManifest().type, "zotero");
  assert.equal(adapter.credentialIdentity, zoteroCredentialIdentity);
  for (const absent of [
    "exchangeOAuthCode",
    "refreshOAuthToken",
    "credentialFlow",
    "startAuthorization",
    "finishAuthorization",
    "revokeAuthorization",
    "verifyWebhook",
    "parseWebhookEvent",
    "mapWebhookEventToSyncTargets",
  ] as const) {
    assert.equal(absent in adapter, false, absent);
  }
});

// ---- readiness -----------------------------------------------------------

test("readiness: a personal key for the configured library is ready", async () => {
  const { adapter, closed, opened } = harness({});
  const result = await adapter.checkSyncReadiness!(baseInput());
  assert.deepEqual(result, { ready: true, metadata: { notesAccess: true } });
  assert.equal(opened(), 1);
  assert.equal(closed(), 1);
});

test("readiness: a personal key without notes access is ready with a warning", async () => {
  const { adapter } = harness({
    keyInfo: keyInfo({ user: { library: true, notes: false } }),
  });
  const result = await adapter.checkSyncReadiness!(baseInput());
  assert.equal(result.ready, true);
  assert.deepEqual(result.metadata, { notesAccess: false });
  assert.equal(
    result.message,
    "This Zotero key cannot read notes, so notes will not be indexed.",
  );
});

test("readiness: a key of another user is not accessible", async () => {
  const { adapter } = harness({ keyInfo: keyInfo({ userID: 2 }) });
  const result = await adapter.checkSyncReadiness!(baseInput());
  assert.equal(result.ready, false);
  assert.equal(result.reason, "library_not_accessible");
});

test("readiness: a key without personal library access is not accessible", async () => {
  const { adapter } = harness({
    keyInfo: keyInfo({ user: { library: false, notes: true } }),
  });
  const result = await adapter.checkSyncReadiness!(baseInput());
  assert.equal(result.ready, false);
  assert.equal(result.reason, "library_not_accessible");
  const none = harness({ keyInfo: keyInfo({ user: null }) });
  assert.equal(
    (await none.adapter.checkSyncReadiness!(baseInput())).reason,
    "library_not_accessible",
  );
});

test("readiness: group keys need groupsAll or the group's own access", async () => {
  const input = baseInput(groupConfig(), storedCredential("groups/7"));
  const all = harness({
    prefix: "groups/7",
    keyInfo: keyInfo({ groups: { all: { library: true } } }),
  });
  assert.deepEqual(await all.adapter.checkSyncReadiness!(input), {
    ready: true,
    metadata: { notesAccess: true },
  });
  const own = harness({
    prefix: "groups/7",
    keyInfo: keyInfo({ groups: { "7": { library: true } } }),
  });
  assert.equal((await own.adapter.checkSyncReadiness!(input)).ready, true);
  const denied = harness({
    prefix: "groups/7",
    keyInfo: keyInfo({ groups: { "7": { library: false } } }),
  });
  const deniedResult = await denied.adapter.checkSyncReadiness!(input);
  assert.equal(deniedResult.ready, false);
  assert.equal(deniedResult.reason, "library_not_accessible");
  const missing = harness({
    prefix: "groups/7",
    keyInfo: keyInfo({ groups: { "8": { library: true } } }),
  });
  assert.equal(
    (await missing.adapter.checkSyncReadiness!(input)).reason,
    "library_not_accessible",
  );
});

test("readiness: a stored credential for another library requires reauth without any request", async () => {
  const { adapter, fake } = harness({});
  const result = await adapter.checkSyncReadiness!(
    baseInput(userConfig(), storedCredential("users/2")),
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, "reauth_required");
  const swapped = await adapter.checkSyncReadiness!(
    baseInput(userConfig(), storedCredential("groups/1")),
  );
  assert.equal(swapped.reason, "reauth_required");
  assert.equal(fake.requests.length, 0);
});

test("readiness: malformed config or credential maps to fixed reasons", async () => {
  const { adapter } = harness({});
  const bad = await adapter.checkSyncReadiness!(
    baseInput({ libraryType: "user", libraryId: "x" }),
  );
  assert.equal(bad.reason, "config_invalid");
  const badItems = await adapter.checkSyncReadiness!(
    baseInput({ ...userConfig(), items: [{ id: "nope", kind: "collection" }] }),
  );
  assert.equal(badItems.reason, "config_invalid");
  const noCredential = await adapter.checkSyncReadiness!(
    baseInput(userConfig(), "not json"),
  );
  assert.equal(noCredential.reason, "reauth_required");
});

test("readiness: Zotero failures map to their reasons and never echo the key", async () => {
  const cases: Array<[number | "network", string]> = [
    [403, "reauth_required"],
    [401, "reauth_required"],
    [404, "reauth_required"],
    [429, "rate_limited"],
    [500, "unreachable"],
    ["network", "unreachable"],
  ];
  for (const [fault, reason] of cases) {
    const { adapter, fake } = harness({});
    fake.failNext(
      fault === "network" ? { networkError: true } : { status: fault },
      5,
    );
    const result = await adapter.checkSyncReadiness!(baseInput());
    assert.equal(result.ready, false, String(fault));
    assert.equal(result.reason, reason, String(fault));
    assert.ok(!JSON.stringify(result).includes(API_KEY));
  }
});

test("readiness: a blocked endpoint maps to blocked_endpoint", async () => {
  // The host's address policy rejects with this code.
  const blocked = Object.assign(new TypeError("blocked"), {
    code: "ENDPOINT_NOT_ALLOWED",
  });
  const blockedAdapter = createZoteroAdapter({
    credentialedFetch: () => ({
      fetch: (async () => {
        throw blocked;
      }) as unknown as typeof fetch,
      close: async () => undefined,
    }),
  });
  const result = await blockedAdapter.checkSyncReadiness!(baseInput());
  assert.equal(result.reason, "blocked_endpoint");
});

// ---- discovery -----------------------------------------------------------

const libraryWithItems = {
  collections: [rawCollection("COLL0001", "Reading")],
  items: [
    rawItem("ARTICLE1", "journalArticle", {
      title: "Deep Weaving",
      collections: ["COLL0001"],
    }),
    rawItem("ARTICLE2", "book", { title: "Other" }),
  ],
};

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const entry of iterable) out.push(entry);
  return out;
}

test("discoverPages scans the library and closes its scope on success", async () => {
  const { adapter, opened, closed } = harness(libraryWithItems);
  const pages = await collect(adapter.discoverPages!(baseInput()));
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.reconcileMissing, true);
  assert.deepEqual(pages[0]!.items.map((item) => item.externalId).sort(), [
    "zotero:ARTICLE1",
    "zotero:ARTICLE2",
  ]);
  assert.equal(opened(), 1);
  assert.equal(closed(), 1);
});

test("discoverPages honours the selected collections", async () => {
  const { adapter } = harness(libraryWithItems);
  const pages = await collect(
    adapter.discoverPages!(
      baseInput(userConfig([{ id: "COLL0001", kind: "collection" }])),
    ),
  );
  assert.deepEqual(
    pages[0]!.items.map((item) => item.externalId),
    ["zotero:ARTICLE1"],
  );
});

test("discoverPages passes the committed cursor so an unchanged library short-circuits", async () => {
  const { adapter, fake } = harness({ ...libraryWithItems, version: 5 });
  const pages = await collect(
    adapter.discoverPages!({
      ...baseInput(),
      cursor: {
        committed: { libraryVersion: 5, checkedAt: 1_700_000_000_000 - 1000 },
      },
    }),
  );
  assert.equal(pages[0]!.items.length, 0);
  assert.equal(pages[0]!.reconcileMissing, false);
  assert.equal(fake.requests.length, 1);
});

test("discoverPages uses a fresh client per call: the 2,000-request budget does not carry over", async () => {
  const h = harness(libraryWithItems);
  // Two requests per scan: 1,100 scans exceed one client's cap of 2,000.
  for (let run = 0; run < 1100; run += 1) {
    const pages = await collect(h.adapter.discoverPages!(baseInput()));
    assert.equal(pages[0]!.items.length, 2);
  }
  assert.equal(h.opened(), 1100);
  assert.equal(h.closed(), 1100);
});

test("discoverPages closes its scope when the scan throws", async () => {
  const { adapter, fake, opened, closed } = harness(libraryWithItems);
  fake.failNext({ status: 403 }, 5);
  await assert.rejects(
    () => collect(adapter.discoverPages!(baseInput())),
    (error: unknown) => {
      assert.ok(error instanceof ZoteroAdapterError);
      assert.equal(error.code, "ZOTERO_KEY_INSUFFICIENT_ACCESS");
      assert.equal(error.statusCode, 422);
      return true;
    },
  );
  assert.equal(opened(), 1);
  assert.equal(closed(), 1);
});

test("discoverPages closes its scope when the consumer stops early", async () => {
  const { adapter, closed } = harness(libraryWithItems);
  const iterator = adapter.discoverPages!(baseInput())[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return?.();
  assert.equal(closed(), 1);
});

test("a revoked key mid-scan surfaces a fixed adapter error and closes the scope", async () => {
  const { adapter, fake, closed } = harness(libraryWithItems);
  fake.failNext({ status: 403 }, 5, (request) =>
    request.path.endsWith("/items"),
  );
  await assert.rejects(
    () => collect(adapter.discoverPages!(baseInput())),
    (error: unknown) => {
      assert.ok(error instanceof ZoteroAdapterError);
      assert.ok(!error.message.includes(API_KEY));
      assert.ok(!error.message.includes("users/1"));
      return true;
    },
  );
  assert.equal(closed(), 1);
});

test("a stored credential for another library fails reauth before any request", async () => {
  const { adapter, fake, closed } = harness(libraryWithItems);
  await assert.rejects(
    () =>
      collect(
        adapter.discoverPages!(
          baseInput(userConfig(), storedCredential("users/2")),
        ),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ZoteroAdapterError);
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, "ZOTERO_REAUTH_REQUIRED");
      return true;
    },
  );
  assert.equal(fake.requests.length, 0);
  assert.equal(closed(), 1);
});

test("an invalid config or credential is a fixed adapter error", async () => {
  const { adapter } = harness(libraryWithItems);
  await assert.rejects(
    () => collect(adapter.discoverPages!(baseInput({ libraryType: "user" }))),
    (error: unknown) =>
      error instanceof ZoteroAdapterError &&
      error.statusCode === 400 &&
      error.code === "ZOTERO_CONFIG_INVALID",
  );
  await assert.rejects(
    () => collect(adapter.discoverPages!(baseInput(userConfig(), "garbage"))),
    (error: unknown) =>
      error instanceof ZoteroAdapterError &&
      error.code === "ZOTERO_REAUTH_REQUIRED",
  );
});

test("discover yields the same items as discoverPages", async () => {
  const { adapter } = harness(libraryWithItems);
  const items = await collect(adapter.discover(baseInput()));
  assert.equal(items.length, 2);
});

// ---- extraction ----------------------------------------------------------

const articleLibrary = {
  items: [
    rawItem("ARTICLE1", "journalArticle", {
      title: "Deep Weaving",
      abstractNote: "We weave.",
    }),
  ],
  children: {},
};

async function discoveredArticle(h: ReturnType<typeof harness>) {
  const pages = await collect(h.adapter.discoverPages!(baseInput()));
  return pages[0]!.items[0]!;
}

test("extract re-reads the item, matches the scan hash and closes its scope", async () => {
  const h = harness(articleLibrary);
  const item = await discoveredArticle(h);
  const before = h.opened();
  const extracted = await h.adapter.extract({ ...baseInput(), item });
  assert.ok("contentText" in extracted);
  assert.match(extracted.contentText, /Deep Weaving/);
  assert.equal(extracted.item.contentHash, item.contentHash);
  assert.equal(h.opened(), before + 1);
  assert.equal(h.closed(), h.opened());
});

test("extract closes its scope when the item is gone and skips it", async () => {
  const h = harness(articleLibrary);
  const item = await discoveredArticle(h);
  h.fake.setLibrary({ version: 6, items: [] });
  await assert.rejects(
    () => h.adapter.extract({ ...baseInput(), item }),
    (error: unknown) => error instanceof ConnectorItemSkipError,
  );
  assert.equal(h.closed(), h.opened());
});

test("extract maps Zotero failures to a fixed adapter error and closes its scope", async () => {
  const h = harness(articleLibrary);
  const item = await discoveredArticle(h);
  h.fake.failNext({ status: 429 }, 10);
  await assert.rejects(
    () => h.adapter.extract({ ...baseInput(), item }),
    (error: unknown) =>
      error instanceof ZoteroAdapterError &&
      error.statusCode === 429 &&
      error.code === "ZOTERO_RATE_LIMITED",
  );
  assert.equal(h.closed(), h.opened());
});

test("extract uses a fresh client per call: the 2,000-request budget does not carry over", async () => {
  const h = harness(articleLibrary);
  const item = await discoveredArticle(h);
  // Three requests per extraction: 700 extractions exceed one client's cap.
  for (let run = 0; run < 700; run += 1) {
    await h.adapter.extract({ ...baseInput(), item });
  }
  assert.equal(h.closed(), h.opened());
});

test("an unknown action type is a fixed error", async () => {
  const { adapter } = harness({});
  await assert.rejects(
    () =>
      adapter.executeAction({
        ...baseInput(),
        actionType: "zotero.delete",
        request: { secret: API_KEY },
        idempotencyKey: "k",
      }),
    (error: unknown) => {
      assert.ok(error instanceof ZoteroAdapterError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "ZOTERO_UNSUPPORTED_ACTION");
      assert.ok(!error.message.includes("zotero.delete"));
      return true;
    },
  );
});
