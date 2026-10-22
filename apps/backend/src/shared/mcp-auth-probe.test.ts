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
      answering(
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
      answering(new Response(null, { status: 401 })),
    ),
    "credential",
  );
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
