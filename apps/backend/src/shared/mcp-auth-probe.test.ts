import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { probeMcpEndpointAuth } from "./mcp-auth-probe";

const ENDPOINT = "https://mcp.example.com/mcp";

function answering(response: Response) {
  return vi.fn(async () => response) as unknown as typeof globalThis.fetch &
    ReturnType<typeof vi.fn>;
}

test("a 401 naming protected-resource metadata is an OAuth challenge", async () => {
  const fetch = answering(
    new Response(null, {
      status: 401,
      headers: {
        "www-authenticate":
          'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      },
    }),
  );
  assert.equal(await probeMcpEndpointAuth(ENDPOINT, fetch), "oauth");
});

test("a 401 without protected-resource metadata asks for some credential", async () => {
  assert.equal(
    await probeMcpEndpointAuth(
      ENDPOINT,
      routing(
        new Response(null, {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="api"' },
        }),
      ),
    ),
    "credential",
  );
  assert.equal(
    await probeMcpEndpointAuth(
      ENDPOINT,
      routing(new Response(null, { status: 401 })),
    ),
    "credential",
  );
});

/** The endpoint answers `initialize` with `challenge`; other URLs by `routes`. */
function routing(
  challenge: Response,
  routes: Record<string, () => Response | Promise<Response>> = {},
) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === ENDPOINT) return challenge;
    const route = routes[url];
    return route ? route() : new Response(null, { status: 404 });
  }) as unknown as typeof globalThis.fetch & ReturnType<typeof vi.fn>;
}

const PATH_METADATA =
  "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const ROOT_METADATA =
  "https://mcp.example.com/.well-known/oauth-protected-resource";

function metadata(body: unknown) {
  return () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

test("a bare 401 with path-specific protected-resource metadata is OAuth", async () => {
  const fetch = routing(new Response(null, { status: 401 }), {
    [PATH_METADATA]: metadata({
      resource: ENDPOINT,
      authorization_servers: ["https://auth.example.com"],
    }),
  });
  assert.equal(await probeMcpEndpointAuth(ENDPOINT, fetch), "oauth");
  assert.deepEqual(
    fetch.mock.calls.map(([url]) => url),
    [ENDPOINT, PATH_METADATA],
  );
  const [, init] = fetch.mock.calls[1]!;
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "manual");
  assert.equal("authorization" in init.headers, false);
});

test("a bare 401 falls back to the origin's protected-resource metadata", async () => {
  const fetch = routing(new Response(null, { status: 401 }), {
    [ROOT_METADATA]: metadata({
      authorization_servers: ["https://auth.example.com"],
    }),
  });
  assert.equal(await probeMcpEndpointAuth(ENDPOINT, fetch), "oauth");
  assert.deepEqual(
    fetch.mock.calls.map(([url]) => url),
    [ENDPOINT, PATH_METADATA, ROOT_METADATA],
  );
});

test("an endpoint at the origin root looks up one metadata location", async () => {
  const root = "https://mcp.example.com/?key=secret";
  const fetch = vi.fn(async (input: unknown) =>
    String(input) === root
      ? new Response(null, { status: 401 })
      : new Response(null, { status: 404 }),
  ) as unknown as typeof globalThis.fetch & ReturnType<typeof vi.fn>;
  assert.equal(await probeMcpEndpointAuth(root, fetch), "credential");
  assert.deepEqual(
    fetch.mock.calls.map(([url]) => url),
    [root, ROOT_METADATA],
  );
});

test("metadata naming no authorization server leaves a bare 401 a credential", async () => {
  for (const body of [
    { resource: ENDPOINT },
    { authorization_servers: [] },
    { authorization_servers: "https://auth.example.com" },
    null,
  ]) {
    assert.equal(
      await probeMcpEndpointAuth(
        ENDPOINT,
        routing(new Response(null, { status: 401 }), {
          [PATH_METADATA]: metadata(body),
          [ROOT_METADATA]: metadata(body),
        }),
      ),
      "credential",
      JSON.stringify(body),
    );
  }
  assert.equal(
    await probeMcpEndpointAuth(
      ENDPOINT,
      routing(new Response(null, { status: 401 }), {
        [PATH_METADATA]: () => new Response("<html>", { status: 200 }),
        [ROOT_METADATA]: () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://auth.example.com/metadata" },
          }),
      }),
    ),
    "credential",
  );
});

test("a failed metadata lookup leaves a bare 401 a credential, not an error", async () => {
  const fetch = routing(new Response(null, { status: 401 }), {
    [PATH_METADATA]: () => {
      throw new TypeError("fetch failed");
    },
    [ROOT_METADATA]: () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.equal(await probeMcpEndpointAuth(ENDPOINT, fetch), "credential");
  assert.equal(fetch.mock.calls.length, 3);
});

test("the metadata lookup shares the probe's time budget", async () => {
  vi.useFakeTimers();
  try {
    const fetch = vi.fn(async (input: unknown, init: RequestInit) =>
      String(input) === ENDPOINT
        ? new Response(null, { status: 401 })
        : new Promise<Response>((_, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
    ) as unknown as typeof globalThis.fetch & ReturnType<typeof vi.fn>;
    const probe = probeMcpEndpointAuth(ENDPOINT, fetch);
    await vi.advanceTimersByTimeAsync(5000);
    assert.equal(await probe, "credential");
    // The root location is not tried once the budget is spent.
    assert.equal(fetch.mock.calls.length, 2);
  } finally {
    vi.useRealTimers();
  }
});

test("a challenge naming its metadata needs no well-known lookup", async () => {
  const fetch = routing(
    new Response(null, {
      status: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${PATH_METADATA}"`,
      },
    }),
  );
  assert.equal(await probeMcpEndpointAuth(ENDPOINT, fetch), "oauth");
  assert.equal(fetch.mock.calls.length, 1);
});

test("anything but a 401 is open", async () => {
  for (const status of [200, 307, 403, 404, 500]) {
    assert.equal(
      await probeMcpEndpointAuth(
        ENDPOINT,
        answering(new Response(null, { status })),
      ),
      "open",
      `status ${status}`,
    );
  }
});

test("the probe is one unauthenticated initialize that does not follow redirects", async () => {
  const fetch = answering(new Response(null, { status: 200 }));
  await probeMcpEndpointAuth(ENDPOINT, fetch);
  assert.equal(fetch.mock.calls.length, 1);
  const [url, init] = fetch.mock.calls[0]!;
  assert.equal(url, ENDPOINT);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");
  assert.equal("authorization" in init.headers, false);
  assert.equal(JSON.parse(init.body).method, "initialize");
});

test("network failures are thrown to the caller", async () => {
  const fetch = vi.fn(async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;
  await assert.rejects(
    () => probeMcpEndpointAuth(ENDPOINT, fetch),
    /fetch failed/,
  );
});
