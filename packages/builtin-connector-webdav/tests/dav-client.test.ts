import assert from "node:assert/strict";
import test from "node:test";
import { createDavClient, assertReadOnlyMethod } from "../src/dav-client";
import { WebDavError } from "../src/errors";
import { MAX_MULTISTATUS_BYTES } from "../src/limits";

const SECRET = "s3cr3t-app-password-Ω";
const USERNAME = "alice";
const endpoint = new URL(
  "https://cloud.example.com/remote.php/dav/files/alice/",
);
const credential = { username: USERNAME, secret: SECRET };

const MULTISTATUS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/remote.php/dav/files/alice/Docs/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  <d:response><d:href>/remote.php/dav/files/alice/Docs/a.txt</d:href><d:propstat><d:prop><d:getcontentlength>3</d:getcontentlength><d:getetag>"e1"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;

type Recorded = { url: string; init: RequestInit };
type Handler = (
  url: string,
  init: RequestInit,
  attempt: number,
) => Promise<Response> | Response;

function harness(
  handler: Handler,
  options: { requestTimeoutMs?: number } = {},
) {
  const requests: Recorded[] = [];
  const sleeps: number[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {}, requests.length);
  }) as typeof fetch;
  const client = createDavClient({
    fetch: fakeFetch,
    endpoint,
    credential,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => Date.parse("2026-11-24T12:00:00Z"),
    ...options,
  });
  return { client, requests, sleeps };
}

const multistatus = (status = 207) =>
  new Response(MULTISTATUS, {
    status,
    headers: { "content-type": "application/xml" },
  });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(
      error instanceof WebDavError,
      `expected WebDavError, got ${String(error)}`,
    );
    return error.code;
  }
  assert.fail("expected rejection");
}

function networkError(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ECONNRESET" },
  });
}

test("assertReadOnlyMethod admits only PROPFIND, GET and OPTIONS", () => {
  for (const method of ["PROPFIND", "GET", "OPTIONS"]) {
    assert.doesNotThrow(() => assertReadOnlyMethod(method));
  }
  for (const method of [
    "PUT",
    "DELETE",
    "MKCOL",
    "COPY",
    "MOVE",
    "PROPPATCH",
    "LOCK",
    "UNLOCK",
    "POST",
    "PATCH",
    "HEAD",
    "propfind",
    "get",
    "",
  ]) {
    assert.throws(() => assertReadOnlyMethod(method), WebDavError, method);
  }
});

test("propfind sends PROPFIND with Depth, XML body and a Basic header, and parses 207", async () => {
  const h = harness(() => multistatus());
  const entries = await h.client.propfind("/Docs/", 1);
  assert.equal(entries.length, 2);
  assert.equal(entries[1]?.contentLength, 3);
  assert.equal(h.requests.length, 1);
  const { url, init } = h.requests[0]!;
  assert.equal(
    url,
    "https://cloud.example.com/remote.php/dav/files/alice/Docs/",
  );
  assert.equal(init.method, "PROPFIND");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("depth"), "1");
  assert.match(headers.get("content-type") ?? "", /^application\/xml/);
  assert.equal(
    headers.get("authorization"),
    `Basic ${Buffer.from(`${USERNAME}:${SECRET}`, "utf8").toString("base64")}`,
  );
  assert.equal(headers.has("cookie"), false);
  const body = String(init.body);
  assert.match(body, /propfind/);
  assert.match(body, /getetag/);
  assert.match(body, /getlastmodified/);
  assert.match(body, /getcontentlength/);
  assert.match(body, /resourcetype/);
});

test("propfind depth 0 sends Depth: 0", async () => {
  const h = harness(() => multistatus());
  await h.client.propfind("/", 0);
  assert.equal(new Headers(h.requests[0]!.init.headers).get("depth"), "0");
});

test("the client issues no method other than PROPFIND, GET and OPTIONS", async () => {
  const h = harness((_url, init) =>
    init.method === "GET"
      ? new Response("hello", { status: 200 })
      : init.method === "OPTIONS"
        ? new Response(null, { status: 200, headers: { dav: "1, 2" } })
        : multistatus(),
  );
  await h.client.propfind("/", 0);
  await h.client.propfind("/Docs/", 1);
  await h.client.get("/Docs/a.txt", { maxBytes: 100 });
  await h.client.options();
  const methods = new Set(h.requests.map((r) => r.init.method));
  assert.deepEqual([...methods].sort(), ["GET", "OPTIONS", "PROPFIND"]);
});

test("the Authorization header is sent only inside the client and never leaks", async () => {
  const logged: unknown[] = [];
  const original = { ...console };
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => void logged.push(args);
  }
  const failures: unknown[] = [];
  try {
    for (const status of [401, 403, 404, 405, 500, 301]) {
      const h = harness(
        () =>
          new Response(`oops ${SECRET} ${USERNAME}`, {
            status,
            headers: { location: "https://cloud.example.com/x" },
          }),
      );
      try {
        await h.client.propfind("/", 0);
      } catch (error) {
        failures.push(error);
      }
    }
    const h = harness(() => {
      throw Object.assign(new TypeError(`boom ${SECRET}`), {
        cause: { message: SECRET },
      });
    });
    try {
      await h.client.propfind("/", 0);
    } catch (error) {
      failures.push(error);
    }
  } finally {
    Object.assign(console, original);
  }
  assert.equal(failures.length, 7);
  const b64 = Buffer.from(`${USERNAME}:${SECRET}`).toString("base64");
  for (const error of failures) {
    assert.ok(error instanceof WebDavError);
    const text = [
      error.message,
      error.name,
      error.code,
      String(error.stack),
      JSON.stringify(error),
      Object.getOwnPropertyNames(error).join(","),
    ].join("\n");
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(b64), false);
    assert.equal(text.includes(USERNAME), false);
    assert.equal("cause" in error, false);
  }
  assert.equal(JSON.stringify(logged).includes(SECRET), false);
});

test("maps 401, 403 and 404 to fixed codes without retrying", async () => {
  const cases: Array<[number, string]> = [
    [401, "WEBDAV_UNAUTHORIZED"],
    [403, "WEBDAV_FORBIDDEN"],
    [404, "WEBDAV_NOT_FOUND"],
    [410, "WEBDAV_NOT_FOUND"],
  ];
  for (const [status, code] of cases) {
    const h = harness(() => new Response("nope", { status }));
    assert.equal(await codeOf(h.client.propfind("/", 0)), code);
    assert.equal(h.requests.length, 1, `no retry on ${status}`);
    const g = harness(() => new Response("nope", { status }));
    assert.equal(await codeOf(g.client.get("/a.txt", { maxBytes: 10 })), code);
    assert.equal(g.requests.length, 1);
  }
});

test("a non-207 success, a redirect, a 4xx and a malformed body are bad responses", async () => {
  for (const status of [200, 301, 302, 307, 400, 405, 409, 415]) {
    const h = harness(() => new Response(MULTISTATUS, { status }));
    assert.equal(
      await codeOf(h.client.propfind("/", 0)),
      "WEBDAV_BAD_RESPONSE",
      String(status),
    );
    assert.equal(h.requests.length, 1);
  }
  const html = harness(
    () => new Response("<html>login</html>", { status: 207 }),
  );
  assert.equal(
    await codeOf(html.client.propfind("/", 0)),
    "WEBDAV_BAD_RESPONSE",
  );
});

test("never follows a redirect itself: a surfaced 3xx makes exactly one request", async () => {
  const h = harness(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.org/steal" },
      }),
  );
  assert.equal(await codeOf(h.client.propfind("/", 0)), "WEBDAV_BAD_RESPONSE");
  assert.equal(h.requests.length, 1);
  assert.equal(
    h.requests[0]!.url.startsWith("https://cloud.example.com/"),
    true,
  );
});

test("ENDPOINT_NOT_ALLOWED from the injected fetch maps to WEBDAV_BLOCKED_ENDPOINT, never retried", async () => {
  for (const make of [
    () =>
      Object.assign(new Error("blocked: https://evil/"), {
        code: "ENDPOINT_NOT_ALLOWED",
      }),
    () => new Error("wrapped", { cause: { code: "ENDPOINT_NOT_ALLOWED" } }),
  ]) {
    const h = harness(() => {
      throw make();
    });
    assert.equal(
      await codeOf(h.client.propfind("/", 0)),
      "WEBDAV_BLOCKED_ENDPOINT",
    );
    assert.equal(h.requests.length, 1);
    const g = harness(() => {
      throw make();
    });
    assert.equal(
      await codeOf(g.client.get("/a", { maxBytes: 1 })),
      "WEBDAV_BLOCKED_ENDPOINT",
    );
    assert.equal(g.requests.length, 1);
  }
});

test("retries 502, 503, 504 and 429 at most twice, then reports unreachable", async () => {
  for (const status of [502, 503, 504, 429]) {
    const h = harness(() => new Response("busy", { status }));
    assert.equal(
      await codeOf(h.client.propfind("/", 0)),
      "WEBDAV_UNREACHABLE",
      String(status),
    );
    assert.equal(h.requests.length, 3, `3 attempts for ${status}`);
    assert.equal(h.sleeps.length, 2);
  }
});

test("a retry that succeeds returns the result", async () => {
  const h = harness((_u, _i, attempt) =>
    attempt < 3 ? new Response("busy", { status: 503 }) : multistatus(),
  );
  const entries = await h.client.propfind("/", 1);
  assert.equal(entries.length, 2);
  assert.equal(h.requests.length, 3);
});

test("retries network errors, then reports unreachable", async () => {
  const h = harness((_u, _i, attempt) => {
    if (attempt < 2) throw networkError();
    return multistatus();
  });
  assert.equal((await h.client.propfind("/", 0)).length, 2);
  assert.equal(h.requests.length, 2);

  const dead = harness(() => {
    throw networkError();
  });
  assert.equal(
    await codeOf(dead.client.propfind("/", 0)),
    "WEBDAV_UNREACHABLE",
  );
  assert.equal(dead.requests.length, 3);
});

test("Retry-After is honoured (seconds and HTTP date) and capped at 10 seconds", async () => {
  const seconds = harness((_u, _i, attempt) =>
    attempt === 1
      ? new Response("", { status: 429, headers: { "retry-after": "2" } })
      : multistatus(),
  );
  await seconds.client.propfind("/", 0);
  assert.deepEqual(seconds.sleeps, [2000]);

  const huge = harness((_u, _i, attempt) =>
    attempt === 1
      ? new Response("", { status: 503, headers: { "retry-after": "3600" } })
      : multistatus(),
  );
  await huge.client.propfind("/", 0);
  assert.deepEqual(huge.sleeps, [10_000]);

  const date = harness((_u, _i, attempt) =>
    attempt === 1
      ? new Response("", {
          status: 503,
          headers: { "retry-after": "Tue, 24 Nov 2026 12:00:05 GMT" },
        })
      : multistatus(),
  );
  await date.client.propfind("/", 0);
  assert.deepEqual(date.sleeps, [5000]);

  const junk = harness((_u, _i, attempt) =>
    attempt === 1
      ? new Response("", { status: 503, headers: { "retry-after": "soon" } })
      : multistatus(),
  );
  await junk.client.propfind("/", 0);
  assert.equal(junk.sleeps.length, 1);
  assert.ok(junk.sleeps[0]! > 0 && junk.sleeps[0]! <= 10_000);
});

test("a request timeout is not retried and reports unreachable", async () => {
  const h = harness(
    (_u, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
    { requestTimeoutMs: 20 },
  );
  assert.equal(await codeOf(h.client.propfind("/", 0)), "WEBDAV_UNREACHABLE");
  assert.equal(h.requests.length, 1);
});

test("a fetch that ignores the abort signal still times out", async () => {
  const h = harness(() => new Promise<Response>(() => undefined), {
    requestTimeoutMs: 20,
  });
  assert.equal(await codeOf(h.client.propfind("/", 0)), "WEBDAV_UNREACHABLE");
});

test("a multistatus over the size cap is cut off while reading", async () => {
  let cancelled = false;
  let pulled = 0;
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const h = harness(() => new Response(stream, { status: 207 }));
  assert.equal(await codeOf(h.client.propfind("/", 1)), "WEBDAV_BAD_RESPONSE");
  assert.equal(cancelled, true);
  assert.ok(pulled <= Math.ceil(MAX_MULTISTATUS_BYTES / chunk.byteLength) + 2);
});

test("a declared Content-Length over the cap is refused before reading", async () => {
  const h = harness(
    () =>
      new Response("<x/>", {
        status: 207,
        headers: { "content-length": String(MAX_MULTISTATUS_BYTES + 1) },
      }),
  );
  assert.equal(await codeOf(h.client.propfind("/", 1)), "WEBDAV_BAD_RESPONSE");
});

test("get returns the bytes with etag, last-modified and content type", async () => {
  const h = harness(
    () =>
      new Response("hello", {
        status: 200,
        headers: {
          etag: '"abc"',
          "last-modified": "Sun, 22 Nov 2026 08:30:15 GMT",
          "content-type": "text/plain",
        },
      }),
  );
  const file = await h.client.get("/Docs/a b.txt", { maxBytes: 100 });
  assert.equal(new TextDecoder().decode(file.body), "hello");
  assert.equal(file.etag, '"abc"');
  assert.equal(file.lastModified?.toISOString(), "2026-11-22T08:30:15.000Z");
  assert.equal(file.contentType, "text/plain");
  assert.equal(
    h.requests[0]!.url,
    "https://cloud.example.com/remote.php/dav/files/alice/Docs/a%20b.txt",
  );
  assert.equal(h.requests[0]!.init.method, "GET");
  assert.equal(
    new Headers(h.requests[0]!.init.headers)
      .get("authorization")
      ?.startsWith("Basic "),
    true,
  );
  // A GET asks for no transfer coding so the ETag is not weakened/suffixed.
  assert.equal(
    new Headers(h.requests[0]!.init.headers).get("accept-encoding"),
    "identity",
  );
});

test("get enforces the byte cap by declared length and while streaming", async () => {
  const declared = harness(
    () =>
      new Response("x", { status: 200, headers: { "content-length": "1000" } }),
  );
  assert.equal(
    await codeOf(declared.client.get("/a", { maxBytes: 10 })),
    "WEBDAV_TOO_LARGE",
  );

  let cancelled = false;
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(4));
    },
    cancel() {
      cancelled = true;
    },
  });
  const streaming = harness(() => new Response(stream, { status: 200 }));
  assert.equal(
    await codeOf(streaming.client.get("/a", { maxBytes: 10 })),
    "WEBDAV_TOO_LARGE",
  );
  assert.equal(cancelled, true);
  assert.ok(pulled <= 5);
});

test("get passes the caller's abort signal through", async () => {
  const controller = new AbortController();
  const h = harness(
    (_u, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
  const pending = h.client.get("/a", {
    maxBytes: 10,
    signal: controller.signal,
  });
  controller.abort();
  assert.equal(await codeOf(pending), "WEBDAV_UNREACHABLE");
  assert.equal(h.requests.length, 1);
});

test("a path that escapes the endpoint is rejected before any request", async () => {
  const h = harness(() => multistatus());
  assert.equal(
    await codeOf(h.client.propfind("/a/../../x", 0)),
    "WEBDAV_PATH_INVALID",
  );
  assert.equal(h.requests.length, 0);
});

test("options reports the DAV compliance header", async () => {
  const h = harness(
    () =>
      new Response(null, {
        status: 200,
        headers: { dav: "1, 2", allow: "OPTIONS, GET, PROPFIND" },
      }),
  );
  const info = await h.client.options();
  assert.equal(info.dav, "1, 2");
  assert.equal(h.requests[0]!.init.method, "OPTIONS");
});
