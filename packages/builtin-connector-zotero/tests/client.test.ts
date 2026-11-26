import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReadOnly,
  createZoteroClient,
  type ZoteroClient,
} from "../src/client";
import { ZoteroError } from "../src/errors";
import { MAX_REQUESTS, MAX_RETRIES, ZOTERO_USER_AGENT } from "../src/limits";
import {
  startFakeZotero,
  type FakeLibrary,
  type FakeObject,
} from "./helpers/fake-zotero";

const KEY = "abcdEFGH12345678abcdEFGH";
const PREFIX = "users/1" as const;

function objects(count: number, from = 0): FakeObject[] {
  return Array.from({ length: count }, (_, i) => {
    const n = from + i;
    return {
      key: `ITEM${String(n).padStart(4, "0")}`,
      version: 1,
      data: { n },
    };
  });
}

function setup(
  library: FakeLibrary = {},
  options: {
    requestTimeoutMs?: number;
    maxResponseBytes?: number;
    signal?: AbortSignal;
  } = {},
) {
  const fake = startFakeZotero({ version: 7, ...library });
  const sleeps: number[] = [];
  const client = createZoteroClient({
    fetch: fake.fetch,
    credential: { secret: KEY },
    libraryPrefix: PREFIX,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  return { fake, client, sleeps };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ZoteroError, "expected a ZoteroError");
    assert.ok(!error.message.includes(KEY));
    assert.ok(!error.message.includes("users/1"));
    assert.equal(error.cause, undefined);
    return error.code;
  }
  assert.fail("expected the call to fail");
}

test("every request is a GET with the key header, version 3 and the user agent", async () => {
  const { fake, client } = setup({
    items: objects(3),
    collections: objects(1),
  });
  await client.keyInfo();
  await client.getPage("collections", { start: 0 });
  await client.getPage("items", { start: 0 });
  await client.getObject("items/ITEM0001");
  await client.getList("items/ITEM0001/children");
  assert.equal(fake.requests.length, 5);
  for (const request of fake.requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.headers["zotero-api-key"], KEY);
    assert.equal(request.headers["zotero-api-version"], "3");
    assert.equal(request.headers["user-agent"], ZOTERO_USER_AGENT);
    assert.equal(request.query.key, undefined);
    assert.ok(!request.url.includes(KEY));
    assert.ok(request.url.startsWith("https://api.zotero.org/"));
  }
  assert.equal(
    ZOTERO_USER_AGENT,
    "SourceWeft-ZoteroConnector/1.0 (+https://sourceweft.com)",
  );
});

test("assertReadOnly accepts exactly GET", () => {
  assertReadOnly("GET");
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "get", "HEAD"]) {
    assert.throws(
      () => assertReadOnly(method),
      (e) => e instanceof ZoteroError && e.code === "ZOTERO_BAD_RESPONSE",
    );
  }
});

test("getPage returns objects, the library version and the total", async () => {
  const { fake, client } = setup({ items: objects(150) });
  const first = await client.getPage("items", { start: 0 });
  assert.equal(first.status, "ok");
  if (first.status !== "ok") return;
  assert.equal(first.libraryVersion, 7);
  assert.equal(first.totalResults, 150);
  assert.equal(first.objects.length, 100);
  const second = await client.getPage("items", { start: 100 });
  assert.equal(second.status === "ok" && second.objects.length, 50);
  const [one] = fake.requests;
  assert.equal(one?.path, "/users/1/items");
  assert.deepEqual(one?.query, {
    limit: "100",
    format: "json",
    include: "data",
    sort: "dateAdded",
    direction: "asc",
    start: "0",
  });
});

test("collections pages send no sort", async () => {
  const { fake, client } = setup({ collections: objects(2) });
  await client.getPage("collections", { start: 0 });
  assert.equal(fake.requests[0]?.path, "/users/1/collections");
  assert.equal(fake.requests[0]?.query.sort, undefined);
  assert.equal(fake.requests[0]?.query.direction, undefined);
});

test("If-Modified-Since-Version yields not_modified only when unchanged", async () => {
  const { fake, client } = setup({ items: objects(2) });
  const same = await client.getPage("items", {
    start: 0,
    ifModifiedSinceVersion: 7,
  });
  assert.deepEqual(same, { status: "not_modified", libraryVersion: 7 });
  assert.equal(fake.requests[0]?.headers["if-modified-since-version"], "7");
  fake.setVersion(8);
  const changed = await client.getPage("items", {
    start: 0,
    ifModifiedSinceVersion: 7,
  });
  assert.equal(changed.status, "ok");
  assert.equal(changed.libraryVersion, 8);
});

test("a 304 without a version header reports the requested version", async () => {
  const { fake, client } = setup({ items: objects(1) });
  const page = await client.getPage("items", {
    start: 0,
    ifModifiedSinceVersion: 9,
  });
  assert.deepEqual(page, { status: "not_modified", libraryVersion: 9 });
  assert.equal(fake.requests.length, 1);
});

test("a 304 that carries a version header reports that version", async () => {
  const { fake, client } = setup({ items: objects(1) });
  fake.mutateNext({ "Last-Modified-Version": "8" });
  const page = await client.getPage("items", {
    start: 0,
    ifModifiedSinceVersion: 9,
  });
  assert.deepEqual(page, { status: "not_modified", libraryVersion: 8 });
});

test("a 304 with a malformed version header falls back to the requested one", async () => {
  const { fake, client } = setup({ items: objects(1) });
  fake.mutateNext({ "Last-Modified-Version": "seven" });
  const page = await client.getPage("items", {
    start: 0,
    ifModifiedSinceVersion: 9,
  });
  assert.deepEqual(page, { status: "not_modified", libraryVersion: 9 });
});

test("a 304 to a non-conditional request is a bad response", async () => {
  const { fake, client } = setup({ items: objects(1) });
  fake.failNext({ status: 304, headers: { "Last-Modified-Version": "7" } });
  assert.equal(
    await codeOf(client.getPage("items", { start: 0 })),
    "ZOTERO_BAD_RESPONSE",
  );
  fake.failNext({ status: 304 });
  assert.equal(
    await codeOf(client.getPage("items", { start: 0 })),
    "ZOTERO_BAD_RESPONSE",
  );
});

test("keyInfo parses user and group access", async () => {
  const { client } = setup({
    keyInfo: {
      userID: 42,
      username: "alice",
      access: {
        user: { library: true, notes: false, files: true },
        groups: {
          all: { library: false },
          "99": { library: true },
          "100": { library: false },
        },
      },
    },
  });
  const info = await client.keyInfo();
  assert.equal(info.userId, "42");
  assert.equal(info.username, "alice");
  assert.deepEqual(info.access.userLibrary, true);
  assert.equal(info.access.userNotes, false);
  assert.equal(info.access.groupsAll, false);
  assert.deepEqual(
    [...info.access.groups],
    [
      ["99", true],
      ["100", false],
    ],
  );
});

test("keyInfo tolerates a key with no user access and rejects a bad body", async () => {
  const { client, fake } = setup({
    keyInfo: { userID: 1, access: { groups: { all: { library: true } } } },
  });
  const info = await client.keyInfo();
  assert.equal(info.username, null);
  assert.equal(info.access.userLibrary, false);
  assert.equal(info.access.groupsAll, true);
  fake.setLibrary({ keyInfo: { access: {} } });
  assert.equal(await codeOf(client.keyInfo()), "ZOTERO_BAD_RESPONSE");
});

test("getObject returns the object and its version; getList pages to the end", async () => {
  const { fake, client } = setup({
    items: [{ key: "PARENT01", version: 3 }],
    children: { PARENT01: objects(230) },
  });
  const one = await client.getObject("items/PARENT01");
  assert.equal(one.libraryVersion, 7);
  assert.equal((one.object as FakeObject).key, "PARENT01");
  const list = await client.getList("items/PARENT01/children");
  assert.equal(list.length, 230);
  const starts = fake.requests
    .filter((r) => r.path.endsWith("/children"))
    .map((r) => r.query.start);
  assert.deepEqual(starts, ["0", "100", "200"]);
});

test("getObject and getList refuse paths that are not item paths", async () => {
  const { client, fake } = setup({});
  for (const path of [
    "items",
    "../keys/current",
    "items/abc",
    "items/ITEM0001/x",
    "collections/ABCDEFGH",
  ]) {
    assert.equal(
      await codeOf(client.getObject(path)),
      "ZOTERO_CONFIG_INVALID",
      path,
    );
  }
  assert.equal(
    await codeOf(client.getList("items/ITEM0001")),
    "ZOTERO_CONFIG_INVALID",
  );
  assert.equal(fake.requests.length, 0);
});

test("the client rejects a malformed library prefix or key up front", () => {
  const fake = startFakeZotero({});
  for (const libraryPrefix of [
    "users/0",
    "teams/1",
    "users/1/x",
    "users/",
    "../users/1",
  ]) {
    assert.throws(
      () =>
        createZoteroClient({
          fetch: fake.fetch,
          credential: { secret: KEY },
          libraryPrefix: libraryPrefix as "users/1",
        }),
      (e) => e instanceof ZoteroError && e.code === "ZOTERO_CONFIG_INVALID",
      libraryPrefix,
    );
  }
  for (const secret of ["", "a b", "a\nb", "é"]) {
    assert.throws(
      () =>
        createZoteroClient({
          fetch: fake.fetch,
          credential: { secret },
          libraryPrefix: PREFIX,
        }),
      (e) => e instanceof ZoteroError && e.code === "ZOTERO_REAUTH_REQUIRED",
    );
  }
});

test("status mapping on keys/current", async () => {
  const { client, fake } = setup({});
  const cases: [number, string][] = [
    [401, "ZOTERO_REAUTH_REQUIRED"],
    [403, "ZOTERO_REAUTH_REQUIRED"],
    [404, "ZOTERO_REAUTH_REQUIRED"],
    [400, "ZOTERO_UNAVAILABLE"],
    [500, "ZOTERO_UNAVAILABLE"],
  ];
  for (const [status, code] of cases) {
    fake.failNext({ status, body: `secret ${KEY}` });
    assert.equal(await codeOf(client.keyInfo()), code, String(status));
  }
});

test("status mapping on library paths", async () => {
  const { client, fake } = setup({ items: objects(1) });
  const cases: [number, string][] = [
    [401, "ZOTERO_REAUTH_REQUIRED"],
    [403, "ZOTERO_KEY_INSUFFICIENT_ACCESS"],
    [404, "ZOTERO_LIBRARY_NOT_FOUND"],
    [400, "ZOTERO_UNAVAILABLE"],
    [418, "ZOTERO_UNAVAILABLE"],
    [500, "ZOTERO_UNAVAILABLE"],
    [301, "ZOTERO_BAD_RESPONSE"],
    [204, "ZOTERO_BAD_RESPONSE"],
  ];
  for (const [status, code] of cases) {
    fake.failNext({ status, body: `users/1 ${KEY}` });
    assert.equal(
      await codeOf(client.getPage("items", { start: 0 })),
      code,
      String(status),
    );
  }
  fake.failNext({ status: 404 });
  assert.equal(
    await codeOf(client.getObject("items/ITEM0000")),
    "ZOTERO_LIBRARY_NOT_FOUND",
  );
});

test("429 with Retry-After retries after that many seconds", async () => {
  const { client, fake, sleeps } = setup({ items: objects(1) });
  fake.failNext({ status: 429, headers: { "Retry-After": "1" } });
  const page = await client.getPage("items", { start: 0 });
  assert.equal(page.status, "ok");
  assert.deepEqual(sleeps, [1000]);
  assert.equal(fake.requests.length, 2);
});

test("Retry-After is capped and a missing one backs off 500 ms per attempt", async () => {
  const { client, fake, sleeps } = setup({ items: objects(1) });
  fake.failNext({ status: 429, headers: { "Retry-After": "3600" } });
  await client.getPage("items", { start: 0 });
  fake.failNext({ status: 503 }, 2);
  await client.getPage("items", { start: 0 });
  assert.deepEqual(sleeps, [10_000, 500, 1000]);
});

test("429 beyond MAX_RETRIES is rate limited; 5xx beyond it is unavailable", async () => {
  const { client, fake } = setup({ items: objects(1) });
  fake.failNext({ status: 429 }, 99);
  assert.equal(
    await codeOf(client.getPage("items", { start: 0 })),
    "ZOTERO_RATE_LIMITED",
  );
  assert.equal(fake.requests.length, MAX_RETRIES + 1);
  const second = setup({ items: objects(1) });
  second.fake.failNext({ status: 502 }, 99);
  assert.equal(
    await codeOf(second.client.getPage("items", { start: 0 })),
    "ZOTERO_UNAVAILABLE",
  );
  assert.equal(second.fake.requests.length, MAX_RETRIES + 1);
});

test("a network error is retried, then unavailable", async () => {
  const { client, fake } = setup({ items: objects(1) });
  fake.failNext({ networkError: true });
  assert.equal((await client.getPage("items", { start: 0 })).status, "ok");
  fake.failNext({ networkError: true }, 99);
  assert.equal(
    await codeOf(client.getPage("items", { start: 0 })),
    "ZOTERO_UNAVAILABLE",
  );
});

test("Backoff makes the next request wait; one above the cap is rate limited", async () => {
  const { client, fake, sleeps } = setup({ items: objects(1) });
  fake.mutateNext({ Backoff: "5" });
  await client.getPage("items", { start: 0 });
  assert.deepEqual(sleeps, []);
  await client.getPage("items", { start: 0 });
  assert.deepEqual(sleeps, [5000]);
  await client.getPage("items", { start: 0 });
  assert.deepEqual(sleeps, [5000], "the wait is spent once");

  fake.mutateNext({ Backoff: "30" });
  await client.getPage("items", { start: 0 });
  await client.getPage("items", { start: 0 });
  assert.deepEqual(sleeps, [5000, 30_000]);

  fake.mutateNext({ Backoff: "600" });
  await client.getPage("items", { start: 0 });
  const before = fake.requests.length;
  assert.equal(
    await codeOf(client.getPage("items", { start: 0 })),
    "ZOTERO_RATE_LIMITED",
  );
  assert.equal(
    fake.requests.length,
    before,
    "no request is sent after refusing",
  );
});

test("a garbage Backoff header is ignored", async () => {
  const { client, fake, sleeps } = setup({ items: objects(1) });
  fake.mutateNext({ Backoff: "soon" });
  await client.getPage("items", { start: 0 });
  await client.getPage("items", { start: 0 });
  assert.deepEqual(sleeps, []);
});

test("a body over maxResponseBytes is too large, declared or streamed", async () => {
  const { client } = setup({ items: objects(20) }, { maxResponseBytes: 200 });
  assert.equal(
    await codeOf(client.getPage("items", { start: 0 })),
    "ZOTERO_TOO_LARGE",
  );

  const big = "[" + '"x"'.padEnd(500, " ") + "]";
  const streamed = createZoteroClient({
    fetch: (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(big));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "Last-Modified-Version": "1", "Total-Results": "1" },
        },
      )) as typeof fetch,
    credential: { secret: KEY },
    libraryPrefix: PREFIX,
    maxResponseBytes: 100,
  });
  assert.equal(
    await codeOf(streamed.getPage("items", { start: 0 })),
    "ZOTERO_TOO_LARGE",
  );
});

test("a timeout is unavailable, even when fetch ignores the signal", async () => {
  const { client, fake } = setup({}, { requestTimeoutMs: 20 });
  fake.failNext({ hang: true });
  assert.equal(await codeOf(client.keyInfo()), "ZOTERO_UNAVAILABLE");

  const stuck = createZoteroClient({
    fetch: (() => new Promise<Response>(() => undefined)) as typeof fetch,
    credential: { secret: KEY },
    libraryPrefix: PREFIX,
    requestTimeoutMs: 20,
  });
  assert.equal(await codeOf(stuck.keyInfo()), "ZOTERO_UNAVAILABLE");
});

test("an aborted external signal is unavailable and sends nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const { client, fake } = setup({}, { signal: controller.signal });
  assert.equal(await codeOf(client.keyInfo()), "ZOTERO_UNAVAILABLE");
  assert.equal(fake.requests.length, 0);
});

test("malformed JSON, a non-array list and a missing version are bad responses", async () => {
  const { client, fake } = setup({ items: objects(2) });
  fake.failNext({
    status: 200,
    body: "{not json",
    headers: { "Last-Modified-Version": "7", "Total-Results": "1" },
  });
  assert.equal(
    await codeOf(client.getPage("items", { start: 0 })),
    "ZOTERO_BAD_RESPONSE",
  );
  fake.failNext({
    status: 200,
    body: "{}",
    headers: { "Last-Modified-Version": "7", "Total-Results": "1" },
  });
  assert.equal(
    await codeOf(client.getPage("items", { start: 0 })),
    "ZOTERO_BAD_RESPONSE",
  );
  fake.mutateNext({ "Last-Modified-Version": null });
  assert.equal(
    await codeOf(client.getPage("items", { start: 0 })),
    "ZOTERO_BAD_RESPONSE",
  );
  fake.mutateNext({ "Last-Modified-Version": "seven" });
  assert.equal(
    await codeOf(client.getPage("items", { start: 0 })),
    "ZOTERO_BAD_RESPONSE",
  );
  fake.mutateNext({ "Total-Results": null });
  assert.equal(
    await codeOf(client.getPage("items", { start: 0 })),
    "ZOTERO_BAD_RESPONSE",
  );
  fake.failNext({ status: 200, body: "[]" });
  assert.equal(
    await codeOf(client.getList("items/ITEM0000/children")),
    "ZOTERO_BAD_RESPONSE",
  );
});

test("getObject rejects an array or a missing version", async () => {
  const { client, fake } = setup({ items: objects(1) });
  fake.failNext({
    status: 200,
    body: "[]",
    headers: { "Last-Modified-Version": "7" },
  });
  assert.equal(
    await codeOf(client.getObject("items/ITEM0000")),
    "ZOTERO_BAD_RESPONSE",
  );
  fake.mutateNext({ "Last-Modified-Version": null });
  assert.equal(
    await codeOf(client.getObject("items/ITEM0000")),
    "ZOTERO_BAD_RESPONSE",
  );
});

test("an endpoint-policy refusal is a blocked endpoint, including via cause", async () => {
  for (const make of [
    () =>
      Object.assign(new Error("blocked https://api.zotero.org"), {
        code: "ENDPOINT_NOT_ALLOWED",
      }),
    () =>
      new TypeError("fetch failed", {
        cause: { code: "ENDPOINT_NOT_ALLOWED" },
      }),
  ]) {
    let calls = 0;
    const client = createZoteroClient({
      fetch: (async () => {
        calls += 1;
        throw make();
      }) as typeof fetch,
      credential: { secret: KEY },
      libraryPrefix: PREFIX,
      sleep: async () => undefined,
    });
    assert.equal(await codeOf(client.keyInfo()), "ZOTERO_BLOCKED_ENDPOINT");
    assert.equal(calls, 1, "a policy refusal is not retried");
  }
});

test("the request after MAX_REQUESTS is too large", async () => {
  const { client, fake } = setup({ collections: objects(1) });
  for (let i = 0; i < MAX_REQUESTS; i += 1) {
    await client.getPage("collections", { start: 0 });
  }
  assert.equal(fake.requests.length, MAX_REQUESTS);
  assert.equal(
    await codeOf(client.getPage("collections", { start: 0 })),
    "ZOTERO_TOO_LARGE",
  );
  assert.equal(fake.requests.length, MAX_REQUESTS);
});

test("retries count against the request budget", async () => {
  const { client, fake } = setup({ collections: objects(1) });
  fake.failNext({ status: 503 }, 2);
  await client.getPage("collections", { start: 0 });
  assert.equal(fake.requests.length, 3);
  for (let i = 0; i < MAX_REQUESTS - 3; i += 1) {
    await client.getPage("collections", { start: 0 });
  }
  assert.equal(await codeOf(client.keyInfo()), "ZOTERO_TOO_LARGE");
});

test("the client is typed against the interface", () => {
  const { client } = setup({});
  const typed: ZoteroClient = client;
  assert.equal(typeof typed.getPage, "function");
});
