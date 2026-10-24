import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { MCP_PROBE_LIMITS, probeMcpEndpointAuth } from "./mcp-auth-probe";

const ENDPOINT = "https://mcp.example.com/mcp";
const SERVER_CARD = "https://mcp.example.com/.well-known/mcp/server-card.json";

type Fetch = typeof globalThis.fetch & ReturnType<typeof vi.fn>;

function answering(response: Response) {
  return vi.fn(async () => response) as unknown as Fetch;
}

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** The requests made to the endpoint itself, parsed. */
function endpointRequests(fetch: Fetch) {
  return fetch.mock.calls
    .filter(([url]) => String(url) === ENDPOINT)
    .map(([, init]) => {
      const request = init as RequestInit & { headers: Record<string, string> };
      return {
        method: request.method,
        headers: request.headers,
        body: request.body ? JSON.parse(String(request.body)) : undefined,
      };
    });
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
  assert.equal((await probeMcpEndpointAuth(ENDPOINT, fetch)).result, "oauth");
});

test("a 401 without protected-resource metadata asks for some credential", async () => {
  assert.equal(
    (
      await probeMcpEndpointAuth(
        ENDPOINT,
        routing(
          new Response(null, {
            status: 401,
            headers: { "www-authenticate": 'Bearer realm="api"' },
          }),
        ),
      )
    ).result,
    "credential",
  );
  assert.deepEqual(
    await probeMcpEndpointAuth(
      ENDPOINT,
      routing(new Response(null, { status: 401 })),
    ),
    { result: "credential" },
  );
});

/** The endpoint answers `initialize` with `challenge`; other URLs by `routes`. */
function routing(
  challenge: Response | ((init: RequestInit) => Response | Promise<Response>),
  routes: Record<string, () => Response | Promise<Response>> = {},
) {
  return vi.fn(async (input: unknown, init: RequestInit) => {
    const url = String(input);
    if (url === ENDPOINT) {
      return typeof challenge === "function" ? challenge(init) : challenge;
    }
    const route = routes[url];
    return route ? route() : new Response(null, { status: 404 });
  }) as unknown as Fetch;
}

const PATH_METADATA =
  "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const ROOT_METADATA =
  "https://mcp.example.com/.well-known/oauth-protected-resource";

function metadata(body: unknown) {
  return () => json(body);
}

test("a bare 401 with path-specific protected-resource metadata is OAuth", async () => {
  const fetch = routing(new Response(null, { status: 401 }), {
    [PATH_METADATA]: metadata({
      resource: ENDPOINT,
      authorization_servers: ["https://auth.example.com"],
    }),
  });
  assert.equal((await probeMcpEndpointAuth(ENDPOINT, fetch)).result, "oauth");
  assert.deepEqual(
    fetch.mock.calls.map(([url]) => url),
    [ENDPOINT, PATH_METADATA, SERVER_CARD],
  );
  const [, init] = fetch.mock.calls[1]!;
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "manual");
  assert.equal("authorization" in init.headers, false);
});

test("oversized protected-resource metadata is not read", async () => {
  const padding = "x".repeat(70 * 1024);
  const fetch = routing(new Response(null, { status: 401 }), {
    [PATH_METADATA]: metadata({
      authorization_servers: ["https://auth.example.com"],
      padding,
    }),
  });
  assert.equal(
    (await probeMcpEndpointAuth(ENDPOINT, fetch)).result,
    "credential",
  );
});

test("a bare 401 falls back to the origin's protected-resource metadata", async () => {
  const fetch = routing(new Response(null, { status: 401 }), {
    [ROOT_METADATA]: metadata({
      authorization_servers: ["https://auth.example.com"],
    }),
  });
  assert.equal((await probeMcpEndpointAuth(ENDPOINT, fetch)).result, "oauth");
  assert.deepEqual(
    fetch.mock.calls.map(([url]) => url),
    [ENDPOINT, PATH_METADATA, ROOT_METADATA, SERVER_CARD],
  );
});

test("an endpoint at the origin root looks up one metadata location", async () => {
  const root = "https://mcp.example.com/?key=secret";
  const fetch = vi.fn(async (input: unknown) =>
    String(input) === root
      ? new Response(null, { status: 401 })
      : new Response(null, { status: 404 }),
  ) as unknown as Fetch;
  assert.equal((await probeMcpEndpointAuth(root, fetch)).result, "credential");
  assert.deepEqual(
    fetch.mock.calls.map(([url]) => url),
    [root, ROOT_METADATA, SERVER_CARD],
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
      (
        await probeMcpEndpointAuth(
          ENDPOINT,
          routing(new Response(null, { status: 401 }), {
            [PATH_METADATA]: metadata(body),
            [ROOT_METADATA]: metadata(body),
          }),
        )
      ).result,
      "credential",
      JSON.stringify(body),
    );
  }
  assert.equal(
    (
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
      )
    ).result,
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
  assert.equal(
    (await probeMcpEndpointAuth(ENDPOINT, fetch)).result,
    "credential",
  );
  assert.deepEqual(
    fetch.mock.calls.map(([url]) => url),
    [ENDPOINT, PATH_METADATA, ROOT_METADATA, SERVER_CARD],
  );
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
    ) as unknown as Fetch;
    const probe = probeMcpEndpointAuth(ENDPOINT, fetch);
    await vi.advanceTimersByTimeAsync(5000);
    assert.deepEqual(await probe, { result: "credential" });
    // Neither the root location nor the server card is tried once the budget
    // is spent.
    assert.equal(fetch.mock.calls.length, 2);
  } finally {
    vi.useRealTimers();
  }
});

test("a challenge naming its metadata reads that location, not the well-known ones", async () => {
  const fetch = routing(
    new Response(null, {
      status: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${PATH_METADATA}"`,
      },
    }),
    {
      [PATH_METADATA]: metadata({
        resource: ENDPOINT,
        authorization_servers: ["https://auth.example.com"],
        resource_name: "Example MCP",
        resource_documentation: "https://docs.example.com/mcp",
      }),
    },
  );
  assert.deepEqual(await probeMcpEndpointAuth(ENDPOINT, fetch), {
    result: "oauth",
    authMetadata: {
      resourceName: "Example MCP",
      resourceDocumentation: "https://docs.example.com/mcp",
    },
  });
  assert.deepEqual(
    fetch.mock.calls.map(([url]) => url),
    [ENDPOINT, PATH_METADATA, SERVER_CARD],
  );
});

test("a challenge naming metadata on another origin stays OAuth, read from the well-known location", async () => {
  const fetch = routing(
    new Response(null, {
      status: 401,
      headers: {
        "www-authenticate":
          'Bearer resource_metadata="https://elsewhere.example/.well-known/oauth-protected-resource"',
      },
    }),
    { [ROOT_METADATA]: metadata({ resource_name: "Example" }) },
  );
  assert.deepEqual(await probeMcpEndpointAuth(ENDPOINT, fetch), {
    result: "oauth",
    authMetadata: { resourceName: "Example" },
  });
  assert.equal(
    fetch.mock.calls.some(([url]) =>
      String(url).startsWith("https://elsewhere.example/"),
    ),
    false,
  );
});

test("issue #367: a 401's metadata keeps its human fields, bounded and https only", async () => {
  const fetch = routing(new Response(null, { status: 401 }), {
    [PATH_METADATA]: metadata({
      authorization_servers: ["https://auth.example.com"],
      resource_name: ` ${"n".repeat(600)} `,
      resource_documentation: "http://docs.example.com/mcp",
    }),
  });
  const probe = await probeMcpEndpointAuth(ENDPOINT, fetch);
  assert.equal(probe.result, "oauth");
  assert.deepEqual(probe.authMetadata, {
    resourceName: "n".repeat(MCP_PROBE_LIMITS.stringChars),
  });
  // The documentation URL is a link for the page: it is never fetched.
  assert.equal(
    fetch.mock.calls.some(([url]) => String(url).includes("docs.example.com")),
    false,
  );

  const bare = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(new Response(null, { status: 401 }), {
      [PATH_METADATA]: metadata({
        authorization_servers: ["https://auth.example.com"],
      }),
    }),
  );
  assert.deepEqual(bare, { result: "oauth" });
});

test("anything but a 401 is open", async () => {
  for (const status of [200, 307, 403, 404, 500]) {
    assert.deepEqual(
      await probeMcpEndpointAuth(
        ENDPOINT,
        answering(new Response(null, { status })),
      ),
      { result: "open" },
      `status ${status}`,
    );
  }
});

test("the probe is one unauthenticated initialize that does not follow redirects", async () => {
  const fetch = answering(new Response(null, { status: 200 }));
  await probeMcpEndpointAuth(ENDPOINT, fetch);
  // An endpoint that said nothing is asked nothing more; only the origin's
  // server card is looked up.
  assert.deepEqual(
    fetch.mock.calls.map(([url]) => url),
    [ENDPOINT, SERVER_CARD],
  );
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

// ---------------------------------------------------------------------------
// Issue #367 W1: an open endpoint's self-description.
// ---------------------------------------------------------------------------

const INITIALIZE_RESULT = {
  protocolVersion: "2025-03-26",
  capabilities: { tools: { listChanged: true }, prompts: {} },
  serverInfo: {
    name: "example-mcp",
    title: "Example MCP",
    version: "2.1.0",
    description: "Example's own MCP server.",
    websiteUrl: "https://example.com/",
    icons: [{ src: "https://example.com/icon.png", mimeType: "image/png" }],
  },
  instructions: "Call `search` before `fetch`.",
};

type Message = { id?: number; method?: string };

/**
 * An open MCP server: answers `initialize` with `INITIALIZE_RESULT` (or
 * `initialize`), as a `frame`d response; anything else is an error.
 */
function openServer(options: {
  frame?: (body: unknown) => Response;
  initialize?: unknown;
}) {
  const frame = options.frame ?? ((body: unknown) => json(body));
  return (init: RequestInit) => {
    const message = JSON.parse(String(init.body)) as Message;
    if (message.id === undefined) return new Response(null, { status: 202 });
    return message.method === "initialize"
      ? frame({
          jsonrpc: "2.0",
          id: message.id,
          result: options.initialize ?? INITIALIZE_RESULT,
        })
      : json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
  };
}

test("an open endpoint's initialize answer is kept; its tools are the listing's to read", async () => {
  const fetch = routing(openServer({}));
  const probe = await probeMcpEndpointAuth(ENDPOINT, fetch);
  assert.deepEqual(probe, {
    result: "open",
    selfDescription: {
      serverInfo: INITIALIZE_RESULT.serverInfo,
      instructions: INITIALIZE_RESULT.instructions,
      capabilities: INITIALIZE_RESULT.capabilities,
    },
  });
  // One unauthenticated initialize; no tools/list here (the tool listing
  // module does that with a full client handshake).
  const requests = endpointRequests(fetch);
  assert.deepEqual(
    requests.map((request) => [request.method, request.body?.method]),
    [["POST", "initialize"]],
  );
  assert.equal("authorization" in requests[0]!.headers, false);
  assert.equal(
    requests[0]!.body.params.clientInfo.name,
    "sourceweft-auth-probe",
  );
  assert.equal(requests[0]!.body.params.protocolVersion, "2025-06-18");
});

test("an open endpoint answering with an error, HTML or nothing keeps no description", async () => {
  for (const response of [
    json({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32001, message: "Unauthorized" },
    }),
    new Response("<html>Sign in</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
    json({ jsonrpc: "2.0", id: 99, result: INITIALIZE_RESULT }),
    json({ ok: true }),
  ]) {
    const fetch = routing(response);
    assert.deepEqual(await probeMcpEndpointAuth(ENDPOINT, fetch), {
      result: "open",
    });
    assert.equal(endpointRequests(fetch).length, 1);
  }
});

test("an oversized initialize answer is dropped, not stored in part", async () => {
  const huge = { ...INITIALIZE_RESULT, instructions: "x".repeat(300 * 1024) };
  assert.deepEqual(
    await probeMcpEndpointAuth(
      ENDPOINT,
      routing(openServer({ initialize: huge })),
    ),
    { result: "open" },
  );
});

test("SSE-framed answers are read, and the stream is not waited on", async () => {
  // A Streamable HTTP server answering over SSE, keeping the stream open after
  // its response the way one does.
  const frame = (body: unknown) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
        controller.enqueue(
          encoder.encode(
            `event: message\r\nid: 7\r\ndata: ${JSON.stringify(body)}\r\n\r\n`,
          ),
        );
        // Never closed.
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const probe = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(openServer({ frame })),
  );
  assert.equal(probe.selfDescription?.serverInfo?.name, "example-mcp");
  assert.deepEqual(
    probe.selfDescription?.capabilities,
    INITIALIZE_RESULT.capabilities,
  );
});

test("an SSE answer split across chunks, with events before it, is read once complete", async () => {
  const frame = (body: unknown) => {
    const encoder = new TextEncoder();
    const text = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
    const chunks = [
      ": hello\n\n",
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n',
      text.slice(0, 20),
      text.slice(20, 60),
      text.slice(60),
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        // Left open.
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const probe = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(openServer({ frame })),
  );
  assert.equal(probe.selfDescription?.serverInfo?.name, "example-mcp");
});

test("self-description is kept within the contract's bounds", async () => {
  const fetch = routing(
    openServer({
      initialize: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: {
          name: "n".repeat(600),
          title: "t".repeat(600),
          version: "1",
          description: "d".repeat(600),
          websiteUrl: "http://example.com",
          icons: [
            { src: "https://example.com/1.png" },
            { src: "http://example.com/2.png" },
            { src: "not a url" },
            "https://example.com/string.png",
            { src: "https://example.com/3.png", sizes: ["48x48"] },
            { src: "https://example.com/4.png" },
            { src: "https://example.com/5.png" },
            { src: "https://example.com/6.png" },
            { src: "https://example.com/7.png" },
          ],
        },
        instructions: "漢".repeat(5000),
      },
    }),
  );
  const probe = await probeMcpEndpointAuth(ENDPOINT, fetch);
  const info = probe.selfDescription?.serverInfo;
  assert.ok(info);
  assert.equal(info.name.length, MCP_PROBE_LIMITS.stringChars);
  assert.equal(info.title?.length, MCP_PROBE_LIMITS.stringChars);
  assert.equal(info.description?.length, MCP_PROBE_LIMITS.stringChars);
  assert.equal(info.websiteUrl, undefined);
  assert.deepEqual(info.icons, [
    { src: "https://example.com/1.png" },
    { src: "https://example.com/3.png", sizes: ["48x48"] },
    { src: "https://example.com/4.png" },
    { src: "https://example.com/5.png" },
    { src: "https://example.com/6.png" },
  ]);
  const instructions = probe.selfDescription?.instructions ?? "";
  assert.ok(
    Buffer.byteLength(instructions, "utf8") <=
      MCP_PROBE_LIMITS.instructionsBytes,
  );
  assert.ok(Buffer.byteLength(instructions, "utf8") > 8000);
});

test("oversized capabilities are dropped; the rest of the description is kept", async () => {
  const probe = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(
      openServer({
        initialize: {
          ...INITIALIZE_RESULT,
          capabilities: { experimental: { pad: "x".repeat(5 * 1024) } },
        },
      }),
    ),
  );
  assert.equal(probe.selfDescription?.serverInfo?.name, "example-mcp");
  assert.equal("capabilities" in (probe.selfDescription ?? {}), false);
});

test("URLs with credentials in them, or too long, are dropped", async () => {
  const long = `https://example.com/${"p".repeat(2100)}`;
  const probe = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(
      openServer({
        initialize: {
          ...INITIALIZE_RESULT,
          serverInfo: {
            name: "x",
            websiteUrl: "https://user:secret@example.com/",
            icons: [
              { src: "https://user:secret@example.com/icon.png" },
              { src: long },
              { src: "https://example.com/ok.png" },
            ],
          },
        },
      }),
    ),
  );
  assert.deepEqual(probe.selfDescription?.serverInfo, {
    name: "x",
    icons: [{ src: "https://example.com/ok.png" }],
  });
  const challenged = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(new Response(null, { status: 401 }), {
      [PATH_METADATA]: metadata({
        authorization_servers: ["https://auth.example.com"],
        resource_documentation: "https://user:secret@docs.example.com/mcp",
      }),
    }),
  );
  assert.deepEqual(challenged, { result: "oauth" });
});

test("the origin's server card is kept as published when it serves one", async () => {
  const card = {
    serverInfo: { name: "example-mcp", version: "2.1.0" },
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
  };
  const probe = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(openServer({}), { [SERVER_CARD]: () => json(card) }),
  );
  assert.deepEqual(probe.serverCard, card);

  // A 401 endpoint's card is kept too.
  const challenged = await probeMcpEndpointAuth(
    ENDPOINT,
    routing(new Response(null, { status: 401 }), {
      [SERVER_CARD]: () => json(card),
    }),
  );
  assert.deepEqual(challenged, { result: "credential", serverCard: card });
});

test("no server card, a non-JSON one, an empty one or one too large is left out", async () => {
  for (const route of [
    undefined,
    () => new Response("<html>", { status: 200 }),
    () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    () => json({}),
    () => json([1, 2]),
    () => json({ pad: "x".repeat(70 * 1024) }),
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/card.json" },
      }),
    () => {
      throw new TypeError("fetch failed");
    },
  ]) {
    const probe = await probeMcpEndpointAuth(
      ENDPOINT,
      routing(openServer({}), route ? { [SERVER_CARD]: route } : {}),
    );
    assert.equal("serverCard" in probe, false);
    assert.ok(probe.selfDescription);
  }
});
